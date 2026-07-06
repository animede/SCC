/* SCC panels — スカイプロット+追尾制御 (panel-sky) / アンテナ統合管理 (panel-farm)
   SPEC.md §5.2, §5.3 実装。データは SCC.state を読み取り専用で参照し、操作は SCC.ops のみ経由する。 */
(function () {
  "use strict";

  const S = SCC.state, bus = SCC.bus, fmt = SCC.fmt, orbit = SCC.orbit;
  const D2R = Math.PI / 180;

  // css/main.css :root トークンのミラー(canvas 描画用。正は css/main.css)
  const C = {
    ink: "#e8eaed", ink2: "#9aa0a8", ink3: "#6b7076",
    hairline: "#262a30", hairline2: "#31363e",
    s1: "#3987e5", s3: "#c98500",
    ok: "#0ca30c", warn: "#fab219", serious: "#ec835a",
  };

  const clamp01 = v => Math.min(1, Math.max(0, v));
  const modeBadgeClass = mode => ({
    TRACKING: "badge--ok",
    SLEWING: "badge--warn",
    MAINT: "badge--serious",
  }[mode] || "");

  function stationOf(id) { return S.stations.find(s => s.id === id); }
  function activePassOf(id) { return S.passes.find(p => p.station === id && p.status === "active") || null; }
  function nextPassOf(id) { return S.passes.find(p => p.station === id && p.status === "upcoming") || null; }

  /* ---------- 共有スタイル注入(sky-body / farm-body 双方が使用。一度だけ) ---------- */
  function injectStyle() {
    if (document.getElementById("scc-antenna-style")) return;
    const st = document.createElement("style");
    st.id = "scc-antenna-style";
    st.textContent = `
      /* #sky-body(.panel__body)自身に付与するクラス。.panel__body が flex:1 で
         パネルを埋めるため、ここでは配置を上書きしない(absoluteにするとビューポート基準に逃げる) */
      .sky-wrap { display:flex; gap:12px; padding:10px 12px; }
      .sky-plotcol { flex:none; height:100%; aspect-ratio:1/1; position:relative;
        background:var(--surface-in); border:1px solid var(--hairline); border-radius:8px; overflow:hidden; }
      .sky-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
      .sky-ctrlcol { flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; overflow-y:auto; padding-right:2px; }
      .sky-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
      .sky-head-id { font-weight:700; font-size:14px; }
      .sky-head-sub { font-size:11px; color:var(--ink-3); margin-top:2px; }
      .sky-auto-btn { width:100%; }
      .sky-big-readout { display:flex; gap:20px; padding:8px 0; border-top:1px solid var(--hairline); border-bottom:1px solid var(--hairline); }
      .sky-big-item { display:flex; flex-direction:column; gap:2px; }
      .sky-big-lbl { font-size:10px; color:var(--ink-3); letter-spacing:.1em; }
      .sky-big-val { font-size:clamp(17px, 1.35vw, 26px); }
      .sky-sub-readout { display:flex; justify-content:space-between; gap:8px; font-size:11px; color:var(--ink-2); }
      .sky-sub-readout .k { color:var(--ink-3); margin-right:5px; }
      .sky-manual { display:flex; align-items:flex-end; gap:8px; }
      .sky-manual label { display:flex; flex-direction:column; gap:3px; font-size:10px; color:var(--ink-3); letter-spacing:.06em; }
      .sky-manual input { width:74px; }
      .sky-next { margin-top:auto; padding-top:8px; border-top:1px solid var(--hairline); display:flex; flex-direction:column; gap:4px; }
      .sky-next-row { display:flex; justify-content:space-between; font-size:11px; color:var(--ink-2); }
      .sky-next-row b { color:var(--ink); font-weight:500; }

      .farm-grid { display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:minmax(0,1fr); gap:8px; height:100%; }
      .farm-card { background:var(--surface-in); border:1px solid var(--hairline); border-radius:8px;
        padding:10px 12px; display:flex; flex-direction:column; gap:7px; cursor:pointer;
        transition:border-color .15s, background .15s; min-width:0; min-height:0; }
      .farm-card:hover { background:var(--surface-hi); }
      .farm-card.sel { border-color:var(--s1); }
      .farm-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
      .farm-card-id { font-weight:700; font-size:13px; }
      .farm-card-sub { font-size:11px; color:var(--ink-3); margin-top:2px; }
      .farm-card-azel { font-size:clamp(13px, 1.05vw, 20px); color:var(--ink); white-space:nowrap; }
      .farm-card-bars { display:flex; flex-direction:column; gap:5px; }
      .farm-bar-row { display:flex; align-items:center; gap:6px; font-size:10px; color:var(--ink-3); }
      .farm-bar-row .farm-bar-lbl { width:32px; flex:none; }
      .farm-bar-row .bar { flex:1; }
      .farm-bar-val { width:66px; flex:none; text-align:right; font-size:11px; color:var(--ink-2); }
      .farm-card-bottom { display:flex; align-items:center; justify-content:space-between; margin-top:auto; font-size:11px; }
      .farm-lock { display:flex; align-items:center; gap:5px; color:var(--ink-3); font-weight:600; letter-spacing:.06em; }
      .farm-lock-dot { width:8px; height:8px; border-radius:50%; background:var(--ink-3); display:inline-block; }
      .farm-lock.on { color:var(--ok); }
      .farm-lock.on .farm-lock-dot { background:var(--ok); }
      .farm-next { color:var(--ink-2); }
    `;
    document.head.appendChild(st);
  }

  /* ================= 5.2 スカイプロット+追尾制御 ================= */
  SCC.panels.sky = {
    init() {
      injectStyle();
      const body = document.getElementById("sky-body");
      body.classList.add("sky-wrap");
      body.innerHTML = `
        <div class="sky-plotcol"><canvas class="sky-canvas"></canvas></div>
        <div class="sky-ctrlcol">
          <div class="sky-head">
            <div>
              <div class="sky-head-id" id="sky-id">---</div>
              <div class="sky-head-sub" id="sky-sub">---</div>
            </div>
            <span class="badge" id="sky-mode-badge">---</span>
          </div>
          <button type="button" class="btn sky-auto-btn" id="sky-auto-btn">AUTO TRACK</button>
          <div class="sky-big-readout">
            <div class="sky-big-item"><span class="sky-big-lbl">AZ</span><span class="sky-big-val readout" id="sky-az-val">---</span></div>
            <div class="sky-big-item"><span class="sky-big-lbl">EL</span><span class="sky-big-val readout" id="sky-el-val">---</span></div>
          </div>
          <div class="sky-sub-readout">
            <span><span class="k">CMD</span><span class="readout" id="sky-cmd-val">---</span></span>
            <span><span class="k">&Delta;Az/El</span><span class="readout" id="sky-err-val">---</span></span>
          </div>
          <div class="sky-manual">
            <label>AZ<input type="number" id="sky-in-az" min="0" max="360" step="0.1"></label>
            <label>EL<input type="number" id="sky-in-el" min="0" max="90" step="0.1"></label>
            <button type="button" class="btn btn--sm" id="sky-slew-btn">SLEW</button>
          </div>
          <div class="sky-next">
            <div class="sky-next-row"><span>NEXT AOS</span><b class="readout" id="sky-next-t">---</b></div>
            <div class="sky-next-row"><span>MAX EL</span><b class="readout" id="sky-next-maxel">---</b></div>
            <div class="sky-next-row"><span>DURATION</span><b class="readout" id="sky-next-dur">---</b></div>
          </div>
        </div>
      `;

      let selected = (S.stations[0] && S.stations[0].id) || "GS-TKY";
      const sel = document.getElementById("sky-station");
      sel.innerHTML = "";
      for (const st of S.stations) {
        const opt = document.createElement("option");
        opt.value = st.id;
        opt.textContent = `${st.id} — ${st.name}`;
        sel.appendChild(opt);
      }
      sel.value = selected;
      sel.addEventListener("change", () => bus.emit("select-station", sel.value));
      bus.on("select-station", id => {
        if (!stationOf(id)) return;
        selected = id;
        if (sel.value !== id) sel.value = id;
        draw();
      });

      const idEl = document.getElementById("sky-id");
      const subEl = document.getElementById("sky-sub");
      const modeBadge = document.getElementById("sky-mode-badge");
      const autoBtn = document.getElementById("sky-auto-btn");
      const azVal = document.getElementById("sky-az-val");
      const elVal = document.getElementById("sky-el-val");
      const cmdVal = document.getElementById("sky-cmd-val");
      const errVal = document.getElementById("sky-err-val");
      const inAz = document.getElementById("sky-in-az");
      const inEl = document.getElementById("sky-in-el");
      const slewBtn = document.getElementById("sky-slew-btn");
      const nextT = document.getElementById("sky-next-t");
      const nextMaxEl = document.getElementById("sky-next-maxel");
      const nextDur = document.getElementById("sky-next-dur");

      autoBtn.addEventListener("click", () => {
        const st = stationOf(selected);
        if (st) SCC.ops.setAutoTrack(selected, !st.antenna.autoTrack);
      });
      slewBtn.addEventListener("click", () => {
        const az = parseFloat(inAz.value), el = parseFloat(inEl.value);
        if (isFinite(az) && isFinite(el)) SCC.ops.slewAntenna(selected, az, el);
      });

      const canvas = body.querySelector(".sky-canvas");
      const cvs = SCC.bindCanvas(canvas, () => draw());

      function azElToXY(cx, cy, R, az, el) {
        const r = clamp01((90 - el) / 90) * R;
        return { x: cx + r * Math.sin(az * D2R), y: cy - r * Math.cos(az * D2R) };
      }

      function draw() {
        const w = cvs.w(), h = cvs.h();
        const ctx = cvs.ctx;
        ctx.clearRect(0, 0, w, h);
        if (w < 4 || h < 4) return;
        const size = Math.min(w, h);
        const cx = w / 2, cy = h / 2;
        const R = size / 2 - 22;
        const st = stationOf(selected);

        // 同心円 el = 60/30/0
        ctx.lineWidth = 1;
        for (const el of [60, 30, 0]) {
          const r = clamp01((90 - el) / 90) * R;
          ctx.strokeStyle = el === 0 ? C.hairline2 : C.hairline;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
          if (el > 0) {
            ctx.fillStyle = C.ink3;
            ctx.font = "10px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(el + "°", cx + r * Math.sin(Math.PI / 4) + 3, cy - r * Math.cos(Math.PI / 4));
          }
        }
        // el=5° 運用最低仰角(破線・薄)
        {
          const r = clamp01((90 - orbit.MIN_EL) / 90) * R;
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = C.hairline2;
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        // 十字線
        ctx.strokeStyle = C.hairline;
        ctx.beginPath();
        ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
        ctx.stroke();
        // 方位ラベル
        ctx.fillStyle = C.ink2;
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("N", cx, cy - R - 11);
        ctx.fillText("S", cx, cy + R + 11);
        ctx.textAlign = "left"; ctx.fillText("E", cx + R + 6, cy);
        ctx.textAlign = "right"; ctx.fillText("W", cx - R - 6, cy);

        if (!st) return;

        // 選択局のパス軌跡(active優先、なければ次パス)
        const pass = activePassOf(st.id) || nextPassOf(st.id);
        if (pass) {
          const N = 60;
          let maxElPt = null, maxElV = -90;
          ctx.save();
          ctx.strokeStyle = C.s1;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          let drawing = false;
          for (let i = 0; i <= N; i++) {
            const t = new Date(pass.aos.getTime() + (pass.los.getTime() - pass.aos.getTime()) * i / N);
            const la = orbit.lookAngles(st, t);
            if (la.el >= 0) {
              const p = azElToXY(cx, cy, R, la.az, la.el);
              if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; } else ctx.lineTo(p.x, p.y);
              if (la.el > maxElV) { maxElV = la.el; maxElPt = p; }
            } else drawing = false;
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          if (maxElPt) {
            ctx.strokeStyle = C.s1;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(maxElPt.x, maxElPt.y, 3.5, 0, Math.PI * 2);
            ctx.stroke();
          }

          // AOS/LOS マーカー+方位ラベル
          const drawEnd = (date, label) => {
            const la = orbit.lookAngles(st, date);
            const elc = Math.max(0, la.el);
            const p = azElToXY(cx, cy, R, la.az, elc);
            ctx.fillStyle = C.s1;
            ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
            const dx = p.x - cx, dy = p.y - cy;
            const dist = Math.hypot(dx, dy) || 1;
            const lx = p.x + (dx / dist) * 14, ly = p.y + (dy / dist) * 14;
            ctx.fillStyle = C.ink2;
            ctx.font = "10px system-ui, sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(`${label} ${la.az.toFixed(0)}°`, lx, ly);
          };
          drawEnd(pass.aos, "AOS");
          drawEnd(pass.los, "LOS");

          // 衛星現在位置(可視中)
          const cur = orbit.lookAngles(st, S.simTime);
          if (cur.el > 0) {
            const p = azElToXY(cx, cy, R, cur.az, cur.el);
            ctx.fillStyle = C.s1;
            ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
          }
        }

        // アンテナ現在指向(黄十字レティクル)
        const a = st.antenna;
        if (isFinite(a.el) && a.el >= 0 && a.el <= 90 && isFinite(a.az)) {
          const p = azElToXY(cx, cy, R, a.az, a.el);
          ctx.strokeStyle = C.s3;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x - 10, p.y); ctx.lineTo(p.x + 10, p.y);
          ctx.moveTo(p.x, p.y - 10); ctx.lineTo(p.x, p.y + 10);
          ctx.stroke();
        }
      }

      function updateControls() {
        const st = stationOf(selected);
        if (!st) return;
        const a = st.antenna;

        idEl.textContent = st.id;
        subEl.textContent = `${st.name} · ${st.band} · ${st.dish}`;
        modeBadge.textContent = a.mode;
        modeBadge.className = "badge" + (modeBadgeClass(a.mode) ? " " + modeBadgeClass(a.mode) : "");

        autoBtn.textContent = "AUTO TRACK " + (a.autoTrack ? "ON" : "OFF");
        autoBtn.className = "btn sky-auto-btn" + (a.autoTrack ? " btn--primary" : "");

        azVal.textContent = fmt.deg(a.az, 1);
        elVal.textContent = fmt.deg(a.el, 1);
        cmdVal.textContent = `${fmt.deg(a.cmdAz, 1)} / ${fmt.deg(a.cmdEl, 1)}`;

        const look = orbit.lookAngles(st, S.simTime);
        if (look.el > 0 && isFinite(a.az) && isFinite(a.el)) {
          const dAz = ((look.az - a.az + 540) % 360) - 180;
          const dEl = look.el - a.el;
          errVal.textContent = `${dAz >= 0 ? "+" : ""}${dAz.toFixed(1)}° / ${dEl >= 0 ? "+" : ""}${dEl.toFixed(1)}°`;
        } else {
          errVal.textContent = "---";
        }

        inAz.disabled = a.autoTrack;
        inEl.disabled = a.autoTrack;
        slewBtn.disabled = a.autoTrack;

        const act = activePassOf(st.id);
        const nxt = nextPassOf(st.id);
        if (act) {
          nextT.textContent = "PASS " + fmt.countdown((act.los.getTime() - S.simTime.getTime()) / 1000);
          nextT.style.color = "var(--ok)";
          nextMaxEl.textContent = fmt.deg(act.maxEl, 0);
          nextDur.textContent = fmt.duration((act.los.getTime() - act.aos.getTime()) / 1000);
        } else if (nxt) {
          nextT.textContent = "T-" + fmt.countdown((nxt.aos.getTime() - S.simTime.getTime()) / 1000);
          nextT.style.color = "";
          nextMaxEl.textContent = fmt.deg(nxt.maxEl, 0);
          nextDur.textContent = fmt.duration((nxt.los.getTime() - nxt.aos.getTime()) / 1000);
        } else {
          nextT.textContent = "---"; nextT.style.color = "";
          nextMaxEl.textContent = "---";
          nextDur.textContent = "---";
        }
      }

      bus.on("tick", () => { updateControls(); draw(); });
      updateControls();
      draw();
    },
  };

  /* ================= 5.3 アンテナ統合管理 ================= */
  SCC.panels.farm = {
    init() {
      injectStyle();
      const body = document.getElementById("farm-body");
      body.classList.add("farm-grid");
      body.innerHTML = "";

      let selected = (S.stations[0] && S.stations[0].id) || null;
      const cards = {};

      for (const st of S.stations) {
        const card = document.createElement("div");
        card.className = "farm-card" + (st.id === selected ? " sel" : "");
        card.innerHTML = `
          <div class="farm-card-top">
            <div>
              <div class="farm-card-id"></div>
              <div class="farm-card-sub"></div>
            </div>
            <span class="badge" data-r="mode">---</span>
          </div>
          <div class="farm-card-azel readout" data-r="azel">AZ ---° EL ---°</div>
          <div class="farm-card-bars">
            <div class="farm-bar-row"><span class="farm-bar-lbl">RSSI</span><div class="bar"><i data-r="rssiBar" style="width:0%"></i></div><span class="farm-bar-val readout" data-r="rssiVal">---</span></div>
            <div class="farm-bar-row"><span class="farm-bar-lbl">SNR</span><div class="bar"><i data-r="snrBar" style="width:0%"></i></div><span class="farm-bar-val readout" data-r="snrVal">---</span></div>
          </div>
          <div class="farm-card-bottom">
            <span class="farm-lock" data-r="lockWrap"><i class="farm-lock-dot"></i>LOCK</span>
            <span class="farm-next readout" data-r="next">---</span>
          </div>
        `;
        card.querySelector(".farm-card-id").textContent = st.id;
        card.querySelector(".farm-card-sub").textContent = `${st.name} · ${st.dish} ${st.band}`;
        card.addEventListener("click", () => bus.emit("select-station", st.id));
        body.appendChild(card);

        cards[st.id] = {
          card,
          mode: card.querySelector('[data-r="mode"]'),
          azel: card.querySelector('[data-r="azel"]'),
          rssiBar: card.querySelector('[data-r="rssiBar"]'),
          rssiVal: card.querySelector('[data-r="rssiVal"]'),
          snrBar: card.querySelector('[data-r="snrBar"]'),
          snrVal: card.querySelector('[data-r="snrVal"]'),
          lockWrap: card.querySelector('[data-r="lockWrap"]'),
          next: card.querySelector('[data-r="next"]'),
        };
      }

      bus.on("select-station", id => {
        if (!cards[id]) return;
        selected = id;
        for (const sid in cards) cards[sid].card.classList.toggle("sel", sid === id);
      });

      function update() {
        for (const st of S.stations) {
          const r = cards[st.id];
          const a = st.antenna;

          r.mode.textContent = a.mode;
          r.mode.className = "badge" + (modeBadgeClass(a.mode) ? " " + modeBadgeClass(a.mode) : "");

          r.azel.textContent = `AZ ${fmt.deg(a.az, 1)} EL ${fmt.deg(a.el, 1)}`;

          const rssiPct = isFinite(a.rssi) ? clamp01((a.rssi + 120) / 50) * 100 : 0;
          r.rssiBar.style.width = rssiPct + "%";
          r.rssiVal.textContent = isFinite(a.rssi) ? a.rssi.toFixed(1) + "dBm" : "---";

          const snrPct = isFinite(a.snr) ? clamp01(a.snr / 35) * 100 : 0;
          r.snrBar.style.width = snrPct + "%";
          r.snrVal.textContent = isFinite(a.snr) ? a.snr.toFixed(1) + "dB" : "---";

          r.lockWrap.classList.toggle("on", !!a.lock);

          const act = activePassOf(st.id);
          const nxt = nextPassOf(st.id);
          if (act) {
            r.next.textContent = "PASS " + fmt.countdown((act.los.getTime() - S.simTime.getTime()) / 1000);
            r.next.style.color = "var(--ok)";
          } else if (nxt) {
            r.next.textContent = "T-" + fmt.countdown((nxt.aos.getTime() - S.simTime.getTime()) / 1000);
            r.next.style.color = "";
          } else {
            r.next.textContent = "---";
            r.next.style.color = "";
          }
        }
      }

      bus.on("tick", update);
      update();
    },
  };
})();
