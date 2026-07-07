#!/usr/bin/env node
/* SCC server — フェーズ2 参照バックエンド
   フロントエンドの js/core/*.js シミュレータをそのまま Node 上で動かし、
   静的配信 + WebSocket(自前RFC6455実装)で配信する。依存パッケージ一切なし
   (node: 組み込みモジュールのみ)。

   使い方:
     node server/server.mjs [--port 8000] [--config server/config.json] [--tle path/to.tle]
*/
"use strict";

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");   // リポジトリルート (server/ の親)

/* ============================================================
   0. CLI引数
   ============================================================ */
function parseArgs(argv) {
  const out = { port: 8000, config: null, tle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--tle") out.tle = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

/* ============================================================
   1. シミュレータのロード (フロントエンドと同一コードを共有)
   ============================================================ */
const require_ = createRequire(import.meta.url);
globalThis.window = globalThis;                       // state.js が window.SCC に登録するため
globalThis.satellite = require_(ROOT + "/js/vendor/satellite.min.js"); // orbit.js が参照(UMD)
for (const f of ["js/core/state.js", "js/core/orbit.js", "js/core/orbitdet.js", "js/core/mockdata.js", "js/core/proto.js", "js/core/satshell.js"])
  (0, eval)(fs.readFileSync(ROOT + "/" + f, "utf8"));

const SCC = globalThis.SCC;

/* ---------- TLE 指定 (任意) ---------- */
function loadTleFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.warn(`[TLE] ファイル読込失敗 (${file}): ${e.message} — 既定TLE/軌道を使用`);
    return;
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // 2行 or 3行(1行目は衛星名なので無視)。"1 " / "2 " で始まる行を採用。
  const l1 = lines.find(l => l.startsWith("1 "));
  const l2 = lines.find(l => l.startsWith("2 "));
  if (!l1 || !l2) {
    console.warn(`[TLE] ${file} から2行TLEを抽出できません — 既定TLE/軌道を使用`);
    return;
  }
  if (typeof SCC.orbit.setTLE !== "function") {
    console.log("[TLE] SCC.orbit.setTLE 未実装 (旧orbit.js) — TLE指定をスキップし既定軌道を使用");
    return;
  }
  try {
    const ok = SCC.orbit.setTLE(l1, l2);
    if (ok === false) {
      console.warn(`[TLE] ${file} の setTLE が失敗を返しました — 既定TLE/軌道を使用`);
    } else {
      console.log(`[TLE] ${file} を読込みました`);
    }
  } catch (e) {
    console.warn(`[TLE] setTLE 例外 (${file}): ${e.message} — 既定TLE/軌道を使用`);
  }
}
if (args.tle) loadTleFile(args.tle);

SCC.mock.init();

/* ---------- サーバ側ログ (rotctld アダプタ等から使用) ---------- */
function serverLog(level, source, msg) {
  const e = { t: new Date(SCC.state.simTime), level, source, msg };
  SCC.state.history.unshift(e);
  if (SCC.state.history.length > 500) SCC.state.history.length = 500;
  SCC.bus.emit("log", e);
}

/* ============================================================
   2. 静的配信
   ============================================================ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400); res.end("Bad Request"); return;
  }
  if (pathname === "/") pathname = "/index.html";
  const resolved = path.resolve(ROOT, "." + pathname);
  // パストラバーサル防止: 解決後パスが root 配下にあること
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(resolved).pipe(res);
  });
}

/* ============================================================
   3. WebSocket (RFC6455 自前実装)
   ============================================================ */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set(); // { sock, buf }

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendFrame(sock, opcode, payload) {
  if (!sock || sock.destroyed || sock.writableEnded) return;
  try { sock.write(encodeFrame(opcode, payload)); } catch { /* ソケットは切断済み扱い */ }
}

function wsSend(sock, text) {
  sendFrame(sock, 0x1, Buffer.from(text, "utf8"));
}

function broadcast(text) {
  if (clients.size === 0) return;
  const frame = encodeFrame(0x1, Buffer.from(text, "utf8"));
  for (const c of clients) {
    if (!c.sock.destroyed && !c.sock.writableEnded) {
      try { c.sock.write(frame); } catch { /* ignore */ }
    }
  }
}

// バッファから完成しているフレームを1つ取り出す。不足していれば null。
function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
    payload = out;
  } else {
    payload = Buffer.from(payload);
  }
  return { fin, opcode, payload, bytesUsed: offset + len };
}

function closeClient(client, code) {
  closeTermSession(client);
  sendFrame(client.sock, 0x8, Buffer.alloc(0));
  try { client.sock.end(); } catch { /* ignore */ }
  clients.delete(client);
}

function handleFrame(client, frame) {
  if (!frame.fin) {
    console.error("[ws] フラグメント化フレームは非対応 — 切断します");
    closeClient(client);
    return;
  }
  switch (frame.opcode) {
    case 0x1: { // text
      let msg;
      try {
        msg = SCC.proto.decodeMsg(frame.payload.toString("utf8"));
      } catch (e) {
        console.error("[ws] メッセージのデコードに失敗:", e.message);
        break;
      }
      if (msg && msg.type === "op" && SCC.proto.OPS_WHITELIST.includes(msg.name)) {
        try {
          SCC.ops[msg.name](...(msg.args || []));
        } catch (e) {
          console.error(`[ws] SCC.ops.${msg.name} 実行中に例外:`, e);
        }
      } else if (msg && msg.type === "term-open") {
        openTermSession(client, msg.cols || 80, msg.rows || 24);
      } else if (msg && msg.type === "term-input") {
        if (client.term) client.term.write(typeof msg.data === "string" ? msg.data : "");
      } else if (msg && msg.type === "term-resize") {
        if (client.term) client.term.resize(msg.cols, msg.rows);
      } else if (msg && msg.type === "term-close") {
        closeTermSession(client);
      }
      break;
    }
    case 0x8: // close
      closeClient(client);
      break;
    case 0x9: // ping
      sendFrame(client.sock, 0xA, frame.payload);
      break;
    case 0xA: // pong
      break;
    default:
      break;
  }
}

function processBuffer(client) {
  for (;;) {
    const res = tryParseFrame(client.buf);
    if (!res) break;
    client.buf = client.buf.subarray(res.bytesUsed);
    handleFrame(client, res);
    if (client.sock.destroyed) break;
  }
}

function handleUpgrade(req, sock, head) {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    sock.destroy();
    return;
  }
  if (pathname !== "/ws") {
    sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    sock.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const client = { sock, buf: Buffer.alloc(0), term: null };
  clients.add(client);

  sock.on("error", (e) => {
    console.error("[ws] ソケットエラー:", e.message);
    closeTermSession(client);
    clients.delete(client);
  });
  sock.on("close", () => { closeTermSession(client); clients.delete(client); });
  sock.on("data", (chunk) => {
    client.buf = client.buf.length ? Buffer.concat([client.buf, chunk]) : chunk;
    processBuffer(client);
  });

  if (head && head.length) {
    client.buf = Buffer.concat([client.buf, head]);
    processBuffer(client);
  }

  // 接続直後: 全量スナップショット
  wsSend(sock, SCC.proto.encodeMsg("hello", { state: SCC.state }));
}

/* ============================================================
   4. SCC.bus 購読 → broadcast
   ============================================================ */
SCC.bus.on("tick", () => {
  if (clients.size === 0) return; // クライアント0なら組み立てすら行わない
  broadcast(SCC.proto.encodeMsg("tick", SCC.proto.stateForTick(SCC.state)));
});
SCC.bus.on("log", (entry) => broadcast(SCC.proto.encodeMsg("log", { entry })));
SCC.bus.on("pass-change", (payload) => broadcast(SCC.proto.encodeMsg("pass-change", { payload })));
SCC.bus.on("command-sent", (payload) => broadcast(SCC.proto.encodeMsg("command-sent", { payload })));
SCC.bus.on("command-ack", (payload) => broadcast(SCC.proto.encodeMsg("command-ack", { payload })));

/* ============================================================
   5. rotctld (Hamlib ロータデーモン) アダプタ
   ============================================================ */
function loadConfig(configPath) {
  if (!configPath) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.warn(`[config] 読込失敗 (${configPath}): ${e.message} — rotctld連携は無効`);
    return null;
  }
}
const config = loadConfig(args.config);

function setupRotator(stationId, hostCfg) {
  const st = SCC.state.stations.find(s => s.id === stationId);
  if (!st) { console.warn(`[rotctld] 未知の局ID: ${stationId} — スキップ`); return; }

  let sock = null;
  let connected = false;
  let lineBuf = "";
  let pendingQueue = [];   // 送信順に対応する応答待ちキュー
  let pollTimer = null;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 10000);
  }

  function markDisconnected(reason) {
    if (connected) {
      connected = false;
      st.antenna.hw = false;
      serverLog("warn", stationId, `rotctld 切断 (${hostCfg.host}:${hostCfg.port})${reason ? " — " + reason : ""}`);
    }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pendingQueue = [];
    lineBuf = "";
    if (sock) { try { sock.destroy(); } catch { /* ignore */ } }
    scheduleReconnect();
  }

  function handleLine(line) {
    if (!pendingQueue.length) return; // 予期しない応答は無視
    const cur = pendingQueue[0];
    if (cur.kind === "P") {
      pendingQueue.shift(); // "RPRT 0" 等、読み捨て
    } else if (cur.kind === "p") {
      cur.vals.push(line);
      if (cur.vals.length >= 2) {
        const az = parseFloat(cur.vals[0]);
        const el = parseFloat(cur.vals[1]);
        if (Number.isFinite(az)) st.antenna.az = az;
        if (Number.isFinite(el)) st.antenna.el = el;
        pendingQueue.shift();
      }
    }
  }

  function pollOnce() {
    if (!connected || !sock || sock.destroyed) return;
    try {
      sock.write(`P ${st.antenna.cmdAz.toFixed(1)} ${st.antenna.cmdEl.toFixed(1)}\n`);
      pendingQueue.push({ kind: "P" });
      sock.write("p\n");
      pendingQueue.push({ kind: "p", vals: [] });
    } catch { /* エラーは 'error' イベントで処理される */ }
  }

  function connect() {
    sock = new net.Socket();
    sock.on("connect", () => {
      connected = true;
      st.antenna.hw = true;
      serverLog("info", stationId, `rotctld 接続 ${hostCfg.host}:${hostCfg.port}`);
      pollTimer = setInterval(pollOnce, 500);
    });
    sock.on("data", (chunk) => {
      lineBuf += chunk.toString("utf8");
      let idx;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    sock.on("error", (e) => markDisconnected(e.message));
    sock.on("close", () => markDisconnected());
    sock.connect(hostCfg.port, hostCfg.host);
  }

  connect();
}

let rotatorCount = 0;
if (config && config.rotators) {
  for (const [stationId, hostCfg] of Object.entries(config.rotators)) {
    setupRotator(stationId, hostCfg);
    rotatorCount++;
  }
}

/* ============================================================
   6. OBC 端末ブリッジ (term-open/term-input/term-resize/term-close)
   ------------------------------------------------------------
   WSクライアント(接続)ごとに最大1つの端末セッションを持つ。既定は
   SCC.satshell (擬似OBCシェル、依存ゼロ・完全シミュレーション)。
   config.obc.mode === "ssh" (または obc.host 指定) の場合のみ、実機OBCへの
   実SSH接続に切り替わる。

   ***** セキュリティ注記 *****
   実SSHブリッジは運用者が config で明示的に有効化した場合のみ動作する。
   本サーバはコマンド文字列を組み立てて `script`/`ssh` を子プロセス起動する
   だけであり、ホスト鍵検証・パスワード/鍵認証は OS 側の ssh クライアント
   設定(~/.ssh/config, known_hosts, ssh-agent 等)にすべて委ねる。
   信頼できないネットワークにこのWSを公開する場合は、別途アクセス制御
   (認証・IP制限・TLS終端等)を行うこと。
   ============================================================ */
const obcCfg = config && config.obc;
const obcSshEnabled = !!(obcCfg && (obcCfg.mode === "ssh" || obcCfg.host));

function closeTermSession(client) {
  if (client.term) {
    try { client.term.close(); } catch { /* ignore */ }
    client.term = null;
  }
}

function createSimTermSession(client, cols, rows) {
  return SCC.satshell.createSession({
    cols, rows,
    onOutput: (data) => wsSend(client.sock, SCC.proto.encodeMsg("term-output", { data })),
    onExit: (code) => {
      wsSend(client.sock, SCC.proto.encodeMsg("term-exit", { code }));
      if (client.term) client.term = null;
    },
  });
}

// util-linux の `script` で擬似PTYを確保して ssh -tt を起動する。
// `script` が存在しない/起動失敗した環境では term-output で通知の上
// satshell (擬似シェル) にフォールバックする。
function shQuote(s) {
  return /^[A-Za-z0-9_.:@\/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

function createSshTermSession(client, cols, rows, cfg) {
  const host = cfg.host, user = cfg.user || "ops", port = cfg.port || 22;
  const sshArgs = Array.isArray(cfg.sshArgs) ? cfg.sshArgs : [];
  const sshCmd = ["ssh", "-tt", "-p", String(port)].concat(sshArgs, [`${user}@${host}`]).map(shQuote).join(" ");

  let child;
  try {
    child = spawn("script", ["-qec", sshCmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    wsSend(client.sock, SCC.proto.encodeMsg("term-output", {
      data: `\r\n\x1b[31m実SSH起動に失敗しました (${e.message}) — 擬似シェルにフォールバックします\x1b[0m\r\n`,
    }));
    serverLog("warn", "TERM", `実SSH起動失敗 (${e.message}) — satshell にフォールバック`);
    return createSimTermSession(client, cols, rows);
  }

  let settled = false;
  const session = {
    write: (s) => { try { child.stdin.write(s); } catch { /* プロセス終了済み等は無視 */ } },
    // ウィンドウサイズ変更 (TIOCSWINSZ) は `script` 経由の子プロセスに対して
    // 直接送る手段がないため、リサイズ通知はベストエフォートで省略する
    // (spec: 省略可)。必要なら別途 pty モジュール導入等で対応すること。
    resize: () => { /* no-op: 上記コメント参照 */ },
    close: () => { settled = true; try { child.kill(); } catch { /* ignore */ } },
  };

  child.stdout.on("data", (d) => wsSend(client.sock, SCC.proto.encodeMsg("term-output", { data: d.toString("utf8") })));
  child.stderr.on("data", (d) => wsSend(client.sock, SCC.proto.encodeMsg("term-output", { data: d.toString("utf8") })));
  child.on("error", (e) => {
    if (settled) return;
    settled = true;
    wsSend(client.sock, SCC.proto.encodeMsg("term-output", {
      data: `\r\n\x1b[31m実SSHプロセスエラー (${e.message}) — 擬似シェルにフォールバックします\x1b[0m\r\n`,
    }));
    serverLog("warn", "TERM", `実SSHプロセスエラー (${e.message}) — satshell にフォールバック`);
    if (client.term === session) client.term = createSimTermSession(client, cols, rows);
  });
  child.on("exit", (code) => {
    if (settled) return;
    settled = true;
    wsSend(client.sock, SCC.proto.encodeMsg("term-exit", { code: code == null ? 0 : code }));
    if (client.term === session) client.term = null;
  });

  serverLog("info", "TERM", `実SSHブリッジ起動 ${user}@${host}:${port}`);
  return session;
}

function openTermSession(client, cols, rows) {
  closeTermSession(client); // 既存セッションがあれば張り直す
  client.term = obcSshEnabled
    ? createSshTermSession(client, cols, rows, obcCfg)
    : createSimTermSession(client, cols, rows);
}

/* ============================================================
   7. HTTPサーバ起動
   ============================================================ */
const httpServer = http.createServer(serveStatic);
httpServer.on("upgrade", handleUpgrade);

httpServer.listen(args.port, () => {
  console.log(`SCC backend listening on port ${args.port}`);
  console.log(`Static root: ${ROOT}`);
  console.log(`WebSocket:   ws://localhost:${args.port}/ws`);
  console.log(`TLE:         ${args.tle ? args.tle : "default (built-in orbit)"}`);
  console.log(`Rotators:    ${rotatorCount} configured`);
  console.log(`Terminal:    ${obcSshEnabled ? `ssh -> ${obcCfg.user || "ops"}@${obcCfg.host}:${obcCfg.port || 22}` : "sim (SCC.satshell)"}`);
});

process.on("SIGINT", () => {
  console.log("\n[SCC] shutting down...");
  for (const c of clients) closeClient(c);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
