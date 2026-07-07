/* SCC main — パネル初期化・ヘッダバー・シミュレーション速度制御 */
(function () {
  "use strict";
  const S = SCC.state, fmt = SCC.fmt;

  function initTopbar() {
    // 速度セレクタ
    const speedEl = document.getElementById("tb-speed");
    [1, 10, 60, 600].forEach(sp => {
      const b = document.createElement("button");
      b.className = "chip" + (sp === S.simSpeed ? " on" : "");
      b.textContent = "×" + sp;
      b.addEventListener("click", () => {
        SCC.ops.setSimSpeed(sp);
        speedEl.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c === b));
      });
      speedEl.appendChild(b);
    });

    const utc = document.getElementById("tb-utc");
    const jst = document.getElementById("tb-jst");
    const met = document.getElementById("tb-met");
    const aos = document.getElementById("tb-aos");
    const aosInfo = document.getElementById("tb-aos-info");
    const satStatus = document.getElementById("tb-sat-status");
    const alarmsEl = document.getElementById("tb-alarms");
    const netEl = document.getElementById("tb-net");
    const odEl = document.getElementById("tb-od");

    SCC.bus.on("tick", () => {
      netEl.textContent = SCC.net ? SCC.net.label() : "LOCAL SIM";
      netEl.style.color = { ws: "var(--ok)", local: "var(--ink-2)", reconnecting: "var(--crit)" }[SCC.net && SCC.net.mode] || "var(--ink-3)";
      utc.textContent = fmt.hms(S.simTime);
      jst.textContent = fmt.hmsJST(S.simTime);
      met.textContent = fmt.met(S.met);

      const act = S.passes.find(p => p.status === "active");
      const nxt = S.passes.find(p => p.status === "upcoming");
      if (act) {
        aos.textContent = "PASS " + fmt.countdown((act.los - S.simTime) / 1000);
        aos.style.color = "var(--ok)";
        aosInfo.textContent = `${act.station} / EL ${act.maxEl.toFixed(0)}°`;
      } else if (nxt) {
        aos.textContent = "T-" + fmt.countdown((nxt.aos - S.simTime) / 1000);
        aos.style.color = "var(--s1)";
        aosInfo.textContent = `${nxt.station} / EL ${nxt.maxEl.toFixed(0)}°`;
      } else {
        aos.textContent = "---"; aosInfo.textContent = "---";
      }

      // 統合コンタクト: 局をまたいだ連続通信の経過時間 / 残り・次ウィンドウのカウントダウン
      const contactEl = document.getElementById("tb-contact");
      const chainEl = document.getElementById("tb-chain");
      const wins = (S.contact && S.contact.windows) || [];
      const now = S.simTime;
      const cur = wins.find(w => w.start <= now && now <= w.end);
      const nxtW = wins.find(w => w.start > now);
      const chainHtml = w => w.stations.map(id => {
        const on = S.passes.some(p => p.station === id && p.status === "active");
        return `<span style="color:${on ? "var(--ok)" : "var(--ink-3)"}">${id.replace("GS-", "")}</span>`;
      }).join(`<span style="color:var(--ink-3)">→</span>`);
      if (cur) {
        const up = (now - cur.start) / 1000, dn = (cur.end - now) / 1000;
        contactEl.innerHTML =
          `<span style="color:var(--ok)">+${fmt.countdown(up)}</span>` +
          `<span style="color:var(--ink-3)"> / </span>` +
          `<span style="color:var(--s1)">-${fmt.countdown(dn)}</span>`;
        chainEl.innerHTML = chainHtml(cur);
      } else if (nxtW) {
        const durS = (nxtW.end - nxtW.start) / 1000;
        contactEl.innerHTML = `<span style="color:var(--s1)">T-${fmt.countdown((nxtW.start - now) / 1000)}</span>`;
        chainEl.innerHTML = chainHtml(nxtW) +
          `<span style="color:var(--ink-3)"> (${fmt.duration(durS)})</span>`;
      } else {
        contactEl.textContent = "---";
        chainEl.textContent = "---";
      }

      // OD (観測ベース軌道決定) ステータスチップ
      const od = S.od || { state: "IDLE", nObs: 0, sigmaPosM: NaN };
      if (od.state === "COLLECTING") {
        odEl.textContent = isFinite(od.sigmaPosM)
          ? `OD n=${od.nObs} σ=${od.sigmaPosM.toFixed(0)}m`
          : `OD n=${od.nObs} 収集中`;
        odEl.style.color = "var(--warn)";
      } else {
        odEl.textContent = "EST OK";
        odEl.style.color = "var(--ink-3)";
      }

      // 衛星ステータス = 未確認アラームの最大レベル
      const lv = S.sat.alarms.reduce((m, a) => a.ack ? m : (a.level === "crit" ? 3 : Math.max(m, a.level === "serious" ? 2 : 1)), 0);
      satStatus.className = "badge " + ["badge--ok", "badge--warn", "badge--serious", "badge--crit"][lv];
      satStatus.textContent = ["NOMINAL", "WARNING", "SERIOUS", "CRITICAL"][lv];

      // アラームチップ (クリックでACK)
      const unacked = S.sat.alarms.filter(a => !a.ack).slice(-4);
      alarmsEl.innerHTML = "";
      for (const a of unacked) {
        const b = document.createElement("button");
        b.className = "badge badge--" + (a.level === "crit" ? "crit" : a.level === "serious" ? "serious" : "warn");
        b.style.cursor = "pointer";
        b.title = a.msg + " (クリックで確認)";
        b.textContent = a.key;
        b.addEventListener("click", () => SCC.ops.ackAlarm(a.id));
        alarmsEl.appendChild(b);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTopbar();
    for (const [name, p] of Object.entries(SCC.panels)) {
      try { p.init(); } catch (e) { console.error(`[panel:${name}] init failed`, e); }
    }
    SCC.net.init();   // WS接続を試み、失敗時はローカルシミュレータへ自動フォールバック
  });
})();
