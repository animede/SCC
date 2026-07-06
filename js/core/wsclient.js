/* SCC wsclient — フェーズ2 通信層 (SCC.net)
   バックエンド(server/server.mjs)へ WebSocket 接続し、SCC.state をサーバ権威で駆動する。
   接続不可なら mockdata.js のローカルシミュレータへ自動フォールバック。
   モード指定: ?mode=mock でローカル強制 / ?ws=ws://host:port/ws で接続先上書き。 */
(function () {
  "use strict";

  const S = SCC.state, bus = SCC.bus, proto = SCC.proto;

  const net = {
    mode: "init",          // init | connecting | ws | local | reconnecting
    label() {
      return { init: "---", connecting: "CONNECTING", ws: "WS LINK", local: "LOCAL SIM", reconnecting: "RECONNECT..." }[net.mode];
    },
    init: start,
  };

  let ws = null;
  let everConnected = false;
  let retryTimer = null;

  function localLog(level, msg) {
    const e = { t: new Date(S.simTime), level, source: "NET", msg };
    S.history.unshift(e);
    if (S.history.length > 500) S.history.length = 500;
    bus.emit("log", e);
  }

  /* ---- サーバ権威モード: SCC.ops を WS プロキシに差し替え ---- */
  function installOpsProxy() {
    for (const name of proto.OPS_WHITELIST) {
      SCC.ops[name] = (...args) => {
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "op", name, args }));
      };
    }
  }

  /* tick/hello の state をローカル state へ反映。
     history はローカル管理 (helloで全量置換、以後 log イベントで増分) のため tick では触らない。 */
  function applyState(incoming, withHistory) {
    for (const k of Object.keys(incoming)) {
      if (k === "history" && !withHistory) continue;
      S[k] = incoming[k];
    }
    if (withHistory && !incoming.history) S.history = [];
  }

  function handleMsg(text) {
    let m;
    try { m = proto.decodeMsg(text); } catch (e) { console.error("[net] decode", e); return; }
    switch (m.type) {
      case "hello":
        applyState(m.state, true);
        everConnected = true;
        net.mode = "ws";
        installOpsProxy();
        localLog("info", `バックエンド接続確立 (${wsUrl()})`);
        bus.emit("tick", S);
        break;
      case "tick":
        if (net.mode !== "ws") return;
        applyState(m.state, false);
        bus.emit("tick", S);
        break;
      case "log":
        S.history.unshift(m.entry);
        if (S.history.length > 500) S.history.length = 500;
        bus.emit("log", m.entry);
        break;
      case "pass-change":
        bus.emit("pass-change", m.payload);
        break;
      case "command-sent":
        bus.emit("command-sent", m.payload);
        break;
      case "command-ack":
        bus.emit("command-ack", m.payload);
        break;
      case "term-output":
        if (termHandlers.output) termHandlers.output(m.data);
        break;
      case "term-exit":
        if (termHandlers.exit) termHandlers.exit(m.code);
        break;
    }
  }

  /* ---- OBC 端末チャネル (WS ↔ ローカル satshell 透過) ----
     terminal.js は接続モードを意識せず SCC.net.term.open() を呼ぶ。 */
  const termHandlers = { output: null, exit: null };
  const term = {
    // { cols, rows, onOutput(str), onExit(code) } → session { write, resize, close }
    open(opts) {
      const onOutput = opts.onOutput || (() => {});
      termHandlers.output = onOutput;
      termHandlers.exit = opts.onExit || null;

      if (net.mode === "ws" && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "term-open", cols: opts.cols, rows: opts.rows }));
        return {
          backend: "obc-remote",
          write: s => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "term-input", data: s })); },
          resize: (c, r) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "term-resize", cols: c, rows: r })); },
          close: () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "term-close" })); },
        };
      }
      // ローカル: フロント内蔵の擬似 OBC シェル
      if (SCC.satshell) {
        return SCC.satshell.createSession({ cols: opts.cols, rows: opts.rows, onOutput, onExit: opts.onExit });
      }
      onOutput("\r\n\x1b[31m[端末利用不可: satshell 未ロード]\x1b[0m\r\n");
      return { backend: "none", write() {}, resize() {}, close() {} };
    },
    // 現在の端末バックエンド種別 (パネルの状態表示用): obc-remote(WS) / obc-sim(local)
    backendKind() { return net.mode === "ws" ? "obc-remote" : "obc-sim"; },
  };
  net.term = term;

  /* ---- 接続制御 ---- */
  function wsUrl() {
    const p = new URLSearchParams(location.search);
    if (p.get("ws")) return p.get("ws");
    if (location.protocol === "http:" || location.protocol === "https:") {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      return `${scheme}://${location.host}/ws`;
    }
    return null; // file:// 等
  }

  function fallLocal(reason) {
    if (net.mode === "local") return;
    net.mode = "local";
    SCC.mock.init();
    localLog("warn", `バックエンド未接続 (${reason}) — ローカルシミュレータで動作`);
  }

  function connect(isRetry) {
    const url = wsUrl();
    net.mode = isRetry ? "reconnecting" : "connecting";
    let settled = false;
    try { ws = new WebSocket(url); }
    catch (e) { onFail("open error"); return; }

    const to = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} onFail("timeout"); } }, 2500);

    ws.onopen = () => { /* hello 受信で確定 */ };
    ws.onmessage = ev => {
      if (!settled) { settled = true; clearTimeout(to); }
      handleMsg(ev.data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!settled) { settled = true; clearTimeout(to); }
      onFail("closed");
    };
  }

  function onFail(reason) {
    ws = null;
    if (!everConnected) {
      fallLocal(reason);   // 一度も繋がっていない → ローカルへ
      return;
    }
    // 接続済みだった → 再接続を試み続ける (state は最終値で凍結)
    if (net.mode !== "reconnecting") {
      net.mode = "reconnecting";
      localLog("crit", "バックエンドとの接続断 — 再接続中");
      bus.emit("tick", S); // インジケータ更新のため
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect(true), 3000);
  }

  function start() {
    const p = new URLSearchParams(location.search);
    if (p.get("mode") === "mock" || !wsUrl()) {
      net.mode = "local";
      SCC.mock.init();
      return;
    }
    connect(false);
    // 接続確立まで無音にならないよう、フォールバック判定は onFail/timeout に任せる
  }

  window.SCC.net = net;
})();
