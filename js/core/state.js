/* SCC core — イベントバス / 単一ステート / 共通ユーティリティ
   契約は SPEC.md §4 を参照。パネルは SCC.state を読み取り専用として扱うこと。 */
(function () {
  "use strict";

  const listeners = {};
  const bus = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) {
      (listeners[ev] || []).forEach(fn => {
        try { fn(payload); } catch (e) { console.error(`[bus:${ev}]`, e); }
      });
    },
  };

  const state = {
    simTime: new Date(),
    simSpeed: 1,
    met: 0,
    sat: {
      name: "HIKARI-1",
      noradId: 25544,   // 軌道要素はISS準拠 (orbit.js の既定TLE)
      pos: { lat: 0, lon: 0, alt: 550 },
      eci: { x: 0, y: 0, z: 0 },
      vel: 7.6,
      orbitNo: 0,
      telemetry: {
        eps:  { busV: 28.2, busI: 1.2, soc: 82, solarW: 0, battT: 12 },
        tcs:  { obcT: 24, commT: 18, panelT: -10, battT: 12 },
        adcs: { mode: "SUNPOINT", rateX: 0, rateY: 0, rateZ: 0, sunAngle: 0, quat: [1, 0, 0, 0] },
        cdh:  { cpu: 32, mem: 41, uptime: 0, bootCount: 47, storagePct: 36 },
        com:  { rssi: NaN, snr: NaN, bitrate: 0, agc: 0, mode: "RX" },
      },
      alarms: [],
    },
    stations: [
      { id: "GS-TKY", name: "東京・八王子", lat: 35.66, lon: 139.32, band: "S/X",   dish: "3.8m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
      { id: "GS-HKD", name: "北海道・根室", lat: 43.33, lon: 145.58, band: "S",     dish: "2.4m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
      { id: "GS-ISG", name: "沖縄・石垣島", lat: 24.34, lon: 124.16, band: "S/UHF", dish: "1.8m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
      { id: "GS-TSU", name: "長崎・対馬",   lat: 34.20, lon: 129.29, band: "S",     dish: "2.4m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
      { id: "GS-OGA", name: "父島・小笠原追跡所", lat: 27.09, lon: 142.19, band: "S/X", dish: "10m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
      { id: "GS-MTS", name: "東京・南鳥島",   lat: 24.29, lon: 153.98, band: "X",   dish: "3.0m",
        antenna: { az: 0, el: 90, cmdAz: 0, cmdEl: 90, mode: "IDLE", autoTrack: true, rssi: NaN, snr: NaN, lock: false } },
    ],
    passes: [],
    // 統合コンタクトウィンドウ: 全局のパスをマージした「局をまたいで途切れない通信区間」
    // windows: [{start: Date, end: Date, stations: [AOS順の局ID]}]
    contact: { windows: [] },
    groundTrack: { past: [], future: [] },
    commandQueue: [],
    downlink: { sessions: [], files: [], totalMB: 0, rate: 0 },
    swUpdate: { current: "v2.4.1", available: "v2.5.0", state: "IDLE", pct: 0 },
    history: [],
  };

  /* ---------- 共通フォーマッタ ---------- */
  const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, "0");
  const fmt = {
    hms(date) {
      return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    },
    hmsJST(date) {
      const d = new Date(date.getTime() + 9 * 3600e3);
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    },
    dateUTC(date) {
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    },
    // 秒 → "T-04:32" / "1h 12m" 系
    countdown(sec) {
      if (!isFinite(sec)) return "---";
      const s = Math.max(0, Math.round(sec));
      if (s >= 3600) return `${Math.floor(s / 3600)}h ${pad((s % 3600) / 60)}m`;
      return `${pad(s / 60)}:${pad(s % 60)}`;
    },
    duration(sec) {
      const s = Math.max(0, Math.round(sec));
      return s >= 3600 ? `${Math.floor(s / 3600)}h${pad((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m${pad(s % 60)}s`;
    },
    met(sec) {
      const d = Math.floor(sec / 86400);
      return `${d}d ${pad((sec % 86400) / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}`;
    },
    deg(v, digits = 1) { return isFinite(v) ? v.toFixed(digits) + "°" : "---"; },
    num(v, digits = 1, unit = "") { return isFinite(v) ? v.toFixed(digits) + unit : "---"; },
    latlon(lat, lon) {
      return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
    },
  };

  /* ---------- canvas ヘルパ ---------- */
  // devicePixelRatio 対応の canvas セットアップ。ResizeObserver で追従し、
  // resize 時に draw() を呼ぶ。戻り値: { ctx, w(), h() } (w/h は CSS ピクセル)
  function bindCanvas(canvas, draw) {
    const ctx = canvas.getContext("2d");
    let cssW = 0, cssH = 0, first = true;
    function resize() {
      const r = canvas.getBoundingClientRect();
      cssW = r.width; cssH = r.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 初回の同期呼び出しでは draw しない: 呼び出し元はまだ戻り値を受け取っておらず
      // TDZ になり得る。初回描画は ResizeObserver の非同期初回発火に任せる。
      if (draw && !first) draw();
      first = false;
    }
    new ResizeObserver(resize).observe(canvas);
    resize();
    return { ctx, w: () => cssW, h: () => cssH };
  }

  /* ---------- ツールチップ ---------- */
  let ttEl = null;
  const tooltip = {
    show(html, x, y) {
      if (!ttEl) {
        ttEl = document.createElement("div");
        ttEl.className = "viz-tooltip";
        document.getElementById("tooltip-root").appendChild(ttEl);
      }
      ttEl.innerHTML = html;
      ttEl.style.display = "block";
      const rw = ttEl.offsetWidth, rh = ttEl.offsetHeight;
      const px = Math.min(x + 14, window.innerWidth - rw - 8);
      const py = Math.min(y + 14, window.innerHeight - rh - 8);
      ttEl.style.left = px + "px";
      ttEl.style.top = py + "px";
    },
    hide() { if (ttEl) ttEl.style.display = "none"; },
  };

  /* ---------- 確認モーダル ---------- */
  function confirmModal({ title, body, okLabel = "実行", danger = false }) {
    return new Promise(resolve => {
      const root = document.getElementById("modal-root");
      root.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal">
            <h3>${title}</h3>
            <p>${body}</p>
            <div class="modal-actions">
              <button class="btn" data-act="cancel">キャンセル</button>
              <button class="btn ${danger ? "btn--danger" : "btn--primary"}" data-act="ok">${okLabel}</button>
            </div>
          </div>
        </div>`;
      root.querySelectorAll("button").forEach(b =>
        b.addEventListener("click", () => { root.innerHTML = ""; resolve(b.dataset.act === "ok"); }));
    });
  }

  window.SCC = { bus, state, fmt, bindCanvas, tooltip, confirmModal, panels: {}, ops: {}, orbit: {}, geo: {} };
})();
