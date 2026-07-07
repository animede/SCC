/* SCC server セルフテスト — 依存ゼロ (node: 組み込みのみ + グローバル WebSocket)
   実行: node server/test.mjs
   1. server.mjs を子プロセスで起動 (ポート18800)
   2. 偽 rotctld を net で立てて GS-TKY 用の一時 config.json を渡す
   3. WebSocket で接続し hello / tick x2 を検証
   4. {type:"op", name:"setSimSpeed", args:[10]} で simSpeed 反映を検証
   5. 偽 rotctld が P コマンドを受信したこと、返した az が GS-TKY antenna.az に反映されることを検証
   6. HTTP GET / が index.html を返すことを検証
   7. OBC 端末ブリッジ (擬似シェル/satshell): term-open → 初回 term-output(バナー/プロンプト)、
      term-input "uname -a" → 応答に "hikari-obc"、"tlm eps" → 応答に電圧らしき数値/"SoC" を検証
   8. 観測ベース軌道決定 (SCC.od): 実行誤差込みの真の軌道に対し、2局からの range/az/el 観測
      (シード付き乱数で再現性確保)をバッチ最小二乗フィットし、収束後のTLEが真の軌道に
      90分(1周回)にわたって高精度追従することを検証(js/core/*.js を直接ロードする単体テスト、
      server.mjs 子プロセスとは独立)。
   → 全部PASSしたら "ALL PASS" を出力して終了 (exit 0)。失敗があれば失敗内容を出して exit 1。 */
"use strict";

import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 18800;
const FAKE_AZ = 123.4, FAKE_EL = 45.6;

let failed = false;
function fail(msg) { failed = true; console.error("FAIL -", msg); }
function ok(msg) { console.log("ok   -", msg); }

/* ---------- OD (観測ベース軌道決定) セルフテスト ----------
   js/core/state.js・orbit.js・orbitdet.js を server.mjs と同じ手法(globalThisへeval)で
   直接ロードして検証する(server.mjs の子プロセスとは無関係、このプロセス内で完結)。
   vm モジュールの別レルムだと satellite.js 内部の instanceof 等が壊れるため使わない。
   シード付き簡易LCGで観測ノイズを再現可能にする。 */
function runOdTest() {
  const require_ = createRequire(import.meta.url);
  globalThis.window = globalThis;
  globalThis.satellite = require_(path.join(ROOT, "js/vendor/satellite.min.js"));
  for (const f of ["js/core/state.js", "js/core/orbit.js", "js/core/orbitdet.js"]) {
    (0, eval)(fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
  const SCC = globalThis.SCC;

  // シード付き簡易LCG (再現性確保)
  function makeLcg(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  const rand = makeLcg(58);
  function gauss(sigma) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }

  const defaultTle = SCC.orbit.getTLE();
  const burnDate = new Date(Date.UTC(2026, 6, 6, 0, 0, 0));

  // 真の軌道: along 5.1 m/s を指定方向から 0.3° 傾けた実行誤差込みで適用
  const trueOrbit = SCC.createOrbit();
  trueOrbit.setTLE(defaultTle.line1, defaultTle.line2);
  const dvTrueMag = 5.1 / 1000, tiltRad = 0.3 * Math.PI / 180;
  const okTrue = trueOrbit.applyBurn(
    { radial: dvTrueMag * Math.sin(tiltRad), along: dvTrueMag * Math.cos(tiltRad), cross: 0 },
    burnDate
  );
  if (okTrue) ok("OD: 真の軌道への実行誤差込みburn適用に成功"); else fail("OD: 真の軌道へのburn適用に失敗");

  // 地上予測: 誤差なし 5.0 m/s along を prior として od.reset
  const priorOrbit = SCC.createOrbit();
  priorOrbit.setTLE(defaultTle.line1, defaultTle.line2);
  const okPrior = priorOrbit.applyBurn({ radial: 0, along: 5.0 / 1000, cross: 0 }, burnDate);
  if (!okPrior) fail("OD: 地上予測軌道へのburn適用に失敗");
  const priorTle = priorOrbit.getTLE();

  SCC.od.reset([priorTle.line1, priorTle.line2], burnDate);

  const stations = [
    { id: "GS-TKY", lat: 35.66, lon: 139.32, altKm: 0 },
    { id: "GS-HKD", lat: 43.33, lon: 145.58, altKm: 0 },
  ];

  // 2局の可視パスを burnDate から探索し、5秒間隔でノイズ付き観測を生成
  // (観測ウィンドウは複数パスにまたがる約3.5時間分: 平均運動の推定精度確保に必要)
  let allObs = [];
  for (const st of stations) {
    const passes = trueOrbit.predictPasses(st, burnDate, 24);
    for (const p of passes) {
      let t = p.aos.getTime();
      while (t <= p.los.getTime()) {
        const look = trueOrbit.lookAngles(st, new Date(t));
        if (look.el > SCC.orbit.MIN_EL) {
          allObs.push({
            tMs: t,
            station: st,
            rangeKm: look.range + gauss(0.02),
            azDeg: look.az + gauss(0.15),
            elDeg: look.el + gauss(0.15),
          });
        }
        t += 5000;
      }
    }
  }
  allObs.sort((a, b) => a.tMs - b.tMs);
  const WINDOW_MS = 3.5 * 3600 * 1000;
  const used = allObs.filter(o => o.tMs - allObs[0].tMs <= WINDOW_MS);
  const spanS = (used[used.length - 1].tMs - used[0].tMs) / 1000;
  const nStations = new Set(used.map(o => o.station.id)).size;
  if (used.length >= 60 && spanS >= 300) ok(`OD: 観測生成 ${used.length}点 / スパン${spanS.toFixed(0)}秒 / ${nStations}局`);
  else fail(`OD: 観測条件不足 (n=${used.length}, span=${spanS})`);

  for (const o of used) SCC.od.addObs(o);

  // レート制限(シム15秒 + 実時間1秒)を回避するため時刻を進めながら step を繰り返し呼ぶ
  let fit = null;
  let stepMs = burnDate.getTime();
  let iter = 0;
  while (!fit && iter < 3000) {
    stepMs += 20000;
    fit = SCC.od.step(stepMs);
    iter++;
  }
  if (!fit) { fail("OD: フィットが収束しなかった"); return; }
  ok(`OD: フィット収束 — rms=${fit.stats.rmsM.toFixed(1)}m σpos=${fit.stats.sigmaPosM.toFixed(1)}m ` +
     `nObs=${fit.stats.nObs} nStations=${fit.stats.nStations} corr=${fit.stats.corrKm.toFixed(2)}km`);

  // 収束後のTLEで新インスタンスを作り、1周回分(90分, 60秒刻み)の各時刻で真の軌道との位置差を検証
  const fitted = SCC.createOrbit();
  fitted.setTLE(fit.tle[0], fit.tle[1]);
  let maxErrKm = 0;
  for (let i = 0; i <= 90; i++) {
    const t = new Date(burnDate.getTime() + i * 60000);
    const a = trueOrbit.stateAt(t), b = fitted.stateAt(t);
    if (!a || !b) { fail(`OD: stateAt失敗 (i=${i})`); return; }
    const d = Math.hypot(a.r.x - b.r.x, a.r.y - b.r.y, a.r.z - b.r.z);
    if (d > maxErrKm) maxErrKm = d;
  }
  console.log(`     OD: 1周回(90分)での真の軌道との最大位置誤差 = ${maxErrKm.toFixed(3)} km`);
  if (maxErrKm < 1.0) ok(`OD: 収束後の最大位置誤差 < 1.0km (実測 ${maxErrKm.toFixed(3)}km)`);
  else fail(`OD: 収束後の最大位置誤差が1.0kmを超過 (実測 ${maxErrKm.toFixed(3)}km)`);

  // OD収束後は IDLE に戻り、観測バッファがクリアされていること
  const st = SCC.od.status();
  if (st.state === "IDLE" && st.nObs === 0) ok("OD: 収束後 IDLE へ復帰し観測バッファをクリア");
  else fail(`OD: 収束後の状態が不正: ${JSON.stringify(st)}`);
}

/* ---------- proto デコード (js/core/proto.js と同一仕様の最小実装) ---------- */
function decodeVal(v) {
  if (v === "__NaN") return NaN;
  if (Array.isArray(v)) return v.map(decodeVal);
  if (v && typeof v === "object") {
    if (typeof v.__dt === "number" && Object.keys(v).length === 1) return new Date(v.__dt);
    const o = {};
    for (const k of Object.keys(v)) o[k] = decodeVal(v[k]);
    return o;
  }
  return v;
}
function decodeMsg(text) { return decodeVal(JSON.parse(text)); }

function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

let child = null;
let rotServer = null;
function cleanup() {
  try { if (child) child.kill(); } catch { /* ignore */ }
  try { if (rotServer && rotServer.listening) rotServer.close(); } catch { /* ignore */ }
}
process.on("exit", cleanup);

async function main() {
  /* ---------- 1. 偽 rotctld ---------- */
  let gotPCommand = false;
  rotServer = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("P ")) {
          gotPCommand = true;
          sock.write("RPRT 0\n");
        } else if (line === "p") {
          sock.write(`${FAKE_AZ}\n${FAKE_EL}\n`);
        }
      }
    });
    sock.on("error", () => { /* ignore */ });
  });
  await new Promise((resolve) => rotServer.listen(0, "127.0.0.1", resolve));
  const rotPort = rotServer.address().port;
  ok(`fake rotctld listening on 127.0.0.1:${rotPort}`);

  /* ---------- 2. 一時 config.json ---------- */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-test-"));
  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    rotators: { "GS-TKY": { host: "127.0.0.1", port: rotPort } },
  }));

  /* ---------- 3. server.mjs 起動 ---------- */
  child = spawn(process.execPath, [
    path.join(ROOT, "server", "server.mjs"),
    "--port", String(PORT),
    "--config", configPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let serverOut = "";
  child.stdout.on("data", (d) => (serverOut += d.toString()));
  child.stderr.on("data", (d) => (serverOut += d.toString()));
  child.on("exit", (code, sig) => {
    if (!child._expectedExit) console.error(`[test] server.mjs exited early (code=${code}, sig=${sig})\n${serverOut}`);
  });

  const started = await waitFor(() => /listening on port/.test(serverOut), 8000);
  if (!started) {
    fail("server.mjs did not start in time:\n" + serverOut);
    console.log(failed ? "SOME TESTS FAILED" : "ALL PASS");
    process.exit(1);
  }
  ok("server.mjs started");

  /* ---------- 4. HTTP GET / ---------- */
  try {
    const res = await httpGet(`http://127.0.0.1:${PORT}/`);
    if (res.status === 200 && /<html/i.test(res.body) && /SCC/.test(res.body)) {
      ok("HTTP GET / returns index.html");
    } else {
      fail(`HTTP GET / unexpected response (status=${res.status})`);
    }
  } catch (e) {
    fail("HTTP GET / failed: " + e.message);
  }

  /* ---------- 5. WebSocket 接続 ---------- */
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  let waiter = null;
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = decodeMsg(ev.data); } catch (e) { console.error("[test] decode failed:", e.message); return; }
    if (waiter) { const w = waiter; waiter = null; w(msg); }
    else inbox.push(msg);
  });
  function nextMessage(timeoutMs = 5000) {
    if (inbox.length) return Promise.resolve(inbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiter = null; reject(new Error("timeout waiting for message")); }, timeoutMs);
      waiter = (m) => { clearTimeout(timer); resolve(m); };
    });
  }
  // 指定 type のメッセージが来るまで他 (tick/log等) を読み飛ばして待つ
  async function waitForType(type, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remain = Math.max(200, deadline - Date.now());
      let m;
      try { m = await nextMessage(remain); } catch { break; }
      if (m && m.type === type) return m;
    }
    return null;
  }

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connection error")));
      setTimeout(() => reject(new Error("ws open timeout")), 5000);
    });
    ok("WebSocket connected");
  } catch (e) {
    fail(e.message);
    console.log("SOME TESTS FAILED");
    process.exit(1);
  }

  try {
    const hello = await nextMessage();
    if (hello && hello.type === "hello" && hello.state && Array.isArray(hello.state.stations) && Array.isArray(hello.state.history)) {
      ok("hello received with full state (history included)");
    } else fail("hello message malformed: " + JSON.stringify(hello).slice(0, 200));
  } catch (e) { fail("hello: " + e.message); }

  try {
    const tick1 = await nextMessage();
    if (tick1 && tick1.type === "tick" && tick1.state && tick1.state.simTime instanceof Date) ok("tick #1 received");
    else fail("tick #1 malformed: " + JSON.stringify(tick1).slice(0, 200));
  } catch (e) { fail("tick #1: " + e.message); }

  try {
    const tick2 = await nextMessage();
    if (tick2 && tick2.type === "tick" && tick2.state) ok("tick #2 received");
    else fail("tick #2 malformed");
  } catch (e) { fail("tick #2: " + e.message); }

  /* ---------- 6. setSimSpeed op ---------- */
  try {
    ws.send(JSON.stringify({ type: "op", name: "setSimSpeed", args: [10] }));
    let speedOk = false;
    for (let i = 0; i < 15 && !speedOk; i++) {
      const t = await nextMessage(3000);
      if (t && t.type === "tick" && t.state && t.state.simSpeed === 10) speedOk = true;
    }
    if (speedOk) ok("setSimSpeed op applied (state.simSpeed === 10)");
    else fail("simSpeed never became 10 after op");
  } catch (e) { fail("setSimSpeed: " + e.message); }

  /* ---------- 7. rotctld 反映確認 ---------- */
  try {
    let azOk = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !azOk) {
      const remain = Math.max(500, deadline - Date.now());
      const t = await nextMessage(Math.min(3000, remain)).catch(() => null);
      if (!t || t.type !== "tick") continue;
      const st = t.state.stations.find((s) => s.id === "GS-TKY");
      if (st && Math.abs(st.antenna.az - FAKE_AZ) < 0.05 && Math.abs(st.antenna.el - FAKE_EL) < 0.05) azOk = true;
    }
    if (azOk) ok("GS-TKY antenna.az/el reflects fake rotctld response");
    else fail("GS-TKY antenna.az/el never reflected fake rotctld response");
  } catch (e) { fail("rotctld az reflect: " + e.message); }

  if (gotPCommand) ok("fake rotctld received a 'P' command from server");
  else fail("fake rotctld never received a 'P' command");

  /* ---------- 7b. PROP_BURN → 軌道反映確認 ---------- */
  try {
    ws.send(JSON.stringify({ type: "op", name: "setSimSpeed", args: [600] }));
    ws.send(JSON.stringify({ type: "op", name: "sendCommand", args: ["PROP_BURN", "PRO 200", null] }));

    let burnLog = null;
    let lastAlt = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !burnLog) {
      const m = await nextMessage(Math.max(500, deadline - Date.now())).catch(() => null);
      if (!m) continue;
      if (m.type === "tick") lastAlt = m.state.sat.pos.alt;
      if (m.type === "log" && m.entry && m.entry.source === "PROP" && /実行完了/.test(m.entry.msg)) burnLog = m.entry;
    }
    if (burnLog) ok("PROP_BURN EXEC → 軌道反映ログ受信: " + burnLog.msg);
    else fail("PROP_BURN の実行完了ログを受信できなかった (60s)");

    if (isFinite(lastAlt)) ok("PROP_BURN後もsat.pos.altが有限値を維持");
    else fail("PROP_BURN後のsat.pos.altが不正 (NaN/undefined): " + lastAlt);
  } catch (e) { fail("PROP_BURN: " + e.message); }

  /* ---------- 8. OBC 端末ブリッジ (擬似シェル: satshell 経由) ---------- */
  try {
    ws.send(JSON.stringify({ type: "term-open", cols: 80, rows: 24 }));
    const out1 = await waitForType("term-output", 5000);
    if (out1 && typeof out1.data === "string" && out1.data.length > 0) {
      ok("term-open produced initial term-output (login banner/prompt)");
    } else {
      fail("term-open did not produce an initial term-output message");
    }
  } catch (e) { fail("term-open: " + e.message); }

  try {
    ws.send(JSON.stringify({ type: "term-input", data: "uname -a\n" }));
    let combined = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && combined.indexOf("hikari-obc") === -1) {
      const m = await waitForType("term-output", Math.max(200, deadline - Date.now()));
      if (!m) break;
      combined += m.data;
    }
    if (combined.indexOf("hikari-obc") !== -1) ok("'uname -a' response contains 'hikari-obc'");
    else fail("'uname -a' response missing 'hikari-obc': " + JSON.stringify(combined).slice(0, 200));
  } catch (e) { fail("term uname -a: " + e.message); }

  try {
    ws.send(JSON.stringify({ type: "term-input", data: "tlm eps\n" }));
    let combined = "";
    const deadline = Date.now() + 5000;
    const looksGood = () => /SoC/i.test(combined) || /\d+(\.\d+)?\s*V\b/.test(combined);
    while (Date.now() < deadline && !looksGood()) {
      const m = await waitForType("term-output", Math.max(200, deadline - Date.now()));
      if (!m) break;
      combined += m.data;
    }
    if (looksGood()) ok("'tlm eps' response contains a voltage-like number or 'SoC'");
    else fail("'tlm eps' response missing expected content: " + JSON.stringify(combined).slice(0, 200));
  } catch (e) { fail("term tlm eps: " + e.message); }

  try {
    ws.send(JSON.stringify({ type: "term-close" }));
    ok("term-close sent");
  } catch (e) { fail("term-close: " + e.message); }

  try { ws.close(); } catch { /* ignore */ }

  child._expectedExit = true;
  cleanup();

  /* ---------- 9. 観測ベース軌道決定 (OD) ---------- */
  try {
    runOdTest();
  } catch (e) {
    fail("OD test threw: " + (e && e.stack || e));
  }

  if (failed) {
    console.log("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL PASS");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
