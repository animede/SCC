/* SCC panel — テレメトリ (panel-tlm)
   上段: ステータスタイル6枚 / 下段: ストリップチャート4枚(EPSのみ上下2段)。
   契約: SPEC.md §5.4 参照。SCC.state は読み取り専用、DOM/CSSは自前構築(#tlm-body 内)。 */
(function () {
  "use strict";

  const S = SCC.state;

  /* ---------- 系列色(検証済・順序固定。canvas描画用に定数保持可) ---------- */
  const SERIES = { s1: "#3987e5", s2: "#199e70", s3: "#c98500", s4: "#008300" };

  /* ---------- CSSトークン(canvas描画用に実値を取得) ---------- */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  let PAL = null;
  function palette() {
    if (!PAL) {
      PAL = {
        ink: cssVar("--ink", "#e8eaed"),
        ink2: cssVar("--ink-2", "#9aa0a8"),
        ink3: cssVar("--ink-3", "#6b7076"),
        hair: cssVar("--hairline", "#262a30"),
        warn: cssVar("--warn", "#fab219"),
        crit: cssVar("--crit", "#d03b3b"),
      };
    }
    return PAL;
  }

  /* ---------- スタイル注入 ---------- */
  function injectStyle() {
    if (document.getElementById("tlm-style")) return;
    const st = document.createElement("style");
    st.id = "tlm-style";
    st.textContent = `
#tlm-body { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tlm-tiles {
  flex: none;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 8px;
  padding: 10px 12px;
}
.tlm-tile {
  background: var(--surface-in);
  border-radius: 6px;
  border-left: 3px solid transparent;
  padding: 7px 10px 8px;
  display: flex; flex-direction: column; justify-content: center;
  gap: 3px;
  min-width: 0;
}
.tlm-tile.warn { border-left-color: var(--warn); }
.tlm-tile.crit { border-left-color: var(--crit); }
.tlm-tile .tlm-lbl { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--ink-3); letter-spacing: .02em; white-space: nowrap; overflow: hidden; }
.tlm-tile .tlm-tile-sel {
  flex: 1; min-width: 0;
  font-family: var(--sans); font-size: 11px;
  color: var(--ink-3); background: transparent;
  border: 1px solid transparent; border-radius: 4px;
  padding: 1px 4px; margin: -1px -4px;
  cursor: pointer; appearance: none;
  text-overflow: ellipsis;
}
.tlm-tile .tlm-tile-sel:hover { color: var(--ink-2); border-color: var(--hairline-2); background: var(--surface); }
.tlm-tile .tlm-tile-sel:focus { outline: none; color: var(--ink); border-color: var(--s1); background: var(--surface); }
.tlm-tile .tlm-tile-sel option { background: var(--surface); color: var(--ink); }
.tlm-tile .tlm-warn-icon { display: none; color: var(--warn); font-size: 11px; flex: none; }
.tlm-tile.crit .tlm-warn-icon { color: var(--crit); }
.tlm-tile.warn .tlm-warn-icon, .tlm-tile.crit .tlm-warn-icon { display: inline; }
.tlm-tile .tlm-valrow { display: flex; align-items: baseline; gap: 4px; min-width: 0; }
.tlm-tile .tlm-val { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 27px; line-height: 1; color: var(--ink); white-space: nowrap; overflow: hidden; }
.tlm-tile.warn .tlm-val { color: var(--warn); }
.tlm-tile.crit .tlm-val { color: var(--crit); }
.tlm-tile .tlm-unit { font-size: 11px; color: var(--ink-3); flex: none; }
.tlm-tile .tlm-trend { margin-left: auto; font-size: 12px; color: var(--ink-3); flex: none; }
.tlm-charts { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
.tlm-chart-slot { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 4px; }
.tlm-chart-slot.tlm-eps-slot { gap: 4px; }
.tlm-chart {
  flex: 1; min-height: 0; position: relative;
  background: var(--surface-in); border-radius: 6px; overflow: hidden;
}
.tlm-chart canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.tlm-chart-title { position: absolute; top: 5px; left: 8px; font-size: 11px; color: var(--ink-3); pointer-events: none; z-index: 2; letter-spacing: .02em; }
`;
    document.head.appendChild(st);
  }

  /* ---------- テレメトリ・チャンネルカタログ (全32項目) ----------
     各チャンネル: { id, group, label, unit, dec, get(state)→number,
                    warn?(v), crit?(v), eps(トレンド無反応閾値), fmt?(v)→表示文字列 } */
  const CATALOG = [
    // EPS (電源系)
    { id: "busV",   group: "EPS",  label: "バス電圧",       unit: "V",    dec: 2, eps: 0.02, get: S => S.sat.telemetry.eps.busV,  warn: v => v < 27 },
    { id: "busI",   group: "EPS",  label: "バス電流",       unit: "A",    dec: 2, eps: 0.02, get: S => S.sat.telemetry.eps.busI },
    { id: "soc",    group: "EPS",  label: "バッテリSoC",    unit: "%",    dec: 0, eps: 0.3,  get: S => S.sat.telemetry.eps.soc,   warn: v => v < 40, crit: v => v < 25 },
    { id: "solarW", group: "EPS",  label: "太陽電力",       unit: "W",    dec: 0, eps: 1,    get: S => S.sat.telemetry.eps.solarW },
    // TCS (熱制御系)
    { id: "obcT",   group: "TCS",  label: "OBC温度",        unit: "°C",   dec: 1, eps: 0.15, get: S => S.sat.telemetry.tcs.obcT,  warn: v => v > 55 },
    { id: "commT",  group: "TCS",  label: "COMM温度",       unit: "°C",   dec: 1, eps: 0.15, get: S => S.sat.telemetry.tcs.commT, warn: v => v > 50 },
    { id: "panelT", group: "TCS",  label: "パネル温度",     unit: "°C",   dec: 1, eps: 0.2,  get: S => S.sat.telemetry.tcs.panelT },
    { id: "battT",  group: "TCS",  label: "バッテリ温度",   unit: "°C",   dec: 1, eps: 0.1,  get: S => S.sat.telemetry.tcs.battT, warn: v => v > 35 || v < 0 },
    // ADCS (姿勢制御系)
    { id: "rateX",  group: "ADCS", label: "角速度X",        unit: "°/s",  dec: 3, eps: 0.005, get: S => S.sat.telemetry.adcs.rateX },
    { id: "rateY",  group: "ADCS", label: "角速度Y",        unit: "°/s",  dec: 3, eps: 0.005, get: S => S.sat.telemetry.adcs.rateY },
    { id: "rateZ",  group: "ADCS", label: "角速度Z",        unit: "°/s",  dec: 3, eps: 0.005, get: S => S.sat.telemetry.adcs.rateZ },
    { id: "rateNorm", group: "ADCS", label: "角速度ノルム", unit: "°/s",  dec: 3, eps: 0.005, get: S => Math.hypot(S.sat.telemetry.adcs.rateX || 0, S.sat.telemetry.adcs.rateY || 0, S.sat.telemetry.adcs.rateZ || 0), warn: v => v > 0.25 },
    { id: "sunAngle", group: "ADCS", label: "太陽角",       unit: "°",    dec: 1, eps: 0.2,  get: S => S.sat.telemetry.adcs.sunAngle, warn: v => v > 30 },
    { id: "q0",     group: "ADCS", label: "クォータニオンq0", unit: "",   dec: 3, eps: 0.002, get: S => S.sat.telemetry.adcs.quat[0] },
    { id: "q1",     group: "ADCS", label: "クォータニオンq1", unit: "",   dec: 3, eps: 0.002, get: S => S.sat.telemetry.adcs.quat[1] },
    { id: "q2",     group: "ADCS", label: "クォータニオンq2", unit: "",   dec: 3, eps: 0.002, get: S => S.sat.telemetry.adcs.quat[2] },
    { id: "q3",     group: "ADCS", label: "クォータニオンq3", unit: "",   dec: 3, eps: 0.002, get: S => S.sat.telemetry.adcs.quat[3] },
    // CDH (データ処理系)
    { id: "cpu",    group: "CDH",  label: "CPU使用率",      unit: "%",    dec: 0, eps: 0.5,  get: S => S.sat.telemetry.cdh.cpu,  warn: v => v > 85 },
    { id: "mem",    group: "CDH",  label: "メモリ使用率",   unit: "%",    dec: 0, eps: 0.5,  get: S => S.sat.telemetry.cdh.mem,  warn: v => v > 80 },
    { id: "storagePct", group: "CDH", label: "ストレージ",  unit: "%",    dec: 0, eps: 0.3,  get: S => S.sat.telemetry.cdh.storagePct, warn: v => v > 90 },
    { id: "uptime", group: "CDH",  label: "稼働時間",       unit: "",     dec: 0, eps: 1,    get: S => S.sat.telemetry.cdh.uptime, fmt: v => SCC.fmt.duration(v) },
    { id: "bootCount", group: "CDH", label: "起動回数",     unit: "",     dec: 0, eps: 0.5,  get: S => S.sat.telemetry.cdh.bootCount },
    // COM (通信系)
    { id: "rssi",   group: "COM",  label: "RSSI",           unit: "dBm",  dec: 1, eps: 0.5,  get: S => S.sat.telemetry.com.rssi },
    { id: "snr",    group: "COM",  label: "SNR",            unit: "dB",   dec: 1, eps: 0.3,  get: S => S.sat.telemetry.com.snr },
    { id: "bitrate", group: "COM", label: "ビットレート",   unit: "Mbps", dec: 2, eps: 0.05, get: S => S.sat.telemetry.com.bitrate },
    { id: "agc",    group: "COM",  label: "AGC電圧",        unit: "V",    dec: 2, eps: 0.02, get: S => S.sat.telemetry.com.agc },
    { id: "dlrate", group: "COM",  label: "DLレート",       unit: "Mbps", dec: 2, eps: 0.05, get: S => S.downlink.rate },
    // DYN (軌道・力学)
    { id: "lat",    group: "DYN",  label: "緯度",           unit: "°",    dec: 2, eps: 0.05, get: S => S.sat.pos.lat },
    { id: "lon",    group: "DYN",  label: "経度",           unit: "°",    dec: 2, eps: 0.05, get: S => S.sat.pos.lon },
    { id: "alt",    group: "DYN",  label: "高度",           unit: "km",   dec: 1, eps: 0.1,  get: S => S.sat.pos.alt },
    { id: "vel",    group: "DYN",  label: "速度",           unit: "km/s", dec: 3, eps: 0.005, get: S => S.sat.vel },
    { id: "met",    group: "DYN",  label: "MET経過時間",    unit: "",     dec: 0, eps: 1,    get: S => S.met, fmt: v => SCC.fmt.duration(v) },
  ];
  const GROUP_LABEL = { EPS: "電源系 (EPS)", TCS: "熱制御系 (TCS)", ADCS: "姿勢制御系 (ADCS)", CDH: "データ処理系 (CDH)", COM: "通信系 (COM)", DYN: "軌道・力学 (DYN)" };
  const BY_ID = Object.fromEntries(CATALOG.map(c => [c.id, c]));
  const N_TILES = 6;
  const DEFAULT_TILES = ["busV", "soc", "obcT", "rateNorm", "rssi", "dlrate"];

  function loadTileSel() {
    try {
      const saved = JSON.parse(localStorage.getItem("scc.tlm.tiles") || "null");
      if (Array.isArray(saved) && saved.length === N_TILES && saved.every(id => BY_ID[id])) return saved;
    } catch (e) { /* ignore */ }
    return DEFAULT_TILES.slice();
  }
  function saveTileSel(sel) {
    try { localStorage.setItem("scc.tlm.tiles", JSON.stringify(sel)); } catch (e) { /* ignore */ }
  }
  let tileSel = loadTileSel();

  /* ---------- リングバッファ (simTime基準・直近30分、全32chを保持) ---------- */
  const WINDOW_MS = 30 * 60 * 1000;
  const MAX_PTS = 3000;
  let buf = [];

  function sampleFromState() {
    const s = { t: S.simTime.getTime() };
    for (const c of CATALOG) {
      let v;
      try { v = c.get(S); } catch (e) { v = NaN; }
      s[c.id] = (typeof v === "number") ? v : NaN;
    }
    // チャート用の別名 (既存チャート系列が参照)
    s.battI = s.busI;
    return s;
  }

  function pushSample() {
    const s = sampleFromState();
    if (buf.length) {
      const last = buf[buf.length - 1];
      if (s.t < last.t || s.t - last.t > WINDOW_MS) buf.length = 0; // 逆行/大ジャンプ → クリア
    }
    buf.push(s);
    const cutoff = s.t - WINDOW_MS;
    while (buf.length && buf[0].t < cutoff) buf.shift();
    if (buf.length > MAX_PTS) {
      const next = [];
      for (let i = 0; i < buf.length; i += 2) next.push(buf[i]);
      buf = next;
    }
  }

  /* ---------- ステータスタイル(プルダウンで32chから選択) ---------- */
  function trendArrow(cfg) {
    if (buf.length < 2) return "→";
    const cur = buf[buf.length - 1];
    const curV = cur[cfg.id];
    if (!isFinite(curV)) return "→";
    const targetT = cur.t - 60000;
    let old = buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= targetT) { old = buf[i]; break; }
    }
    const oldV = old[cfg.id];
    if (!isFinite(oldV)) return "→";
    const diff = curV - oldV;
    if (Math.abs(diff) < cfg.eps) return "→";
    return diff > 0 ? "↑" : "↓";
  }

  // 各タイルの選択プルダウン(グループ別 optgroup)
  function buildSelect(slot) {
    const sel = document.createElement("select");
    sel.className = "tlm-tile-sel";
    for (const g of Object.keys(GROUP_LABEL)) {
      const og = document.createElement("optgroup");
      og.label = GROUP_LABEL[g];
      for (const c of CATALOG.filter(x => x.group === g)) {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = `${c.label}${c.unit ? " [" + c.unit + "]" : ""}`;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = tileSel[slot];
    return sel;
  }

  function buildTiles(root) {
    const wrap = document.createElement("div");
    wrap.className = "tlm-tiles";
    const tiles = [];
    for (let i = 0; i < N_TILES; i++) {
      const tile = document.createElement("div");
      tile.className = "tlm-tile";
      const sel = buildSelect(i);
      tile.innerHTML = `
        <div class="tlm-lbl"><span class="tlm-lbl-txt"></span><span class="tlm-warn-icon">⚠</span></div>
        <div class="tlm-valrow">
          <span class="tlm-val">---</span>
          <span class="tlm-unit"></span>
          <span class="tlm-trend">→</span>
        </div>`;
      tile.querySelector(".tlm-lbl").insertBefore(sel, tile.querySelector(".tlm-warn-icon"));
      wrap.appendChild(tile);
      const ref = {
        root: tile, sel,
        lbl: tile.querySelector(".tlm-lbl-txt"),
        val: tile.querySelector(".tlm-val"),
        unit: tile.querySelector(".tlm-unit"),
        trend: tile.querySelector(".tlm-trend"),
      };
      sel.addEventListener("change", () => {
        tileSel[i] = sel.value;
        saveTileSel(tileSel);
        applyTileMeta(ref, i);
        renderTiles(tilesRef);
      });
      applyTileMeta(ref, i);
      tiles.push(ref);
    }
    root.appendChild(wrap);
    tilesRef = tiles;
    return tiles;
  }
  let tilesRef = null;

  // ラベル(プルダウンで表示するので非表示)・単位を選択chに合わせる
  function applyTileMeta(ref, i) {
    const cfg = BY_ID[tileSel[i]];
    ref.unit.textContent = cfg.unit;
    ref.lbl.textContent = ""; // ラベルはプルダウン自身が兼ねる
  }

  function renderTiles(refs) {
    if (!buf.length || !refs) return;
    const cur = buf[buf.length - 1];
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      const cfg = BY_ID[tileSel[i]];
      const v = cur[cfg.id];
      r.val.textContent = !isFinite(v) ? "---" : (cfg.fmt ? cfg.fmt(v) : v.toFixed(cfg.dec));
      r.trend.textContent = trendArrow(cfg);
      const warn = (cfg.warn && isFinite(v)) ? !!cfg.warn(v) : false;
      const crit = (cfg.crit && isFinite(v)) ? !!cfg.crit(v) : false;
      r.root.classList.toggle("warn", warn && !crit);
      r.root.classList.toggle("crit", crit);
    }
  }

  /* ---------- チャート共通ユーティリティ ---------- */
  function niceNum(range, round) {
    if (range <= 0) range = 1;
    const exp = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    let nf;
    if (round) {
      if (frac < 1.5) nf = 1; else if (frac < 3) nf = 2; else if (frac < 7) nf = 5; else nf = 10;
    } else {
      if (frac <= 1) nf = 1; else if (frac <= 2) nf = 2; else if (frac <= 5) nf = 5; else nf = 10;
    }
    return nf * Math.pow(10, exp);
  }
  function niceScale(min, max, maxTicks) {
    if (!isFinite(min) || !isFinite(max) || min === max) { min = (isFinite(min) ? min : 0) - 1; max = (isFinite(max) ? max : 0) + 1; }
    const range = niceNum(max - min, false);
    const step = niceNum(range / (maxTicks - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    return { min: niceMin, max: niceMax, step };
  }
  function pad2(n) { return String(Math.floor(Math.abs(n))).padStart(2, "0"); }
  function hhmm(ms) { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }

  /* ---------- チャート生成 ---------- */
  function makeChart(container, opts) {
    // opts: { title, unit, series:[{label,color,get}], zeroLine, fallback:{min,max} }
    const titleEl = document.createElement("div");
    titleEl.className = "tlm-chart-title";
    titleEl.textContent = opts.title;
    container.appendChild(titleEl);
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);

    const chart = { hoverPx: null, domain: null };
    const canvasCtx = canvas.getContext("2d");
    // SCC.bindCanvas invokes the draw callback synchronously during setup
    // (before it returns), so render() must not depend on its return value —
    // read size/ctx straight from the canvas element instead.
    SCC.bindCanvas(canvas, () => render());

    function computeDomain() {
      const xMax = buf.length ? buf[buf.length - 1].t : S.simTime.getTime();
      const xMin = xMax - WINDOW_MS;
      let yMin = Infinity, yMax = -Infinity;
      for (const s of buf) {
        for (const ser of opts.series) {
          const v = ser.get(s);
          if (isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
        }
      }
      if (!isFinite(yMin) || !isFinite(yMax)) {
        yMin = opts.fallback ? opts.fallback.min : 0;
        yMax = opts.fallback ? opts.fallback.max : 1;
      }
      if (opts.zeroLine) { if (yMin > 0) yMin = 0; if (yMax < 0) yMax = 0; }
      const pad = (yMax - yMin) * 0.1 || 1;
      const sc = niceScale(yMin - pad, yMax + pad, 4);
      return { xMin, xMax, yMin: sc.min, yMax: sc.max, yStep: sc.step };
    }

    function render() {
      const ctx = canvasCtx;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      if (w < 2 || h < 2) return;
      const pal = palette();
      const dom = computeDomain();
      chart.domain = dom;
      const padL = 42, padR = 46, padT = 22, padB = 16;
      const plotW = Math.max(1, w - padL - padR), plotH = Math.max(1, h - padT - padB);
      const xToPx = t => padL + ((t - dom.xMin) / (dom.xMax - dom.xMin || 1)) * plotW;
      const yToPx = v => padT + plotH - ((v - dom.yMin) / (dom.yMax - dom.yMin || 1)) * plotH;
      chart._xToPx = xToPx; chart._yToPx = yToPx; chart._padL = padL; chart._padR = padR; chart._w = w; chart._h = h;

      // Y グリッド + ラベル
      ctx.strokeStyle = pal.hair; ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = pal.ink3;
      ctx.textBaseline = "middle";
      for (let v = dom.yMin; v <= dom.yMax + 1e-9; v += dom.yStep) {
        const py = Math.round(yToPx(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
        if (py > padT + 2) { // タイトルと重ならないよう最上段ラベルは省略
          ctx.textAlign = "right";
          ctx.fillText(fmtAxisVal(v), padL - 6, py);
        }
      }

      // 0線 強調(ADCS用)
      if (opts.zeroLine && dom.yMin < 0 && dom.yMax > 0) {
        ctx.strokeStyle = pal.ink3; ctx.lineWidth = 1;
        const py = Math.round(yToPx(0)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      }

      // X 軸 目盛 (10分ごと)
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const tickStep = 10 * 60 * 1000;
      const firstTick = Math.ceil(dom.xMin / tickStep) * tickStep;
      for (let t = firstTick; t <= dom.xMax; t += tickStep) {
        const px = Math.round(xToPx(t)) + 0.5;
        ctx.strokeStyle = pal.hair;
        ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, h - padB); ctx.stroke();
        ctx.fillStyle = pal.ink3;
        ctx.fillText(hhmm(t), px, h - padB + 3);
      }

      // 系列描画 + 直接ラベル
      const labelPositions = [];
      for (const ser of opts.series) {
        ctx.strokeStyle = ser.color; ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false, lastPxI = null;
        let lastFinitePx = null, lastFinitePy = null;
        for (const s of buf) {
          const v = ser.get(s);
          if (!isFinite(v)) { started = false; lastPxI = null; continue; }
          const px = xToPx(s.t), py = yToPx(v);
          const pxi = Math.round(px);
          lastFinitePx = px; lastFinitePy = py;
          if (started && pxi === lastPxI) continue; // 画素間引き
          lastPxI = pxi;
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (lastFinitePx !== null) labelPositions.push({ ser, x: lastFinitePx, y: lastFinitePy });
      }
      // ラベル重なり回避(y昇順に最小間隔12pxを確保)
      labelPositions.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labelPositions.length; i++) {
        if (labelPositions[i].y < labelPositions[i - 1].y + 12) labelPositions[i].y = labelPositions[i - 1].y + 12;
      }
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const lp of labelPositions) {
        let lx = lp.x + 5;
        let ly = Math.min(Math.max(lp.y, padT + 6), h - padB - 6);
        if (lx + 34 > w) lx = w - 34;
        ctx.fillStyle = lp.ser.color;
        ctx.fillText(lp.ser.label, lx, ly);
      }

      // クロスヘア
      if (chart.hoverPx !== null) {
        const px = Math.min(Math.max(chart.hoverPx, padL), w - padR);
        ctx.strokeStyle = pal.ink2; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, padT); ctx.lineTo(Math.round(px) + 0.5, h - padB); ctx.stroke();
      }
    }

    function fmtAxisVal(v) {
      const av = Math.abs(v);
      const digits = av !== 0 && av < 1 ? 3 : (av < 10 ? 2 : (av < 1000 ? 1 : 0));
      return v.toFixed(digits);
    }

    function nearestSample(hoverPx) {
      if (!buf.length || !chart.domain) return null;
      const dom = chart.domain;
      const t = dom.xMin + ((hoverPx - 42) / Math.max(1, (chart._w - 42 - 46))) * (dom.xMax - dom.xMin);
      let lo = 0, hi = buf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (buf[mid].t < t) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(buf[lo - 1].t - t) < Math.abs(buf[lo].t - t)) lo -= 1;
      return buf[lo];
    }

    canvas.addEventListener("mousemove", e => {
      const r = canvas.getBoundingClientRect();
      chart.hoverPx = e.clientX - r.left;
      render();
      const s = nearestSample(chart.hoverPx);
      if (s) {
        let html = `<div class="tt-title">${SCC.fmt.hms(new Date(s.t))} UTC</div>`;
        for (const ser of opts.series) {
          const v = ser.get(s);
          const vs = isFinite(v) ? v.toFixed(2) + (opts.unit ? " " + opts.unit : "") : "---";
          html += `<div class="tt-row"><span><span style="color:${ser.color}">●</span> ${ser.label}</span><b>${vs}</b></div>`;
        }
        SCC.tooltip.show(html, e.clientX, e.clientY);
      }
    });
    canvas.addEventListener("mouseleave", () => {
      chart.hoverPx = null;
      render();
      SCC.tooltip.hide();
    });

    chart.render = render;
    return chart;
  }

  /* ---------- チャート構成 ---------- */
  function buildCharts(root) {
    const wrap = document.createElement("div");
    wrap.className = "tlm-charts";
    root.appendChild(wrap);

    const charts = [];

    // 1. EPS — 上下2段(バスV / バッテリ電流)、x軸共有
    const epsSlot = document.createElement("div");
    epsSlot.className = "tlm-chart-slot tlm-eps-slot";
    const epsVCont = document.createElement("div"); epsVCont.className = "tlm-chart";
    const epsICont = document.createElement("div"); epsICont.className = "tlm-chart";
    epsSlot.appendChild(epsVCont); epsSlot.appendChild(epsICont);
    wrap.appendChild(epsSlot);
    charts.push(makeChart(epsVCont, {
      title: "EPS — バスV [V]", unit: "V",
      series: [{ label: "busV", color: SERIES.s1, get: s => s.busV }],
      fallback: { min: 25, max: 30 },
    }));
    charts.push(makeChart(epsICont, {
      title: "EPS — バッテリ電流 [A]", unit: "A",
      series: [{ label: "battI", color: SERIES.s2, get: s => s.battI }],
      fallback: { min: 0, max: 3 },
    }));

    // 2. 温度
    const tempSlot = document.createElement("div"); tempSlot.className = "tlm-chart-slot";
    const tempCont = document.createElement("div"); tempCont.className = "tlm-chart";
    tempSlot.appendChild(tempCont); wrap.appendChild(tempSlot);
    charts.push(makeChart(tempCont, {
      title: "TCS — 温度 [°C]", unit: "°C",
      series: [
        { label: "OBC", color: SERIES.s1, get: s => s.obcT },
        { label: "COMM", color: SERIES.s2, get: s => s.commT },
        { label: "PANEL", color: SERIES.s3, get: s => s.panelT },
        { label: "BATT", color: SERIES.s4, get: s => s.battT },
      ],
      fallback: { min: -20, max: 40 },
    }));

    // 3. ADCS 角速度
    const rateSlot = document.createElement("div"); rateSlot.className = "tlm-chart-slot";
    const rateCont = document.createElement("div"); rateCont.className = "tlm-chart";
    rateSlot.appendChild(rateCont); wrap.appendChild(rateSlot);
    charts.push(makeChart(rateCont, {
      title: "ADCS — 角速度 [°/s]", unit: "°/s", zeroLine: true,
      series: [
        { label: "X", color: SERIES.s1, get: s => s.rateX },
        { label: "Y", color: SERIES.s2, get: s => s.rateY },
        { label: "Z", color: SERIES.s3, get: s => s.rateZ },
      ],
      fallback: { min: -0.2, max: 0.2 },
    }));

    // 4. COM RSSI
    const rssiSlot = document.createElement("div"); rssiSlot.className = "tlm-chart-slot";
    const rssiCont = document.createElement("div"); rssiCont.className = "tlm-chart";
    rssiSlot.appendChild(rssiCont); wrap.appendChild(rssiSlot);
    charts.push(makeChart(rssiCont, {
      title: "COM — RSSI [dBm]", unit: "dBm",
      series: [{ label: "RSSI", color: SERIES.s1, get: s => s.rssi }],
      fallback: { min: -110, max: -60 },
    }));

    return charts;
  }

  /* ---------- init ---------- */
  function init() {
    const root = document.getElementById("tlm-body");
    if (!root) return;
    injectStyle();
    root.innerHTML = "";

    const tileRefs = buildTiles(root);
    const charts = buildCharts(root);

    SCC.bus.on("tick", () => {
      pushSample();
      renderTiles(tileRefs);
      for (const c of charts) c.render();
    });
  }

  SCC.panels.tlm = { init };
})();
