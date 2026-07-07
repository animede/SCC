/* SCC mockdata — フェーズ1シミュレータ
   軌道計算(orbit.js)と整合するテレメトリ・アンテナ挙動・通信イベントを生成する。
   フェーズ2ではこのファイルを WebSocket クライアントに差し替える(公開APIは SCC.ops のみ)。

   フェーズ3(観測ベースOD): 「物理的現実(衛星の実位置・電波)」と「地上の知識(予測軌道・
   スケジュール)」を明示的に分離する。
     - trueOrbit: 真の軌道。PROP_BURN の実行誤差込みの実際の状態を保持。メインループの
       propagate、stepAntenna の自動追尾ターゲット/リンク品質、stepTelemetry の食判定、
       checkPassEdges の可視判定、観測(レンジ/Az/El)生成に使う。
     - SCC.orbit: 地上が知っている予測軌道。recalcPasses/recalcTrack/orbitNo/ALT/PERIOD
       など、従来どおり画面表示・スケジューリングに使う。PROP_BURN 直後は「コマンド通りの
       Δv」を適用した即時近似、OD収束後は観測フィットで真の軌道へ補正される。 */
(function () {
  "use strict";

  const S = SCC.state, bus = SCC.bus, orbit = SCC.orbit;
  const trueOrbit = SCC.createOrbit();   // 真の軌道 (地上からは直接観測できない「実際」)
  const LAUNCH = Date.UTC(2025, 10, 15, 2, 30, 0);   // 打上げ (MET基準)
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

  /* Box-Muller: 標準正規乱数 (平均0, 分散1) */
  function gaussRand() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const gauss = (sigma) => gaussRand() * sigma;

  let cmdSeq = 1;
  let lastPassCalc = 0;      // パス一覧を計算した simTime [ms]
  let lastTrackCalc = 0;     // 地上軌跡を計算した simTime [ms]
  const visible = {};        // 局ID → 可視状態 (AOS/LOSエッジ検出用)
  const latched = {};        // アラームID → ラッチ中フラグ
  const lastObsMs = {};      // 局ID → 前回OD観測を生成した simTime [ms]
  const OBS_INTERVAL_S = 5;  // OD観測生成間隔 (シミュレーション秒)

  /* ---------- ログ ---------- */
  function log(level, source, msg) {
    const e = { t: new Date(S.simTime), level, source, msg };
    S.history.unshift(e);
    if (S.history.length > 500) S.history.length = 500;
    bus.emit("log", e);
  }

  /* ---------- パス・軌跡の再計算 ---------- */
  function recalcPasses() {
    const from = new Date(S.simTime);
    let all = [];
    for (const st of S.stations) all = all.concat(orbit.predictPasses(st, from, 24));
    all.sort((a, b) => a.aos - b.aos);
    S.passes = all;
    lastPassCalc = S.simTime.getTime();
    recalcContact();
  }

  /* 統合コンタクトウィンドウ: 重なり合うパスをマージ (5s以内の隙間はハンドオーバー扱い) */
  const HANDOVER_TOL = 5000;
  function recalcContact() {
    const wins = [];
    for (const p of S.passes) {
      const a = p.aos.getTime(), b = p.los.getTime();
      const last = wins[wins.length - 1];
      if (last && a <= last.endMs + HANDOVER_TOL) {
        if (b > last.endMs) last.endMs = b;
        if (!last.stations.includes(p.station)) last.stations.push(p.station);
      } else {
        wins.push({ startMs: a, endMs: b, stations: [p.station] });
      }
    }
    S.contact.windows = wins.map(w => ({ start: new Date(w.startMs), end: new Date(w.endMs), stations: w.stations }));
  }

  /* 連続通信の開始/終了エッジ検出 → ログ */
  let inContact = false;
  function checkContactEdges() {
    const t = S.simTime.getTime();
    const cur = S.contact.windows.find(w => w.start.getTime() <= t && t <= w.end.getTime());
    if (!!cur === inContact) return;
    inContact = !!cur;
    if (cur) {
      const dur = (cur.end.getTime() - cur.start.getTime()) / 1000;
      log("info", "NET", `連続通信開始 — 予定 ${SCC.fmt.duration(dur)} (${cur.stations.map(s => s.replace("GS-", "")).join("→")})`);
    } else {
      const nxt = S.contact.windows.find(w => w.start.getTime() > t);
      log("info", "NET", "連続通信終了" + (nxt ? ` — 次ウィンドウ ${SCC.fmt.hms(nxt.start)} UTC` : ""));
    }
  }

  function recalcTrack() {
    S.groundTrack.past = orbit.groundTrack(S.simTime, -96, 60);
    S.groundTrack.future = orbit.groundTrack(S.simTime, 96, 60);
    lastTrackCalc = S.simTime.getTime();
  }

  function passStatusOf(p) {
    const t = S.simTime.getTime();
    if (t < p.aos.getTime()) return "upcoming";
    if (t > p.los.getTime()) return "done";
    return "active";
  }

  function activePass(stationId) {
    return S.passes.find(p => p.station === stationId && p.status === "active") || null;
  }
  function nextPass(stationId) {
    return S.passes.find(p => p.station === stationId && p.status === "upcoming") || null;
  }

  /* ---------- アンテナ ---------- */
  const SLEW_RATE = 5; // deg/s
  function stepAntenna(st, dt) {
    const a = st.antenna;
    if (a.mode === "MAINT" || a.mode === "STOWED") { a.rssi = NaN; a.snr = NaN; a.lock = false; return; }

    let tgtAz = a.cmdAz, tgtEl = a.cmdEl;
    const act = activePass(st.id);
    if (a.autoTrack) {
      const nxt = nextPass(st.id);
      if (act) {
        const look = trueOrbit.lookAngles(st, S.simTime);   // 自動追尾は電波の実測(真値)を追う
        tgtAz = look.az; tgtEl = Math.max(0, look.el);
      } else if (nxt && nxt.aos.getTime() - S.simTime.getTime() < 180e3) {
        tgtAz = nxt.aosAz; tgtEl = orbit.MIN_EL;      // AOS 3分前: AOS方位へ振り向け
      } else {
        tgtAz = a.az; tgtEl = 90;                     // 待機: 天頂パーク
      }
      a.cmdAz = tgtAz; a.cmdEl = tgtEl;
    }

    // 最短経路スルー (a.hw=true の局は rotctld アダプタが実測 az/el を書き込むため積分しない)
    let dAz = ((tgtAz - a.az + 540) % 360) - 180;
    const dEl = tgtEl - a.el;
    if (!a.hw) {
      const step = SLEW_RATE * dt;
      a.az = (a.az + clamp(dAz, -step, step) + 360) % 360;
      a.el = clamp(a.el + clamp(dEl, -step, step), 0, 90);
      dAz = ((tgtAz - a.az + 540) % 360) - 180;
    }
    const moving = Math.abs(dAz) > 0.8 || Math.abs(tgtEl - a.el) > 0.8;

    const prevMode = a.mode;
    a.mode = act && !moving ? "TRACKING" : moving ? "SLEWING" : "IDLE";
    if (a.mode !== prevMode && (a.mode === "TRACKING" || prevMode === "TRACKING"))
      log("info", st.id, a.mode === "TRACKING" ? "追尾開始 (TRACKING)" : "追尾終了");

    // リンク品質 (電波の閉ループ追尾なので真値=trueOrbit基準)
    if (act) {
      const look = trueOrbit.lookAngles(st, S.simTime);
      const err = Math.hypot(((look.az - a.az + 540) % 360) - 180, look.el - a.el);
      if (look.el > orbit.MIN_EL && err < 2.5) {
        a.rssi = -90 - 20 * Math.log10(look.range / 600) + rnd(-1.5, 1.5);
        a.snr = clamp(30 - 20 * Math.log10(look.range / 600) + rnd(-1, 1), 0, 35);
        a.lock = a.snr > 6;
      } else { a.rssi = NaN; a.snr = NaN; a.lock = false; }
    } else { a.rssi = NaN; a.snr = NaN; a.lock = false; }
  }

  function bandRateMbps(st) {
    if (st.band.includes("X")) return 8;
    if (st.band.includes("S")) return 2;
    return 0.0096;
  }

  /* 現在リンク確立中の局のうち最良のもの */
  function bestLink() {
    let best = null;
    for (const st of S.stations)
      if (st.antenna.lock && (!best || st.antenna.snr > best.antenna.snr)) best = st;
    return best;
  }

  /* ---------- テレメトリ ---------- */
  function stepTelemetry(dt) {
    const tlm = S.sat.telemetry;
    const inEclipse = trueOrbit.eclipsed(S.sat.eci, S.simTime);  // 食は物理的現実(真値)で判定
    const link = bestLink();
    const txOn = !!link;

    // EPS
    const solarTgt = inEclipse ? 0 : 165 + rnd(-6, 6);
    tlm.eps.solarW = approach(tlm.eps.solarW, solarTgt, dt, 15);
    const loadW = 45 + (txOn ? 32 : 0) + (S.swUpdate.state === "INSTALLING" ? 10 : 0) + rnd(-2, 2);
    tlm.eps.soc = clamp(tlm.eps.soc + (tlm.eps.solarW * 0.9 - loadW) * dt / 3600 / 160 * 100, 15, 100);
    tlm.eps.busV = 25.8 + tlm.eps.soc * 0.03 + rnd(-0.04, 0.04);
    tlm.eps.busI = loadW / tlm.eps.busV;

    // TCS
    tlm.tcs.panelT = approach(tlm.tcs.panelT, inEclipse ? -62 : 48, dt, 420);
    tlm.tcs.obcT = approach(tlm.tcs.obcT, 22 + tlm.cdh.cpu * 0.18, dt, 240);
    tlm.tcs.commT = approach(tlm.tcs.commT, txOn ? 34 : 16, dt, 180);
    tlm.tcs.battT = approach(tlm.tcs.battT, inEclipse ? 8 : 16, dt, 600);
    tlm.eps.battT = tlm.tcs.battT;

    // ADCS (太陽指向モード)
    const ou = (v, sigma) => clamp(v * Math.exp(-dt / 60) + rnd(-sigma, sigma) * Math.sqrt(dt), -0.3, 0.3);
    tlm.adcs.rateX = ou(tlm.adcs.rateX, 0.01);
    tlm.adcs.rateY = ou(tlm.adcs.rateY, 0.01);
    tlm.adcs.rateZ = ou(tlm.adcs.rateZ, 0.008);
    tlm.adcs.sunAngle = inEclipse ? NaN : clamp(approach(isFinite(tlm.adcs.sunAngle) ? tlm.adcs.sunAngle : 20, 2, dt, 120) + rnd(-0.3, 0.3), 0, 60);
    // 姿勢クォータニオン: 角速度を積分してゆっくり変化させる (q += 0.5 Ω⊗q, 正規化)
    {
      const q = tlm.adcs.quat, wx = tlm.adcs.rateX * Math.PI / 180, wy = tlm.adcs.rateY * Math.PI / 180, wz = tlm.adcs.rateZ * Math.PI / 180;
      const dq0 = -0.5 * (wx * q[1] + wy * q[2] + wz * q[3]);
      const dq1 =  0.5 * (wx * q[0] + wz * q[2] - wy * q[3]);
      const dq2 =  0.5 * (wy * q[0] - wz * q[1] + wx * q[3]);
      const dq3 =  0.5 * (wz * q[0] + wy * q[1] - wx * q[2]);
      q[0] += dq0 * dt; q[1] += dq1 * dt; q[2] += dq2 * dt; q[3] += dq3 * dt;
      const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
    }

    // CDH
    tlm.cdh.cpu = clamp(tlm.cdh.cpu + rnd(-1.5, 1.5) * Math.sqrt(dt) + (txOn ? 0.2 : -0.1) * dt, 12, 92);
    tlm.cdh.mem = clamp(tlm.cdh.mem + rnd(-0.05, 0.06) * dt, 30, 75);
    tlm.cdh.uptime += dt;

    // COM (衛星側)
    if (link) {
      tlm.com.rssi = link.antenna.rssi + rnd(-2, 2);
      tlm.com.snr = link.antenna.snr;
      tlm.com.agc = clamp(2.5 - (tlm.com.rssi + 90) * 0.05 + rnd(-0.05, 0.05), 0, 5); // AGC電圧 [V]、弱信号ほど高
      tlm.com.mode = S.downlink.rate > 0 ? "TX/RX" : "RX";
    } else {
      tlm.com.rssi = NaN; tlm.com.snr = NaN; tlm.com.bitrate = 0; tlm.com.agc = NaN; tlm.com.mode = "RX";
    }
  }

  /* ---------- アラーム ---------- */
  function checkAlarms() {
    const tlm = S.sat.telemetry;
    const rate = Math.hypot(tlm.adcs.rateX, tlm.adcs.rateY, tlm.adcs.rateZ);
    const checks = [
      { id: "SOC_LOW",   on: tlm.eps.soc < 40,   level: "warn", msg: `バッテリSoC低下 (${tlm.eps.soc.toFixed(0)}%)` },
      { id: "SOC_CRIT",  on: tlm.eps.soc < 25,   level: "crit", msg: "バッテリSoC危険域 (<25%)" },
      { id: "BATT_HOT",  on: tlm.tcs.battT > 35, level: "warn", msg: `バッテリ温度高 (${tlm.tcs.battT.toFixed(1)}°C)` },
      { id: "OBC_HOT",   on: tlm.tcs.obcT > 55,  level: "warn", msg: `OBC温度高 (${tlm.tcs.obcT.toFixed(1)}°C)` },
      { id: "RATE_HIGH", on: rate > 0.25,        level: "warn", msg: `角速度大 (${rate.toFixed(2)}°/s)` },
    ];
    for (const c of checks) {
      if (c.on && !latched[c.id]) {
        latched[c.id] = true;
        S.sat.alarms.push({ id: c.id + "-" + Date.now(), key: c.id, level: c.level, msg: c.msg, t: new Date(S.simTime), ack: false });
        log(c.level, "FDIR", c.msg);
      } else if (!c.on && latched[c.id]) {
        latched[c.id] = false;
        S.sat.alarms = S.sat.alarms.filter(a => !(a.key === c.id && a.ack));
        log("info", "FDIR", c.id + " 解消");
      }
    }
  }

  /* ---------- コマンド ---------- */
  function stepCommands(dt) {
    const t = S.simTime.getTime();
    for (const c of S.commandQueue) {
      const stPass = c.station ? activePass(c.station) : S.passes.find(p => p.status === "active");
      if (c.status === "QUEUED" && stPass) {
        c.status = "SENT"; c._next = t + rnd(1, 3) * 1000; c.sentT = new Date(S.simTime);
        c.station = c.station || stPass.station;
        log("info", "CMD", `${c.name} 送信 (${c.station})`);
        bus.emit("command-sent", { cmd: c });
      } else if (c.status === "SENT" && t >= c._next) {
        if (Math.random() < 0.05) {
          c.status = "FAIL";
          log("serious", "CMD", `${c.name} NACK — 再送要`);
          bus.emit("command-ack", { cmd: c, status: "NACK" });
        } else {
          c.status = "ACK"; c._next = t + rnd(2, 5) * 1000;
          bus.emit("command-ack", { cmd: c, status: "ACK" });
        }
      } else if (c.status === "ACK" && t >= c._next) {
        c.status = "EXEC";
        log("info", "CMD", `${c.name} 実行完了`);
        bus.emit("command-ack", { cmd: c, status: "EXEC" });
        applyCommandEffect(c);
      }
    }
    if (S.commandQueue.length > 100) S.commandQueue = S.commandQueue.slice(-100);
  }

  /* PROP_BURN の方向指定 → RSW系(radial/along/cross)の単位符号 */
  const PROP_DIRS = {
    PRO: { along: 1 }, RETRO: { along: -1 },
    RAD_IN: { radial: -1 }, RAD_OUT: { radial: 1 },
    NORM_POS: { cross: 1 }, NORM_NEG: { cross: -1 },
  };

  function applyCommandEffect(c) {
    const tlm = S.sat.telemetry;
    if (c.name === "OBC_REBOOT") { tlm.cdh.uptime = 0; tlm.cdh.bootCount++; log("warn", "OBC", "再起動完了 — boot #" + tlm.cdh.bootCount); }
    if (c.name === "ADCS_MODE_SUNPOINT") tlm.adcs.mode = "SUNPOINT";
    if (c.name === "ADCS_MODE_NADIR") tlm.adcs.mode = "NADIR";
    if (c.name === "ADCS_DETUMBLE") tlm.adcs.mode = "DETUMBLE";
    if (c.name === "COM_TX_ON") tlm.com.mode = "TX/RX";
    if (c.name === "COM_TX_OFF") tlm.com.mode = "RX";
    if (c.name === "PLD_CAPTURE") {
      const n = `IMG_${SCC.fmt.dateUTC(S.simTime).replace(/-/g, "")}_${SCC.fmt.hms(S.simTime).replace(/:/g, "").slice(0, 4)}.raw`;
      S.downlink.files.push({ name: n, size: rnd(30, 80), pct: 0, state: "PENDING" });
      tlm.cdh.storagePct = clamp(tlm.cdh.storagePct + 2, 0, 100);
      log("info", "PLD", `撮像完了 → ${n}`);
    }
    if (c.name === "PROP_BURN") {
      const [dir, dvStr] = (c.args || "").trim().split(/\s+/);
      const dvMps = parseFloat(dvStr);
      const sign = PROP_DIRS[dir];
      if (!sign || !isFinite(dvMps)) {
        log("serious", "PROP", `PROP_BURN 引数不正 (${c.args || ""}) — 適用スキップ`);
        return;
      }
      const dvKms = dvMps / 1000;
      const dvRswCmd = {
        radial: (sign.radial || 0) * dvKms,
        along: (sign.along || 0) * dvKms,
        cross: (sign.cross || 0) * dvKms,
      };
      const atDate = new Date(S.simTime);

      // ---- 1. 実行誤差込みのΔvを生成 (真の軌道用) ----
      //   大きさ: ×(1+N(0,0.02))、方向: 指定軸から標準偏差0.5°の微小傾き。
      //   指定軸に直交する2軸成分に N(0, dv·sin(0.5°)) を加える簡易実装。
      const magErr = 1 + gauss(0.02);
      const tiltSigma = dvKms * Math.sin(0.5 * Math.PI / 180);
      const axes = ["radial", "along", "cross"];
      const mainAxis = axes.find(ax => dvRswCmd[ax] !== 0);
      const dvRswTrue = { radial: 0, along: 0, cross: 0 };
      for (const ax of axes) dvRswTrue[ax] = dvRswCmd[ax] * magErr;
      for (const ax of axes) {
        if (ax === mainAxis) continue;
        dvRswTrue[ax] += gauss(tiltSigma);
      }

      // ---- 2. 真の軌道を更新 ----
      const okTrue = trueOrbit.applyBurn(dvRswTrue, atDate);
      if (!okTrue) {
        log("serious", "PROP", "PROP_BURN 適用失敗 — 軌道要素異常のため無視");
        return;
      }

      // ---- 3. 地上予測: コマンド通りのΔv(誤差なし)を作業インスタンスに適用し、
      //         その結果を地上表示軌道(SCC.orbit)へ即時反映(受け入れ基準6の前半: 即時整合) ----
      const scratch = SCC.createOrbit();
      scratch.setTLE(orbit.getTLE().line1, orbit.getTLE().line2);
      const okPred = scratch.applyBurn(dvRswCmd, atDate);
      if (okPred) {
        const predTle = scratch.getTLE();
        orbit.setTLE(predTle.line1, predTle.line2);
      }
      recalcPasses(); recalcTrack();
      log("warn", "PROP", `PROP_BURN 実行完了 — Δv=${dvMps}m/s ${dir}, 高度≈${orbit.ALT.toFixed(0)}km 周期≈${(orbit.PERIOD / 60).toFixed(1)}min`);

      // ---- 4. OD開始 (地上予測TLEをpriorとして観測収集へ) ----
      const priorTle = orbit.getTLE();
      SCC.od.reset([priorTle.line1, priorTle.line2], atDate);
      log("info", "OD", "軌道決定開始 — 観測収集中");
    }
  }

  /* ---------- ダウンリンク / SW更新 ---------- */
  function stepDownlink(dt) {
    const link = bestLink();
    const sw = S.swUpdate;
    if (!link) { S.downlink.rate = 0; S.sat.telemetry.com.bitrate = 0; return; }

    const mbps = bandRateMbps(link) * clamp(link.antenna.snr / 25, 0.4, 1);
    S.sat.telemetry.com.bitrate = mbps;

    // SW更新のアップリンクを優先
    if (sw.state === "UPLOADING") {
      S.downlink.rate = 0;
      sw.pct = clamp(sw.pct + mbps / 8 / 24 * 100 * dt, 0, 100);   // イメージ 24MB 想定
      if (sw.pct >= 100) { sw.state = "VERIFYING"; sw.pct = 0; log("info", "SWU", "転送完了 — 検証中"); }
      return;
    }
    if (sw.state === "VERIFYING") {
      sw.pct = clamp(sw.pct + 100 / 12 * dt, 0, 100);
      if (sw.pct >= 100) { sw.state = "READY"; sw.pct = 100; log("info", "SWU", `${sw.available} 検証OK — インストール可能`); }
    }
    if (sw.state === "INSTALLING") {
      sw.pct = clamp(sw.pct + 100 / 30 * dt, 0, 100);
      if (sw.pct >= 100) {
        sw.current = sw.available; sw.state = "IDLE"; sw.pct = 0;
        log("warn", "SWU", `フライトソフトウェア ${sw.current} インストール完了 (再起動済)`);
        S.sat.telemetry.cdh.bootCount++;
      }
    }

    // ファイルダウンリンク
    const f = S.downlink.files.find(x => x.state === "PENDING" || x.state === "RX");
    if (f) {
      f.state = "RX";
      S.downlink.rate = mbps;
      const mb = mbps / 8 * dt;
      f.pct = clamp(f.pct + mb / f.size * 100, 0, 100);
      S.downlink.totalMB += mb;
      if (f.pct >= 100) {
        f.state = "DONE";
        S.sat.telemetry.cdh.storagePct = clamp(S.sat.telemetry.cdh.storagePct - 1.5, 0, 100);
        log("info", "DATA", `${f.name} 受信完了 (${f.size.toFixed(0)}MB, ${link.id})`);
      }
    } else S.downlink.rate = 0;
  }

  /* ---------- AOS/LOS エッジ ---------- */
  function checkPassEdges() {
    for (const st of S.stations) {
      const el = trueOrbit.lookAngles(st, S.simTime).el;   // 可視判定は電波の実際(真値)
      const vis = el > orbit.MIN_EL;
      if (vis !== !!visible[st.id]) {
        visible[st.id] = vis;
        const pass = S.passes.find(p => p.station === st.id && (p.status === "active" || (vis ? p.status === "upcoming" : p.status === "done")));
        log(vis ? "info" : "info", "PASS", vis
          ? `AOS ${st.id} — 最大仰角 ${pass ? pass.maxEl.toFixed(0) : "?"}°`
          : `LOS ${st.id}`);
        bus.emit("pass-change", { type: vis ? "AOS" : "LOS", station: st.id, pass });
      }
    }
  }

  /* ---------- OD観測生成 ----------
     ODが観測収集中(COLLECTING)のとき、可視中(lock)の局から一定間隔で
     レンジ/Az/El観測をノイズ付きで生成し SCC.od.addObs() する。真の視線(trueOrbit)を
     観測ノイズで汚したものが「地上局が受け取る観測」というモデル。 */
  function stepOdObservations() {
    if (SCC.od.status().state !== "COLLECTING") return;
    const tMs = S.simTime.getTime();
    for (const st of S.stations) {
      if (!st.antenna.lock) continue;
      const last = lastObsMs[st.id] || 0;
      if (tMs - last < OBS_INTERVAL_S * 1000) continue;
      lastObsMs[st.id] = tMs;
      const look = trueOrbit.lookAngles(st, S.simTime);
      if (!(look.el > orbit.MIN_EL)) continue;
      SCC.od.addObs({
        tMs,
        station: { id: st.id, lat: st.lat, lon: st.lon, altKm: 0 },
        rangeKm: look.range + gauss(0.02),
        azDeg: look.az + gauss(0.15),
        elDeg: look.el + gauss(0.15),
      });
    }
  }

  /* ---------- メインループ ---------- */
  const REAL_INTERVAL = 250; // ms
  let lastReal = performance.now();

  function loop() {
    const now = performance.now();
    const realDt = Math.min(2, (now - lastReal) / 1000);
    lastReal = now;
    let simDt = realDt * S.simSpeed;

    while (simDt > 0) {
      const dt = Math.min(5, simDt);
      simDt -= dt;
      S.simTime = new Date(S.simTime.getTime() + dt * 1000);

      // パス一覧の鮮度維持 (30分ごと再計算) + ステータス更新
      if (S.simTime.getTime() - lastPassCalc > 30 * 60e3) recalcPasses();
      for (const p of S.passes) p.status = passStatusOf(p);

      const pos = trueOrbit.propagate(S.simTime);   // 衛星の実位置は真の軌道から
      S.sat.pos = { lat: pos.lat, lon: pos.lon, alt: pos.alt };
      S.sat.eci = pos.eci; S.sat.vel = pos.vel;

      for (const st of S.stations) stepAntenna(st, dt);
      stepTelemetry(dt);
      stepCommands(dt);
      stepDownlink(dt);
      stepOdObservations();
    }

    S.met = (S.simTime.getTime() - LAUNCH) / 1000;
    S.sat.orbitNo = orbit.orbitNumber(S.simTime);
    if (S.simTime.getTime() - lastTrackCalc > 60e3) recalcTrack();
    checkPassEdges();
    checkContactEdges();
    checkAlarms();

    // OD駆動: 収束したら地上表示軌道(TLE)を補正
    const fit = SCC.od.step(S.simTime.getTime());
    if (fit) {
      orbit.setTLE(fit.tle[0], fit.tle[1]);
      recalcPasses(); recalcTrack();
      log("warn", "OD", `軌道決定完了 — 残差RMS ${fit.stats.rmsM.toFixed(0)}m / σpos ${fit.stats.sigmaPosM.toFixed(0)}m / 観測${fit.stats.nObs}点(${fit.stats.nStations}局) — 予測軌道との差 ${fit.stats.corrKm.toFixed(2)}km を補正`);
    }
    S.od = SCC.od.status();

    bus.emit("tick", S);
  }

  /* ---------- 操作API ---------- */
  SCC.ops = {
    setSimSpeed(n) {
      S.simSpeed = n;
      log("info", "SIM", `シミュレーション速度 ×${n}`);
    },
    sendCommand(name, args, stationId) {
      const c = { id: "CMD-" + String(cmdSeq++).padStart(4, "0"), t: new Date(S.simTime), name, args: args || "", status: "QUEUED", station: stationId || null };
      S.commandQueue.push(c);
      log("info", "CMD", `${c.id} ${name} キュー投入${stationId ? " (" + stationId + ")" : ""}`);
      return c;
    },
    setAntennaMode(stationId, mode) {
      const st = S.stations.find(s => s.id === stationId);
      if (!st) return;
      st.antenna.mode = mode;
      if (mode === "MAINT" || mode === "STOWED") st.antenna.autoTrack = false;
      log("warn", stationId, `アンテナモード → ${mode}`);
    },
    setAutoTrack(stationId, on) {
      const st = S.stations.find(s => s.id === stationId);
      if (!st) return;
      st.antenna.autoTrack = on;
      if (on && (st.antenna.mode === "MAINT" || st.antenna.mode === "STOWED")) st.antenna.mode = "IDLE";
      log("info", stationId, `AUTO TRACK ${on ? "ON" : "OFF"}`);
    },
    slewAntenna(stationId, az, el) {
      const st = S.stations.find(s => s.id === stationId);
      if (!st || st.antenna.autoTrack) return;
      st.antenna.cmdAz = clamp(az, 0, 360) % 360;
      st.antenna.cmdEl = clamp(el, 0, 90);
      log("info", stationId, `手動スルー → Az ${az.toFixed(1)}° / El ${el.toFixed(1)}°`);
    },
    ackAlarm(alarmId) {
      const a = S.sat.alarms.find(x => x.id === alarmId);
      if (a) { a.ack = true; log("info", "FDIR", `アラーム確認: ${a.key}`); }
      S.sat.alarms = S.sat.alarms.filter(x => !x.ack || latched[x.key]);
    },
    startSwUpdate() {
      if (S.swUpdate.state !== "IDLE") return;
      S.swUpdate.state = "UPLOADING"; S.swUpdate.pct = 0;
      log("info", "SWU", `${S.swUpdate.available} アップロード開始 (次パスから転送)`);
    },
    installSwUpdate() {
      if (S.swUpdate.state !== "READY") return;
      S.swUpdate.state = "INSTALLING"; S.swUpdate.pct = 0;
      log("warn", "SWU", "インストール開始 — OBC再起動を伴います");
    },
    abortSwUpdate() {
      if (S.swUpdate.state === "IDLE") return;
      S.swUpdate.state = "IDLE"; S.swUpdate.pct = 0;
      log("warn", "SWU", "ソフトウェア更新を中断");
    },
  };

  /* ---------- 初期化 ---------- */
  function init() {
    // 真の軌道を地上予測(SCC.orbit、--tle 反映済み)と同一TLEで初期化
    const t0 = orbit.getTLE();
    trueOrbit.setTLE(t0.line1, t0.line2);

    // 「まもなく東京局のパスが来る」時刻にエポックを合わせる (画面が映える)
    const base = new Date();
    const tky = S.stations[0];
    const passes = orbit.predictPasses(tky, base, 24).filter(p => p.maxEl >= 25);
    S.simTime = passes.length ? new Date(passes[0].aos.getTime() - 7 * 60e3) : base;

    recalcPasses();
    recalcTrack();
    const pos = trueOrbit.propagate(S.simTime);
    S.sat.pos = { lat: pos.lat, lon: pos.lon, alt: pos.alt };
    S.sat.eci = pos.eci;
    S.sat.telemetry.cdh.uptime = rnd(20, 200) * 86400 / 10;
    for (const st of S.stations) visible[st.id] = trueOrbit.lookAngles(st, S.simTime).el > orbit.MIN_EL;
    inContact = S.contact.windows.some(w => w.start <= S.simTime && S.simTime <= w.end); // 起動時の誤ログ防止
    S.od = SCC.od.status();

    // 初期ダウンリンクキュー
    S.downlink.files = [
      { name: "TLM_ARCHIVE_D230.bin", size: 12.4, pct: 0, state: "PENDING" },
      { name: "IMG_20260702_2214.raw", size: 52.0, pct: 0, state: "PENDING" },
      { name: "IMG_20260702_2216.raw", size: 48.7, pct: 0, state: "PENDING" },
      { name: "ADCS_DIAG_D229.log",   size: 3.1,  pct: 0, state: "PENDING" },
    ];
    S.downlink.totalMB = 18432;

    log("info", "SYS", "SCC 地上管制システム起動");
    log("info", "SYS", `軌道要素更新 — 周期 ${(orbit.PERIOD / 60).toFixed(1)} min / 高度 ${orbit.ALT} km`);
    const np = S.passes.find(p => p.status === "upcoming");
    if (np) log("info", "PASS", `次パス: ${np.station} AOS ${SCC.fmt.hms(np.aos)} UTC (最大仰角 ${np.maxEl.toFixed(0)}°)`);

    setInterval(loop, REAL_INTERVAL);
    bus.emit("tick", S);
  }

  SCC.mock = { init };
})();
