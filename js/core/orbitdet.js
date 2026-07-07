/* SCC orbitdet — 観測ベース軌道決定 (OD)
   PROP_BURN 実行後、地上局が取得する観測(レンジ・Az/El)をバッチ最小二乗にフィットし、
   噴射誤差込みの「真の」軌道要素を推定する。SCC.state には依存しない純粋な推定モジュール
   (satellite.js グローバルと SCC.createOrbit のみを利用)。SCC.od に登録。

   推定アルゴリズム: バッチ最小二乗 (Gauss-Newton + Levenberg-Marquardt)。
   推定パラメータ x = [rx,ry,rz,vx,vy,vz] (ECI km・km/s、エポック=最初の観測時刻)。
   詳細は SPEC.md §4.6 を参照。 */
(function () {
  "use strict";

  const root = (typeof window !== "undefined") ? window : globalThis;
  const SCC = root.SCC;

  const SIGMA_R = 0.02;      // レンジ観測誤差 [km]
  const SIGMA_A = 0.15;      // Az/El 観測誤差 [deg]
  const D2R = Math.PI / 180;

  const MAX_BUF = 500;         // 観測バッファ上限
  const FIT_WINDOW = 150;      // フィットに使う最新観測点数
  const SIM_GATE_MS = 15000;   // シミュレーション時間ゲート (15秒)
  const REAL_GATE_MS = 1000;   // 実時間ゲート (1秒)

  const PERT_R = 1.0;        // ヤコビアン位置摂動幅 [km]
  const PERT_V = 0.001;      // ヤコビアン速度摂動幅 [km/s]
  const MAX_ITER = 8;
  const LM_LAMBDA0 = 1e-3;
  const LM_LAMBDA_MAX = 1e3;
  const CONV_DR = 0.010;     // 収束判定: |Δr| < 10m
  const CONV_DV = 0.00001;   // 収束判定: |Δv| < 1cm/s (km/s)

  // 採用(収束確定)条件
  const MIN_OBS = 30;
  const MIN_SPAN_S = 120;
  const MIN_SPAN_OR_STATIONS_S = 300;
  const MIN_STATIONS = 2;
  const MAX_SIGMA_POS_M = 500;

  /* 実時間計測 (Node/ブラウザ両対応) */
  const nowReal = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  function reset(priorTle, burnDate) {
    return {
      state: priorTle ? "COLLECTING" : "IDLE",
      priorTle: priorTle ? [priorTle[0], priorTle[1]] : null,
      burnDate: burnDate ? new Date(burnDate) : null,
      obs: [],
      lastSimStepMs: null,
      lastRealStepMs: null,
      // status() 表示用の最新フィット試行結果 (未収束でも rms/sigma を見せてよい)
      lastRmsM: NaN,
      lastSigmaPosM: NaN,
    };
  }

  let od = reset(null, null);

  /* ---------- 観測追加 ---------- */
  function addObs(o) {
    if (!o || !o.station || !isFinite(o.rangeKm) || !isFinite(o.azDeg) || !isFinite(o.elDeg)) return;
    od.obs.push({
      tMs: o.tMs,
      station: { id: o.station.id, lat: o.station.lat, lon: o.station.lon, altKm: o.station.altKm || 0 },
      rangeKm: o.rangeKm, azDeg: o.azDeg, elDeg: o.elDeg,
    });
    if (od.obs.length > MAX_BUF) od.obs.splice(0, od.obs.length - MAX_BUF);
  }

  /* ---------- ベクトル/行列ユーティリティ (6次元) ---------- */
  function wrapDeg180(d) {
    let x = ((d + 180) % 360 + 360) % 360 - 180;
    return x;
  }

  /* 候補状態ベクトル x=[rx,ry,rz,vx,vy,vz] (エポック=od.obs[0].tMs) から
     各観測時刻の予測 (range,az,el) を作業用 orbit インスタンスで計算する。
     tleFromState/setTLE に失敗したら null を返す。 */
  function predictAll(scratchOrbit, x, epochMs, obsList) {
    const r = { x: x[0], y: x[1], z: x[2] };
    const v = { x: x[3], y: x[4], z: x[5] };
    const tle = scratchOrbit.tleFromState(r, v, new Date(epochMs));
    if (!tle) return null;
    if (!scratchOrbit.setTLE(tle[0], tle[1])) return null;
    const preds = new Array(obsList.length);
    for (let i = 0; i < obsList.length; i++) {
      const o = obsList[i];
      const la = scratchOrbit.lookAngles(o.station, new Date(o.tMs));
      if (!isFinite(la.az) || !isFinite(la.el) || !isFinite(la.range)) return null;
      preds[i] = la;
    }
    return preds;
  }

  /* 残差ベクトル(無次元化)。長さ = 3 * obsList.length (range, el, az の順)。 */
  function residuals(preds, obsList) {
    const res = new Array(obsList.length * 3);
    for (let i = 0; i < obsList.length; i++) {
      const o = obsList[i], p = preds[i];
      const cosEl = Math.cos(o.elDeg * D2R);
      res[i * 3 + 0] = (o.rangeKm - p.range) / SIGMA_R;
      res[i * 3 + 1] = (o.elDeg - p.el) / SIGMA_A;
      res[i * 3 + 2] = (wrapDeg180(o.azDeg - p.az) * cosEl) / SIGMA_A;
    }
    return res;
  }

  function costOf(res) {
    let s = 0;
    for (let i = 0; i < res.length; i++) s += res[i] * res[i];
    return s;
  }

  /* ヤコビアン (数値前進差分): m×6 (m = 3*nObs)。scratchOrbit は使い回す作業インスタンス。 */
  function numericJacobian(scratchOrbit, x, epochMs, obsList, res0) {
    const m = obsList.length * 3;
    const J = new Array(m);
    for (let i = 0; i < m; i++) J[i] = new Array(6).fill(0);

    for (let k = 0; k < 6; k++) {
      const h = k < 3 ? PERT_R : PERT_V;
      const xp = x.slice();
      xp[k] += h;
      const predsP = predictAll(scratchOrbit, xp, epochMs, obsList);
      if (!predsP) return null;
      const resP = residuals(predsP, obsList);
      for (let i = 0; i < m; i++) J[i][k] = (resP[i] - res0[i]) / h;
    }
    return J;
  }

  /* 6x6線形方程式 A x = b を部分ピボット付きガウス消去で解く。特異なら null。 */
  function solve6(A, b) {
    const n = 6;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-18) return null;
      if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
      const pv = M[col][col];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / pv;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
    return x;
  }

  /* JᵀJ (6x6) と Jᵀr (6) を計算 */
  function normalEquations(J, res) {
    const n = 6, m = J.length;
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        Jtr[a] += Ji[a] * res[i];
        for (let b = 0; b < n; b++) JtJ[a][b] += Ji[a] * Ji[b];
      }
    }
    return { JtJ, Jtr };
  }

  /* (JᵀJ)^-1 を求め、位置ブロック(左上3x3)のトレースの平方根[km]→[m] を返す */
  function sigmaPosFromJtJ(JtJ) {
    // (JtJ)^-1 の対角3成分だけ必要。6本の単位ベクトルに対し solve6 して逆行列を組み立てる。
    const n = 6;
    const inv = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let k = 0; k < n; k++) {
      const e = new Array(n).fill(0); e[k] = 1;
      const col = solve6(JtJ, e);
      if (!col) return NaN;
      for (let i = 0; i < n; i++) inv[i][k] = col[i];
    }
    const trace = inv[0][0] + inv[1][1] + inv[2][2];
    if (!(trace >= 0)) return NaN;
    return Math.sqrt(trace) * 1000; // km → m
  }

  /* ---------- Levenberg-Marquardt バッチ最小二乗フィット ---------- */
  function tryFit(obsList) {
    if (obsList.length < 6) return null; // 最低限のパラメータ数
    const epochMs = obsList[0].tMs;

    // 初期値: priorTle を epoch まで伝播した状態ベクトル
    const prior = SCC.createOrbit();
    if (!prior.setTLE(od.priorTle[0], od.priorTle[1])) return null;
    const st0 = prior.stateAt(new Date(epochMs));
    if (!st0) return null;
    let x = [st0.r.x, st0.r.y, st0.r.z, st0.v.x, st0.v.y, st0.v.z];
    const x0 = x.slice(); // 補正量計算用に保持

    const scratch = SCC.createOrbit();
    let preds = predictAll(scratch, x, epochMs, obsList);
    if (!preds) return null;
    let res = residuals(preds, obsList);
    let cost = costOf(res);

    let lambda = LM_LAMBDA0;
    let converged = false;
    let lastJtJ = null;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const J = numericJacobian(scratch, x, epochMs, obsList, res);
      if (!J) return null;
      const { JtJ, Jtr } = normalEquations(J, res);
      lastJtJ = JtJ;

      // LM反復: コストが下がるまで lambda を増やす
      let stepAccepted = false;
      for (let tries = 0; tries < 12; tries++) {
        const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v || 1e-12) : v)));
        const negJtr = Jtr.map(v => -v);
        const dx = solve6(A, negJtr);
        if (!dx) { lambda *= 10; continue; }

        const xNew = x.map((v, i) => v + dx[i]);
        const predsNew = predictAll(scratch, xNew, epochMs, obsList);
        if (!predsNew) { lambda *= 10; if (lambda > LM_LAMBDA_MAX) return null; continue; }
        const resNew = residuals(predsNew, obsList);
        const costNew = costOf(resNew);

        if (costNew < cost) {
          x = xNew; preds = predsNew; res = resNew;
          const dr = Math.hypot(dx[0], dx[1], dx[2]);
          const dv = Math.hypot(dx[3], dx[4], dx[5]);
          cost = costNew;
          lambda = Math.max(lambda / 10, 1e-12);
          stepAccepted = true;
          if (dr < CONV_DR && dv < CONV_DV) converged = true;
          break;
        } else {
          lambda *= 10;
          if (lambda > LM_LAMBDA_MAX) return null; // 発散扱い → 今回のフィット断念
        }
      }
      if (!stepAccepted) return null; // どのlambdaでも改善せず
      if (converged) break;
    }
    if (!converged) return null;

    // 最終ヤコビアンで共分散推定 (直近の J が無ければ再計算)
    const Jfinal = numericJacobian(scratch, x, epochMs, obsList, res);
    const JtJfinal = Jfinal ? normalEquations(Jfinal, res).JtJ : lastJtJ;
    const sigmaPosM = JtJfinal ? sigmaPosFromJtJ(JtJfinal) : NaN;

    // RMS[m]: range残差(無次元)を物理量[km]に戻して評価する方が意味が通る。
    // res は無次元化済みなので、range成分のみ σr を掛け戻して RMS[m] を作る。
    let sumSqKm = 0, cnt = 0;
    for (let i = 0; i < obsList.length; i++) {
      const rr = res[i * 3 + 0] * SIGMA_R; // range残差 [km]
      sumSqKm += rr * rr; cnt++;
    }
    const rmsRangeM = cnt ? Math.sqrt(sumSqKm / cnt) * 1000 : NaN;

    const corrKm = Math.hypot(x[0] - x0[0], x[1] - x0[1], x[2] - x0[2]);

    return { x, epochMs, sigmaPosM, rmsM: rmsRangeM, corrKm };
  }

  /* ---------- 採用判定 ---------- */
  function acceptable(fitObsList, fitResult) {
    if (!fitResult) return false;
    const nObs = fitObsList.length;
    if (nObs < MIN_OBS) return false;
    const spanS = (fitObsList[fitObsList.length - 1].tMs - fitObsList[0].tMs) / 1000;
    if (spanS < MIN_SPAN_S) return false;
    if (!(fitResult.sigmaPosM < MAX_SIGMA_POS_M)) return false;
    const stations = new Set(fitObsList.map(o => o.station.id));
    if (stations.size < MIN_STATIONS && spanS < MIN_SPAN_OR_STATIONS_S) return false;
    return true;
  }

  /* ---------- レート制限付きフィット試行 ---------- */
  function step(nowMs) {
    if (od.state !== "COLLECTING") return null;
    if (od.obs.length < MIN_OBS) return null;

    if (od.lastSimStepMs !== null && (nowMs - od.lastSimStepMs) < SIM_GATE_MS) return null;
    const rnow = nowReal();
    if (od.lastRealStepMs !== null && (rnow - od.lastRealStepMs) < REAL_GATE_MS) return null;
    od.lastSimStepMs = nowMs;
    od.lastRealStepMs = rnow;

    const fitObsList = od.obs.slice(-FIT_WINDOW);
    let fit;
    try {
      fit = tryFit(fitObsList);
    } catch (e) {
      fit = null;
    }
    if (!fit) return null;

    od.lastRmsM = fit.rmsM;
    od.lastSigmaPosM = fit.sigmaPosM;

    if (!acceptable(fitObsList, fit)) return null;

    const r = { x: fit.x[0], y: fit.x[1], z: fit.x[2] };
    const v = { x: fit.x[3], y: fit.x[4], z: fit.x[5] };
    const finalOrbit = SCC.createOrbit();
    const tle = finalOrbit.tleFromState(r, v, new Date(fit.epochMs));
    if (!tle) return null;

    const stations = new Set(fitObsList.map(o => o.station.id));
    const result = {
      tle,
      stats: {
        rmsM: fit.rmsM,
        sigmaPosM: fit.sigmaPosM,
        nObs: fitObsList.length,
        nStations: stations.size,
        corrKm: fit.corrKm,
      },
    };

    od = reset(null, null); // IDLE化 + バッファ解放
    return result;
  }

  /* ---------- ステータス (UI表示用のプレーンオブジェクト) ---------- */
  function status() {
    const stations = new Set(od.obs.map(o => o.station.id));
    return {
      state: od.state,
      nObs: od.obs.length,
      nStations: stations.size,
      sigmaPosM: od.lastSigmaPosM,
      rmsM: od.lastRmsM,
    };
  }

  SCC.od = {
    reset(priorTle, burnDate) { od = reset(priorTle, burnDate); },
    addObs,
    step,
    status,
  };
})();
