/* SCC panels — ops.js
   SPEC.md §5.5-§5.9:
     5.5 パススケジュール   (#sched-canvas)   → SCC.panels.sched
     5.6 コマンドコンソール (#cmd-body)       → SCC.panels.cmd
     5.7 キュー/履歴        (#queue-body)     → SCC.panels.queue
     5.8 ダウンリンク+SW更新 (#data-body)     → SCC.panels.data
     5.9 イベントログ       (#log-body)       → SCC.panels.log
   SCC.state は読み取り専用。操作は SCC.ops.* 経由。 */
(function () {
  "use strict";

  const S = SCC.state, bus = SCC.bus, fmt = SCC.fmt;

  const pad2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const clampPct = (v) => (isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const COL = {
    ink: cssVar("--ink") || "#e8eaed",
    ink2: cssVar("--ink-2") || "#9aa0a8",
    ink3: cssVar("--ink-3") || "#6b7076",
    hairline: cssVar("--hairline") || "#262a30",
    hairline2: cssVar("--hairline-2") || "#31363e",
    ok: cssVar("--ok") || "#0ca30c",
  };

  /* ============================================================ CSS ============================================================ */
  const style = document.createElement("style");
  style.textContent = `
    .ops-cmd-tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
    .ops-cmd-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(126px,1fr)); gap:6px; margin-bottom:14px; }
    .ops-cmd-btn { text-align:left; font-family:var(--mono); font-size:11px; }
    .ops-cmd-btn--danger { border-color:var(--crit); color:var(--crit); }
    .ops-cmd-btn--sel { outline:2px solid var(--s1); outline-offset:-1px; }
    .ops-cmd-stage { border-top:1px solid var(--hairline); padding-top:10px; display:flex; flex-direction:column; gap:8px; }
    .ops-cmd-stage-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .ops-cmd-name { font-family:var(--mono); font-weight:700; min-width:150px; color:var(--ink); }
    .ops-cmd-stage-row input[type="text"] { flex:1; min-width:100px; }
    .ops-cmd-note { font-size:11px; color:var(--ink-3); min-height:14px; }
    .ops-cmd-actions { display:flex; gap:8px; align-items:center; }
    .ops-cmd-actions .btn[disabled] { opacity:.35; }

    .ops-queue-split { position:absolute; inset:0; display:flex; flex-direction:column; }
    .ops-queue-sec { display:flex; flex-direction:column; min-height:0; }
    .ops-queue-sec--q { flex:0 0 40%; }
    .ops-queue-sec--h { flex:1 1 60%; border-top:1px solid var(--hairline); }
    .ops-queue-hd { flex:none; font-size:10px; font-weight:600; letter-spacing:.12em; color:var(--ink-3); padding:7px 10px 3px; }
    .ops-queue-scroll { flex:1; min-height:0; overflow:auto; padding:0 4px; }
    .ops-empty { padding:12px; color:var(--ink-3); font-size:12px; text-align:center; }

    .ops-data-summary { font-size:13px; padding-bottom:9px; border-bottom:1px solid var(--hairline); margin-bottom:9px; }
    .ops-file-list { display:flex; flex-direction:column; gap:7px; margin-bottom:18px; }
    .ops-file-row { display:flex; align-items:center; gap:10px; font-size:12px; }
    .ops-file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--mono); color:var(--ink-2); }
    .ops-file-size { width:64px; text-align:right; color:var(--ink-3); flex:none; }
    .ops-file-bar { width:90px; flex:none; }
    .ops-sw-card { border-top:1px solid var(--hairline); padding-top:12px; }
    .ops-sw-hd { font-family:var(--mono); font-size:14px; margin-bottom:9px; }
    .ops-sw-steps { display:flex; gap:4px; margin-bottom:9px; }
    .ops-sw-step { flex:1; text-align:center; font-size:10px; letter-spacing:.06em; padding:5px 0; border:1px solid var(--hairline-2); border-radius:4px; color:var(--ink-3); }
    .ops-sw-step.on { border-color:var(--s1); color:var(--ink); background:var(--surface-hi); }
    .ops-sw-pct { font-size:11px; color:var(--ink-2); margin:5px 0 10px; }
    .ops-sw-actions { display:flex; justify-content:flex-end; }

    .ops-log-wrap { position:absolute; inset:0; overflow-y:auto; padding:5px 10px; font-size:12px; }
    .ops-log-row { display:flex; align-items:baseline; gap:8px; padding:1.5px 0; line-height:1.45; }
    .ops-log-dot { width:6px; height:6px; border-radius:50%; flex:none; align-self:center; }
    .ops-log-time { color:var(--ink-3); font-size:11px; flex:none; width:60px; }
    .ops-log-src { color:var(--ink-2); font-family:var(--mono); font-size:11px; flex:none; width:50px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ops-log-msg { color:var(--ink); flex:1; min-width:0; word-break:break-word; }
  `;
  document.head.appendChild(style);

  /* ============================================================ 5.5 パススケジュール ============================================================ */
  function initSched() {
    const canvas = document.getElementById("sched-canvas");
    if (!canvas) return;
    const LABEL_W = 60, TOP_H = 22;
    let bars = [];

    const { ctx, w, h } = SCC.bindCanvas(canvas, draw);

    function draw() {
      const W = w(), H = h();
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      bars = [];

      const stations = S.stations;
      const rows = (stations.length || 1) + 1;   // 先頭行 = NET (統合コンタクトウィンドウ)
      const rowH = (H - TOP_H) / rows;
      const plotX = LABEL_W;
      const t0 = S.simTime.getTime(), t1 = t0 + 24 * 3600e3;
      const xOf = (t) => plotX + ((t - t0) / (t1 - t0)) * (W - plotX);

      ctx.textBaseline = "middle";

      // 時刻目盛(3hごと)
      ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
      for (let dHr = 0; dHr <= 24; dHr += 3) {
        const t = t0 + dHr * 3600e3;
        const x = xOf(t);
        ctx.strokeStyle = COL.hairline;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, TOP_H); ctx.lineTo(x, H); ctx.stroke();
        const d = new Date(t);
        ctx.fillStyle = COL.ink3;
        ctx.fillText(`${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`, Math.min(x + 3, W - 34), TOP_H / 2);
      }

      // 局ラベル + 行区切り (行0 = NET 統合行)
      ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
      for (let i = 0; i < rows; i++) {
        const y = TOP_H + i * rowH;
        ctx.strokeStyle = COL.hairline;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        if (i === 0) {
          ctx.fillStyle = "#199e70";
          ctx.fillText("NET", 4, y + rowH / 2);
        } else if (stations[i - 1]) {
          ctx.fillStyle = COL.ink2;
          ctx.fillText(stations[i - 1].id, 4, y + rowH / 2);
        }
      }

      // 統合コンタクトウィンドウ (行0): 局をまたいだ連続通信区間
      const winBarH = rowH * 0.55;
      for (const win of (S.contact && S.contact.windows) || []) {
        if (!win.start || !win.end || win.end.getTime() < t0) continue;
        const x1 = Math.max(plotX, xOf(win.start.getTime()));
        const x2 = Math.min(W, xOf(win.end.getTime()));
        if (!isFinite(x1) || !isFinite(x2) || x2 <= plotX || x1 >= W) continue;
        const bw = Math.max(1, x2 - x1);
        const y = TOP_H + (rowH - winBarH) / 2;
        const active = win.start <= S.simTime && S.simTime <= win.end;
        ctx.fillStyle = "rgba(25,158,112,0.6)";
        ctx.fillRect(x1, y, bw, winBarH);
        if (active) {
          ctx.strokeStyle = COL.ok;
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 + 1, y + 1, Math.max(1, bw - 2), Math.max(1, winBarH - 2));
        }
        if (bw > 40) {
          ctx.fillStyle = COL.ink;
          ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
          ctx.fillText(win.stations.length + "局", x1 + 5, y + winBarH / 2);
        }
        bars.push({ x: x1, y, w: bw, h: winBarH, win });
      }

      // パスバー
      const barH = rowH * 0.55;
      for (const p of S.passes) {
        if (!p || p.status === "done" || !p.aos || !p.los) continue;
        const si = stations.findIndex((s) => s.id === p.station);
        if (si < 0) continue;
        const x1 = Math.max(plotX, xOf(p.aos.getTime()));
        const x2 = Math.min(W, xOf(p.los.getTime()));
        if (!isFinite(x1) || !isFinite(x2) || x2 <= plotX || x1 >= W) continue;
        const bw = Math.max(1, x2 - x1);
        const y = TOP_H + (si + 1) * rowH + (rowH - barH) / 2;
        const maxEl = isFinite(p.maxEl) ? p.maxEl : 0;
        const alpha = maxEl < 20 ? 0.35 : maxEl < 60 ? 0.65 : 1.0;
        ctx.fillStyle = `rgba(57,135,229,${alpha})`;
        ctx.fillRect(x1, y, bw, barH);
        if (p.status === "active") {
          ctx.strokeStyle = COL.ok;
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 + 1, y + 1, Math.max(1, bw - 2), Math.max(1, barH - 2));
        }
        if (bw > 30) {
          ctx.fillStyle = COL.ink;
          ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
          ctx.fillText(Math.round(maxEl) + "°", x1 + 5, y + barH / 2);
        }
        bars.push({ x: x1, y, w: bw, h: barH, pass: p });
      }

      // 現在時刻線(左端)
      ctx.strokeStyle = COL.ok;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(plotX, TOP_H); ctx.lineTo(plotX, H); ctx.stroke();
    }

    bus.on("tick", draw);

    canvas.addEventListener("mousemove", (ev) => {
      const r = canvas.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const hit = bars.find((b) => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
      if (!hit) { SCC.tooltip.hide(); return; }
      if (hit.win) {
        const w = hit.win;
        const wdur = (w.end.getTime() - w.start.getTime()) / 1000;
        SCC.tooltip.show(
          `<div class="tt-title">統合コンタクトウィンドウ (${w.stations.length}局)</div>
           <div class="tt-row"><span>開始</span><b>${fmt.hms(w.start)} UTC</b></div>
           <div class="tt-row"><span>終了</span><b>${fmt.hms(w.end)} UTC</b></div>
           <div class="tt-row"><span>連続通信時間</span><b>${fmt.duration(wdur)}</b></div>
           <div class="tt-row"><span>ハンドオーバー</span><b>${w.stations.map(s => s.replace("GS-", "")).join("→")}</b></div>`,
          ev.clientX, ev.clientY
        );
        return;
      }
      const p = hit.pass;
      const dur = (p.los.getTime() - p.aos.getTime()) / 1000;
      SCC.tooltip.show(
        `<div class="tt-title">${p.station}</div>
         <div class="tt-row"><span>AOS</span><b>${fmt.hms(p.aos)} UTC</b></div>
         <div class="tt-row"><span>LOS</span><b>${fmt.hms(p.los)} UTC</b></div>
         <div class="tt-row"><span>継続時間</span><b>${fmt.duration(dur)}</b></div>
         <div class="tt-row"><span>最大仰角</span><b>${isFinite(p.maxEl) ? p.maxEl.toFixed(1) : "--"}°</b></div>`,
        ev.clientX, ev.clientY
      );
    });
    canvas.addEventListener("mouseleave", () => SCC.tooltip.hide());
  }

  /* ============================================================ 5.6 コマンドコンソール ============================================================ */
  const CATS = ["OBC", "EPS", "ADCS", "COM", "PLD", "PROP"];
  const COMMANDS = [
    { cat: "OBC", name: "OBC_REBOOT", danger: true },
    { cat: "OBC", name: "OBC_TIME_SYNC" },
    { cat: "OBC", name: "OBC_HEALTH_DUMP" },
    { cat: "EPS", name: "EPS_LOAD_SHED", danger: true },
    { cat: "EPS", name: "EPS_HEATER_ON" },
    { cat: "EPS", name: "EPS_HEATER_OFF" },
    { cat: "ADCS", name: "ADCS_MODE_SUNPOINT" },
    { cat: "ADCS", name: "ADCS_MODE_NADIR" },
    { cat: "ADCS", name: "ADCS_DETUMBLE", danger: true },
    { cat: "COM", name: "COM_TX_ON" },
    { cat: "COM", name: "COM_TX_OFF", danger: true },
    { cat: "PLD", name: "PLD_CAPTURE" },
    { cat: "PLD", name: "PLD_STANDBY" },
    { cat: "PROP", name: "PROP_BURN", danger: true,
      argsHint: "PRO|RETRO|RAD_IN|RAD_OUT|NORM_POS|NORM_NEG <dv_mps>  例: PRO 5.2" },
  ];
  const ARM_MS = 5000;

  function initCmd() {
    const root = document.getElementById("cmd-body");
    if (!root) return;
    root.innerHTML = `
      <div class="ops-cmd-tabs" id="ops-cmd-tabs"></div>
      <div class="ops-cmd-grid" id="ops-cmd-grid"></div>
      <div class="ops-cmd-stage">
        <div class="ops-cmd-stage-row">
          <span class="ops-cmd-name" id="ops-cmd-name">未選択</span>
          <input type="text" id="ops-cmd-args" placeholder="引数(任意)">
          <select id="ops-cmd-station"><option value="">AUTO</option></select>
        </div>
        <div class="ops-cmd-note" id="ops-cmd-note"></div>
        <div class="ops-cmd-actions">
          <button class="btn" id="ops-cmd-arm" disabled>ARM</button>
          <button class="btn btn--primary" id="ops-cmd-send" disabled>SEND</button>
        </div>
      </div>`;

    const tabsEl = document.getElementById("ops-cmd-tabs");
    const gridEl = document.getElementById("ops-cmd-grid");
    const nameEl = document.getElementById("ops-cmd-name");
    const argsEl = document.getElementById("ops-cmd-args");
    const stEl = document.getElementById("ops-cmd-station");
    const noteEl = document.getElementById("ops-cmd-note");
    const armBtn = document.getElementById("ops-cmd-arm");
    const sendBtn = document.getElementById("ops-cmd-send");

    for (const st of S.stations) {
      const o = document.createElement("option");
      o.value = st.id; o.textContent = st.id;
      stEl.appendChild(o);
    }

    let curCat = CATS[0];
    let curCmd = null;
    let armed = false, armUntil = 0, armTimer = null;

    function renderTabs() {
      tabsEl.innerHTML = "";
      for (const c of CATS) {
        const b = document.createElement("button");
        b.className = "chip" + (c === curCat ? " on" : "");
        b.textContent = c;
        b.addEventListener("click", () => { curCat = c; renderTabs(); renderGrid(); });
        tabsEl.appendChild(b);
      }
    }

    function renderGrid() {
      gridEl.innerHTML = "";
      for (const cmd of COMMANDS.filter((c) => c.cat === curCat)) {
        const b = document.createElement("button");
        b.className = "btn btn--sm ops-cmd-btn" +
          (cmd.danger ? " ops-cmd-btn--danger" : "") +
          (curCmd === cmd ? " ops-cmd-btn--sel" : "");
        b.textContent = (cmd.danger ? "⚠ " : "") + cmd.name;
        b.addEventListener("click", () => { curCmd = cmd; disarm(); renderGrid(); renderStage(); });
        gridEl.appendChild(b);
      }
    }

    function renderStage() {
      if (!curCmd) {
        nameEl.textContent = "未選択";
        armBtn.disabled = true;
        sendBtn.disabled = true;
        noteEl.textContent = "";
        return;
      }
      nameEl.textContent = curCmd.name;
      argsEl.placeholder = curCmd.argsHint || "引数(任意)";
      armBtn.disabled = false;
      updateNote();
    }

    function updateNote() {
      if (!curCmd) return;
      const stId = stEl.value || null;
      const active = stId
        ? S.passes.find((p) => p.station === stId && p.status === "active")
        : S.passes.find((p) => p.status === "active");
      noteEl.textContent = active ? "現在パス中 — 即時送信されます" : "パス外 — 次パスで自動送信 (QUEUED)";
    }
    stEl.addEventListener("change", updateNote);

    function disarm() {
      armed = false;
      if (armTimer) { clearInterval(armTimer); armTimer = null; }
      armBtn.classList.remove("btn--armed");
      armBtn.textContent = "ARM";
      sendBtn.disabled = true;
    }

    armBtn.addEventListener("click", () => {
      if (!curCmd) return;
      if (armed) { disarm(); return; }
      armed = true;
      armUntil = Date.now() + ARM_MS;
      armBtn.classList.add("btn--armed");
      sendBtn.disabled = false;
      armTimer = setInterval(() => {
        const remain = Math.max(0, armUntil - Date.now());
        armBtn.textContent = "ARM " + (remain / 1000).toFixed(1) + "s";
        if (remain <= 0) disarm();
      }, 100);
    });

    sendBtn.addEventListener("click", async () => {
      if (sendBtn.disabled || !curCmd) return;
      const cmd = curCmd, args = argsEl.value || "", stId = stEl.value || null;
      if (cmd.danger) {
        const ok = await SCC.confirmModal({
          title: `危険コマンド送信確認`,
          body: `${cmd.name} を送信します。この操作は機体状態に影響します。よろしいですか?`,
          danger: true,
        });
        if (!ok) return;
      }
      SCC.ops.sendCommand(cmd.name, args, stId);
      disarm();
    });

    renderTabs();
    renderGrid();
    renderStage();
    bus.on("tick", updateNote);
  }

  /* ============================================================ 5.7 キュー/履歴 ============================================================ */
  function initQueue() {
    const root = document.getElementById("queue-body");
    if (!root) return;
    root.innerHTML = `
      <div class="ops-queue-split">
        <div class="ops-queue-sec ops-queue-sec--q">
          <div class="ops-queue-hd">QUEUE — 送信待ち</div>
          <div class="ops-queue-scroll"><table class="mono-table">
            <thead><tr><th>ID</th><th>TIME</th><th>COMMAND</th><th>GS</th><th>STATUS</th></tr></thead>
            <tbody id="ops-q-body"></tbody></table></div>
        </div>
        <div class="ops-queue-sec ops-queue-sec--h">
          <div class="ops-queue-hd">HISTORY — 履歴</div>
          <div class="ops-queue-scroll"><table class="mono-table">
            <thead><tr><th>ID</th><th>TIME</th><th>COMMAND</th><th>GS</th><th>STATUS</th></tr></thead>
            <tbody id="ops-h-body"></tbody></table></div>
        </div>
      </div>`;
    const qBody = document.getElementById("ops-q-body");
    const hBody = document.getElementById("ops-h-body");

    function badgeFor(status) {
      const cls = status === "QUEUED" ? "badge"
        : status === "SENT" ? "badge badge--warn"
        : (status === "ACK" || status === "EXEC") ? "badge badge--ok"
        : "badge badge--crit";
      return `<span class="${cls}">${status}</span>`;
    }
    function rowHtml(c) {
      return `<tr><td>${c.id}</td><td>${fmt.hms(c.t)}</td><td>${c.name}</td><td>${c.station || "—"}</td><td>${badgeFor(c.status)}</td></tr>`;
    }
    function render() {
      const q = S.commandQueue.filter((c) => c.status === "QUEUED" || c.status === "SENT");
      const h = S.commandQueue.filter((c) => c.status === "ACK" || c.status === "EXEC" || c.status === "FAIL").slice().reverse();
      qBody.innerHTML = q.map(rowHtml).join("") || `<tr><td colspan="5" class="ops-empty">キュー空</td></tr>`;
      hBody.innerHTML = h.map(rowHtml).join("") || `<tr><td colspan="5" class="ops-empty">履歴なし</td></tr>`;
    }
    bus.on("tick", render);
    render();
  }

  /* ============================================================ 5.8 ダウンリンク + SW更新 ============================================================ */
  const SW_STEPS = ["UPLOAD", "VERIFY", "READY", "INSTALL"];
  const SW_STATE_STEP = { IDLE: -1, UPLOADING: 0, VERIFYING: 1, READY: 2, INSTALLING: 3 };
  const FILE_LABEL = { PENDING: "待機", RX: "受信中", DONE: "完了" };

  function initData() {
    const root = document.getElementById("data-body");
    if (!root) return;
    root.innerHTML = `
      <div class="ops-data-summary readout" id="ops-data-summary"></div>
      <div class="ops-file-list" id="ops-file-list"></div>
      <div class="ops-sw-card">
        <div class="ops-sw-hd" id="ops-sw-ver"></div>
        <div class="ops-sw-steps" id="ops-sw-steps"></div>
        <div class="bar"><i id="ops-sw-bar"></i></div>
        <div class="ops-sw-pct" id="ops-sw-pct"></div>
        <div class="ops-sw-actions" id="ops-sw-actions"></div>
      </div>`;
    const summaryEl = document.getElementById("ops-data-summary");
    const filesEl = document.getElementById("ops-file-list");
    const verEl = document.getElementById("ops-sw-ver");
    const stepsEl = document.getElementById("ops-sw-steps");
    const barEl = document.getElementById("ops-sw-bar");
    const pctEl = document.getElementById("ops-sw-pct");
    const actEl = document.getElementById("ops-sw-actions");

    function fileBadgeClass(state) {
      return state === "PENDING" ? "badge" : state === "RX" ? "badge badge--warn" : "badge badge--ok";
    }
    function makeBtn(label, cls, onClick) {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    }

    function render() {
      const dl = S.downlink;
      const rate = isFinite(dl.rate) ? dl.rate.toFixed(2) : "0.00";
      const total = isFinite(dl.totalMB) ? dl.totalMB.toFixed(0) : "0";
      summaryEl.textContent = `RATE ${rate} Mbps    TOTAL ${total} MB`;

      filesEl.innerHTML = (dl.files || []).map((f) => `
        <div class="ops-file-row">
          <span class="ops-file-name">${f.name}</span>
          <span class="ops-file-size readout">${isFinite(f.size) ? f.size.toFixed(1) : "--"} MB</span>
          <span class="bar ops-file-bar"><i style="width:${clampPct(f.pct)}%"></i></span>
          <span class="${fileBadgeClass(f.state)}">${FILE_LABEL[f.state] || f.state}</span>
        </div>`).join("") || `<div class="ops-empty">受信ファイルなし</div>`;

      const sw = S.swUpdate;
      verEl.innerHTML = `<span class="readout">${sw.current}</span> → <span class="readout" style="color:var(--s1)">${sw.available}</span>`;
      const curStep = SW_STATE_STEP[sw.state] ?? -1;
      stepsEl.innerHTML = SW_STEPS.map((s, i) => `<span class="ops-sw-step${i === curStep ? " on" : ""}">${s}</span>`).join("");
      const pct = clampPct(sw.pct);
      barEl.style.width = pct + "%";
      pctEl.textContent = sw.state === "IDLE" ? "待機中" : `${sw.state} — ${pct.toFixed(0)}%`;

      actEl.innerHTML = "";
      if (sw.state === "IDLE") {
        actEl.appendChild(makeBtn("更新開始", "btn btn--primary", async () => {
          const ok = await SCC.confirmModal({ title: "ソフトウェア更新開始", body: `フライトソフトウェア ${sw.available} への更新を開始します。` });
          if (ok) SCC.ops.startSwUpdate();
        }));
      } else if (sw.state === "READY") {
        actEl.appendChild(makeBtn("インストール", "btn btn--danger", async () => {
          const ok = await SCC.confirmModal({ title: "ソフトウェアインストール", body: "OBC再起動を伴います。実行しますか?", danger: true });
          if (ok) SCC.ops.installSwUpdate();
        }));
      } else {
        actEl.appendChild(makeBtn("中断", "btn btn--danger", async () => {
          const ok = await SCC.confirmModal({ title: "更新中断", body: "進行中のソフトウェア更新を中断します。", danger: true });
          if (ok) SCC.ops.abortSwUpdate();
        }));
      }
    }
    bus.on("tick", render);
    render();
  }

  /* ============================================================ 5.9 イベントログ ============================================================ */
  const LOG_FILTERS = ["ALL", "INFO", "WARN", "CRIT"];
  const MAX_LOG_ROWS = 500;

  function initLog() {
    const filtersRoot = document.getElementById("log-filters");
    const logRoot = document.getElementById("log-body");
    if (!logRoot) return;
    logRoot.innerHTML = `<div class="ops-log-wrap" id="ops-log-wrap"></div>`;
    const wrap = document.getElementById("ops-log-wrap");

    let curFilter = "ALL";

    function levelMatches(level, filter) {
      if (filter === "ALL") return true;
      if (filter === "INFO") return level === "info";
      if (filter === "WARN") return level === "warn" || level === "serious";
      if (filter === "CRIT") return level === "crit";
      return true;
    }
    function dotColor(level) {
      return level === "info" ? "var(--ink-3)"
        : level === "warn" ? "var(--warn)"
        : level === "serious" ? "var(--serious)"
        : "var(--crit)";
    }
    function rowEl(e) {
      const row = document.createElement("div");
      row.className = "ops-log-row";
      row.dataset.level = e.level;
      row.style.display = levelMatches(e.level, curFilter) ? "" : "none";
      const dot = document.createElement("span");
      dot.className = "ops-log-dot";
      dot.style.background = dotColor(e.level);
      const time = document.createElement("span");
      time.className = "ops-log-time readout";
      time.textContent = fmt.hms(e.t);
      const src = document.createElement("span");
      src.className = "ops-log-src";
      src.textContent = e.source;
      const msg = document.createElement("span");
      msg.className = "ops-log-msg";
      msg.textContent = e.msg;
      row.append(dot, time, src, msg);
      return row;
    }

    // 初期表示: 既存 history (新しい順で格納済み)
    const frag = document.createDocumentFragment();
    for (const e of S.history) frag.appendChild(rowEl(e));
    wrap.appendChild(frag);

    bus.on("log", (e) => {
      const nearTop = wrap.scrollTop < 40;
      wrap.insertBefore(rowEl(e), wrap.firstChild);
      while (wrap.children.length > MAX_LOG_ROWS) wrap.removeChild(wrap.lastChild);
      if (nearTop) wrap.scrollTop = 0;
    });

    function renderFilters() {
      filtersRoot.innerHTML = "";
      for (const f of LOG_FILTERS) {
        const b = document.createElement("button");
        b.className = "chip" + (f === curFilter ? " on" : "");
        b.textContent = f;
        b.addEventListener("click", () => {
          curFilter = f;
          renderFilters();
          for (const row of wrap.children) row.style.display = levelMatches(row.dataset.level, curFilter) ? "" : "none";
        });
        filtersRoot.appendChild(b);
      }
    }
    renderFilters();
  }

  /* ============================================================ 登録 ============================================================ */
  SCC.panels.sched = { init: initSched };
  SCC.panels.cmd = { init: initCmd };
  SCC.panels.queue = { init: initQueue };
  SCC.panels.data = { init: initData };
  SCC.panels.log = { init: initLog };
})();
