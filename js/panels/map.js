/* SCC panel — 世界地図 (panel-map)
   等距円筒図法。SPEC.md §5.1 準拠。
   契約: SCC.bus / SCC.state / SCC.orbit / SCC.geo.coastlines のみに依存。 */
(function () {
  "use strict";

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // デザイントークン(css/main.css :root の値をミラー。canvas は var() を解釈できないため直値化)
  const COL = {
    surfaceIn: "#101216",
    hairline: "#262a30",
    hairline2: "#31363e",
    ink: "#e8eaed",
    ink2: "#9aa0a8",
    ink3: "#6b7076",
    ok: "#0ca30c",
    s1: "#3987e5",
    coast: "#3a4048",
  };
  const FONT_SANS = '11px system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif';
  const FONT_MONO = '11px ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Noto Sans Mono", monospace';

  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

  function init() {
    const canvas = document.getElementById("map-canvas");
    const readout = document.getElementById("map-readout");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const coastCanvas = document.createElement("canvas");
    let mapRect = null; // {x,y,w,h} 現在のレターボックス地図矩形 (CSS px)

    function getCssSize() {
      const r = canvas.getBoundingClientRect();
      return [r.width, r.height];
    }

    // 縦長パネル: 2:1 の地図を上下センタリングでレターボックス配置、余白16px
    function computeMapRect(W, H) {
      const pad = 16;
      const availW = Math.max(0, W - pad * 2);
      const availH = Math.max(0, H - pad * 2);
      let mw = availW, mh = mw / 2;
      if (mh > availH) { mh = availH; mw = mh * 2; }
      mw = Math.max(0, mw); mh = Math.max(0, mh);
      return { x: (W - mw) / 2, y: (H - mh) / 2, w: mw, h: mh };
    }

    function project(lat, lon, rect) {
      const x = rect.x + (lon + 180) / 360 * rect.w;
      const y = rect.y + (90 - lat) / 180 * rect.h;
      return [x, y];
    }

    /* ---------- 海岸線キャッシュ(リサイズ時のみ再生成) ---------- */
    function rebuildCoastCache(rect) {
      const dpr = window.devicePixelRatio || 1;
      coastCanvas.width = Math.max(1, Math.round(rect.w * dpr));
      coastCanvas.height = Math.max(1, Math.round(rect.h * dpr));
      const cctx = coastCanvas.getContext("2d");
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.clearRect(0, 0, rect.w, rect.h);
      cctx.strokeStyle = COL.coast;
      cctx.lineWidth = 1;
      cctx.beginPath();
      const lines = (SCC.geo && SCC.geo.coastlines) || [];
      for (const poly of lines) {
        for (let i = 0; i < poly.length; i++) {
          const lat = poly[i][0], lon = poly[i][1];
          if (!isFinite(lat) || !isFinite(lon)) continue;
          const x = (lon + 180) / 360 * rect.w;
          const y = (90 - lat) / 180 * rect.h;
          if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
        }
      }
      cctx.stroke();
    }

    function drawCoastlines(rect) {
      if (!coastCanvas.width) return;
      ctx.drawImage(coastCanvas, 0, 0, coastCanvas.width, coastCanvas.height, rect.x, rect.y, rect.w, rect.h);
    }

    /* ---------- 経緯度グリッド ---------- */
    function drawGrid(rect) {
      ctx.strokeStyle = COL.hairline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += 30) {
        const x = rect.x + (lon + 180) / 360 * rect.w;
        ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h);
      }
      for (let lat = -90; lat <= 90; lat += 30) {
        const y = rect.y + (90 - lat) / 180 * rect.h;
        ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y);
      }
      ctx.stroke();
    }

    /* ---------- 昼夜ターミネータ ---------- */
    function angNorm180(a) { return ((a + 180) % 360 + 360) % 360 - 180; }

    function fillNightBandApprox(rect, lambdas) {
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      const Ls = lambdas + 90, Le = lambdas + 270; // 対蹠点中心の180°帯 (連続角度)
      for (const off of [-360, 0, 360]) {
        const lo = Math.max(Ls + off, -180), hi = Math.min(Le + off, 180);
        if (hi <= lo) continue;
        const x0 = rect.x + (lo + 180) / 360 * rect.w;
        const x1 = rect.x + (hi + 180) / 360 * rect.w;
        ctx.fillRect(x0, rect.y, x1 - x0, rect.h);
      }
    }

    function drawTerminator(rect) {
      const sun = SCC.orbit.sunSubpoint(SCC.state.simTime);
      const phis = sun.lat, lambdas = sun.lon;
      if (!isFinite(phis) || !isFinite(lambdas)) return;

      if (Math.abs(phis) < 0.01) {
        fillNightBandApprox(rect, lambdas);
        return;
      }

      const nightPoleLat = phis >= 0 ? -90 : 90;
      const tanPhis = Math.tan(phis * D2R);
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 2) {
        const dl = (lon - lambdas) * D2R;
        const phi = Math.atan(-Math.cos(dl) / tanPhis) * R2D;
        const [x, y] = project(phi, lon, rect);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      const [xR, yR] = project(nightPoleLat, 180, rect);
      const [xL, yL] = project(nightPoleLat, -180, rect);
      ctx.lineTo(xR, yR);
      ctx.lineTo(xL, yL);
      ctx.closePath();
      ctx.fill();
    }

    /* ---------- 可視域円 (footprint) ---------- */
    function footprintPoints(lat0, lon0, radiusDeg) {
      const phi0 = lat0 * D2R, lam0 = lon0 * D2R, delta = radiusDeg * D2R;
      const sinPhi0 = Math.sin(phi0), cosPhi0 = Math.cos(phi0);
      const cosDelta = Math.cos(delta), sinDelta = Math.sin(delta);
      const pts = [];
      for (let thetaDeg = 0; thetaDeg <= 360; thetaDeg += 2) {
        const th = thetaDeg * D2R;
        const sinPhi = clampN(sinPhi0 * cosDelta + cosPhi0 * sinDelta * Math.cos(th), -1, 1);
        const phi = Math.asin(sinPhi);
        const lambda = lam0 + Math.atan2(Math.sin(th) * sinDelta * cosPhi0, cosDelta - sinPhi0 * sinPhi);
        pts.push([phi * R2D, lambda * R2D]);
      }
      return pts;
    }

    function drawFootprint(rect) {
      const pos = SCC.state.sat.pos;
      if (!isFinite(pos.lat) || !isFinite(pos.lon) || !isFinite(pos.alt)) return;
      const radiusDeg = SCC.orbit.footprintRadiusDeg(pos.alt);
      if (!isFinite(radiusDeg)) return;
      const pts = footprintPoints(pos.lat, pos.lon, radiusDeg);
      for (const off of [-360, 0, 360]) {
        ctx.beginPath();
        pts.forEach(([lat, lon], i) => {
          const [x, y] = project(lat, lon + off, rect);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = "rgba(57,135,229,0.10)";
        ctx.fill();
        ctx.strokeStyle = "rgba(57,135,229,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    /* ---------- 地上軌跡 (日付変更線で分割) ---------- */
    function drawPolylineGeo(points, rect, color, width, dash) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false, prevLon = null;
      for (const pt of points) {
        const lat = pt[0], lon = pt[1];
        if (!isFinite(lat) || !isFinite(lon)) { started = false; prevLon = null; continue; }
        const [x, y] = project(lat, lon, rect);
        if (!started || (prevLon !== null && Math.abs(lon - prevLon) > 180)) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        started = true;
        prevLon = lon;
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawGroundTrack(rect) {
      const gt = SCC.state.groundTrack;
      if (gt.past && gt.past.length) drawPolylineGeo(gt.past, rect, COL.ink3, 1.5, null);
      if (gt.future && gt.future.length) drawPolylineGeo(gt.future, rect, COL.s1, 1.5, [6, 5]);
    }

    /* ---------- 地上局 ---------- */
    function isStationActive(st) {
      return SCC.state.passes.some(p => p.station === st.id && p.status === "active");
    }

    function drawDiamond(x, y, r, color) {
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    function drawStations(rect) {
      ctx.save();
      ctx.font = FONT_SANS;
      ctx.textBaseline = "middle";
      for (const st of SCC.state.stations) {
        if (!isFinite(st.lat) || !isFinite(st.lon)) continue;
        const [x, y] = project(st.lat, st.lon, rect);
        const active = isStationActive(st);
        drawDiamond(x, y, 5, active ? COL.ok : COL.ink2);
        ctx.fillStyle = COL.ink2;
        ctx.fillText(st.id, x + 8, y);
      }
      ctx.restore();
    }

    /* ---------- パス中リンク ---------- */
    function drawPassLinks(rect) {
      const pos = SCC.state.sat.pos;
      if (!isFinite(pos.lat) || !isFinite(pos.lon)) return;
      ctx.save();
      ctx.font = FONT_MONO;
      ctx.textBaseline = "middle";
      for (const st of SCC.state.stations) {
        if (!st.antenna.lock) continue;
        let lon2 = pos.lon;
        while (lon2 - st.lon > 180) lon2 -= 360;
        while (lon2 - st.lon < -180) lon2 += 360;
        const [x0, y0] = project(st.lat, st.lon, rect);
        const [x1, y1] = project(pos.lat, lon2, rect);
        ctx.strokeStyle = COL.ok;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        if (isFinite(st.antenna.rssi)) {
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          ctx.fillStyle = COL.ink;
          ctx.fillText(`${st.antenna.rssi.toFixed(1)}dBm`, mx + 5, my - 6);
        }
      }
      ctx.restore();
    }

    /* ---------- 衛星マーカー (パルス付き) ---------- */
    function drawSatellite(rect) {
      const pos = SCC.state.sat.pos;
      if (!isFinite(pos.lat) || !isFinite(pos.lon)) return;
      const [x, y] = project(pos.lat, pos.lon, rect);

      const t = (performance.now() % 1500) / 1500;
      const pulseR = 5 + t * 16;
      const pulseAlpha = (1 - t) * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(57,135,229,${pulseAlpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = COL.s1;
      ctx.fill();
      ctx.strokeStyle = "#0b0d10";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = FONT_SANS;
      ctx.fillStyle = COL.ink;
      ctx.textBaseline = "middle";
      ctx.fillText(SCC.state.sat.name, x + 9, y - 9);
    }

    /* ---------- メイン描画 ---------- */
    function render() {
      const [W, H] = getCssSize();
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      const rect = mapRect;
      if (!rect || rect.w <= 0 || rect.h <= 0) return;

      ctx.save();
      ctx.fillStyle = COL.surfaceIn;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();

      drawGrid(rect);
      drawTerminator(rect);
      drawCoastlines(rect);
      drawFootprint(rect);
      drawGroundTrack(rect);
      drawPassLinks(rect);
      drawStations(rect);
      drawSatellite(rect);

      ctx.restore(); // clip解除

      ctx.strokeStyle = COL.hairline2;
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

      ctx.restore();
    }

    /* ---------- readout ---------- */
    function updateReadout() {
      if (!readout) return;
      const p = SCC.state.sat.pos, vel = SCC.state.sat.vel, orbitNo = SCC.state.sat.orbitNo;
      if (!isFinite(p.lat) || !isFinite(p.lon)) { readout.textContent = "---"; return; }
      readout.textContent =
        `${SCC.fmt.latlon(p.lat, p.lon)}  ALT ${SCC.fmt.num(p.alt, 1, "km")}  ` +
        `VEL ${SCC.fmt.num(vel, 2, "km/s")}  ORBIT #${isFinite(orbitNo) ? orbitNo : "---"}`;
    }

    /* ---------- canvas バインド (dpr + ResizeObserver) ---------- */
    SCC.bindCanvas(canvas, () => {
      const [W, H] = getCssSize();
      const rect = computeMapRect(W, H);
      mapRect = rect;
      if (rect.w > 0 && rect.h > 0) rebuildCoastCache(rect);
      render();
    });

    /* ---------- ホバー ---------- */
    canvas.addEventListener("mousemove", (ev) => {
      const rect = mapRect;
      if (!rect) { SCC.tooltip.hide(); return; }
      const r = canvas.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;

      let hit = null, hitDist = 12;
      const pos = SCC.state.sat.pos;
      if (isFinite(pos.lat) && isFinite(pos.lon)) {
        const [sx, sy] = project(pos.lat, pos.lon, rect);
        const d = Math.hypot(mx - sx, my - sy);
        if (d <= hitDist) { hitDist = d; hit = { type: "sat" }; }
      }
      for (const st of SCC.state.stations) {
        if (!isFinite(st.lat) || !isFinite(st.lon)) continue;
        const [sx, sy] = project(st.lat, st.lon, rect);
        const d = Math.hypot(mx - sx, my - sy);
        if (d <= hitDist) { hitDist = d; hit = { type: "station", st }; }
      }

      if (!hit) { SCC.tooltip.hide(); return; }
      if (hit.type === "sat") {
        const html =
          `<div class="tt-title">${SCC.state.sat.name}</div>` +
          `<div class="tt-row"><span>座標</span><b>${SCC.fmt.latlon(pos.lat, pos.lon)}</b></div>` +
          `<div class="tt-row"><span>高度</span><b>${SCC.fmt.num(pos.alt, 1, "km")}</b></div>`;
        SCC.tooltip.show(html, ev.clientX, ev.clientY);
      } else {
        const st = hit.st;
        const look = SCC.orbit.lookAngles(st, SCC.state.simTime);
        const html =
          `<div class="tt-title">${st.name} (${st.id})</div>` +
          `<div class="tt-row"><span>座標</span><b>${SCC.fmt.latlon(st.lat, st.lon)}</b></div>` +
          `<div class="tt-row"><span>仰角</span><b>${SCC.fmt.deg(look.el, 1)}</b></div>`;
        SCC.tooltip.show(html, ev.clientX, ev.clientY);
      }
    });
    canvas.addEventListener("mouseleave", () => SCC.tooltip.hide());

    /* ---------- tick / rAF ---------- */
    SCC.bus.on("tick", updateReadout);

    function rafLoop() {
      render();
      requestAnimationFrame(rafLoop);
    }
    requestAnimationFrame(rafLoop);
  }

  SCC.panels.map = { init };
})();
