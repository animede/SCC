/* SCC satshell — HIKARI-1 OBC 擬似Linuxシェル (ブラウザ/Nodeサーバ両用)
   実PTYと同じく、エコー・行編集・履歴・プロンプト描画はすべてこのシェル側の責務。
   呼び出し側 (js/core/wsclient.js の SCC.net.term、または server/server.mjs の
   シムブリッジ) は以下の契約だけに依存する:

     SCC.satshell.createSession({ cols, rows, onOutput, onExit })
       → { write(str), resize(cols, rows), close() }

   - onOutput(str): ANSI エスケープを含む端末出力文字列。
   - write(str)   : 端末からの生入力バイト列 (1文字ずつ/まとめてのどちらも可)。
   - onExit(code) : セッション終了 (exit/logout/reboot/Ctrl-D)。

   外部依存なし・ESモジュール不使用 (他の core/*.js と同じ IIFE 流儀)。
   Node サーバでは globalThis.window = globalThis を張った上でこのファイルを
   eval するため、ブラウザと同一コードがそのまま動く。 */
(function () {
  "use strict";

  const HOSTNAME = "hikari-obc";
  const KERNEL = "Linux hikari-obc 5.15.0-rt-scc #1 SMP PREEMPT_RT aarch64";

  /* ---------- SCC.state / SCC.fmt への安全アクセス ---------- */
  function getSCC() { return (typeof window !== "undefined") ? window.SCC : null; }
  function getState() {
    const s = getSCC();
    return (s && s.state) ? s.state : null;
  }

  /* ---------- ANSI カラー ---------- */
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    boldBlue: "\x1b[1;34m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    grey: "\x1b[90m",
  };

  /* ---------- 小物フォーマッタ (SCC.fmt が無い環境でも動くよう自前で持つ) ---------- */
  const pad2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  function fmtHMS(d) { return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; }
  function fmtDateUTC(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function fmtCountdown(sec) {
    if (!isFinite(sec)) return "--:--";
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${pad2(m)}:${pad2(ss)}`;
  }
  function fmtUptime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${d}d ${pad2(h)}:${pad2(m)}:${pad2(ss)}`;
  }
  function num(v, digits, unit) {
    const scc = getSCC();
    if (scc && scc.fmt && typeof scc.fmt.num === "function") return scc.fmt.num(v, digits, unit || "");
    return isFinite(v) ? v.toFixed(digits) + (unit || "") : "---";
  }

  /* ============================================================
     仮想ファイルシステム
     ============================================================ */
  function dirNode(children) { return { type: "dir", children: children || {} }; }
  function fileNode(content) { return { type: "file", content }; }

  function cpuinfoContent() {
    const cores = [];
    for (let i = 0; i < 4; i++) {
      cores.push(
        `processor\t: ${i}\n` +
        `model name\t: SCC-Cortex-A72 rev4 (aarch64)\n` +
        `BogoMIPS\t: 108.00\n` +
        `Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32\n`
      );
    }
    return cores.join("\n") + "\n";
  }

  function meminfoContent() {
    const S = getState();
    const memPct = S ? S.sat.telemetry.cdh.mem : 41;
    const totalKB = 1048576; // 1GB 相当
    const usedKB = Math.round(totalKB * memPct / 100);
    const freeKB = totalKB - usedKB;
    return (
      `MemTotal:        ${totalKB} kB\n` +
      `MemFree:         ${freeKB} kB\n` +
      `MemAvailable:    ${freeKB} kB\n` +
      `Buffers:             0 kB\n` +
      `Cached:          ${Math.round(totalKB * 0.08)} kB\n`
    );
  }

  function uptimeFileContent() {
    const S = getState();
    const sec = S ? S.sat.telemetry.cdh.uptime : 0;
    return `${sec.toFixed(2)} ${(sec * 0.92).toFixed(2)}\n`;
  }

  function obcLogContent() {
    const S = getState();
    if (!S || !Array.isArray(S.history) || !S.history.length) {
      return [
        "[boot] obc_core: initializing subsystems",
        "[boot] adcs_ctl: IMU self-test PASS",
        "[boot] eps_mon: battery telemetry nominal",
        "[boot] comm_link: standing by",
      ].join("\n") + "\n";
    }
    return S.history.slice(0, 15).slice().reverse().map((e) => {
      const t = (e.t instanceof Date) ? fmtHMS(e.t) : "--:--:--";
      return `[${t}] ${e.source || "SYS"}: ${e.msg}`;
    }).join("\n") + "\n";
  }

  function buildFS() {
    return dirNode({
      bin: dirNode({
        bash: fileNode(""), ls: fileNode(""), cat: fileNode(""), ps: fileNode(""),
        top: fileNode(""), sh: fileNode(""), env: fileNode(""),
      }),
      etc: dirNode({
        "os-release": fileNode(
          'PRETTY_NAME="SCC-SatOS 3.2 LTS"\nNAME="SCC-SatOS"\nVERSION_ID="3.2"\nID=scc-satos\n' +
          'HOME_URL="https://hikari-1.example/"\n'
        ),
        hostname: fileNode(HOSTNAME + "\n"),
        motd: fileNode("HIKARI-1 OBC — 認可された運用者のみアクセス可能です。\n"),
      }),
      home: dirNode({
        ops: dirNode({
          "README": fileNode(
            "HIKARI-1 OBC 運用端末へようこそ。\n" +
            "'help' でコマンド一覧、'tlm'/'adcs'/'eps'/'comm'/'pass'/'gs'/'orbit' で\n" +
            "衛星の現在状態を確認できます。\n"
          ),
          ".bashrc": fileNode("# ops user bashrc\nexport PS1='\\u@\\h:\\w\\$ '\nexport TERM=xterm-256color\n"),
        }),
      }),
      proc: dirNode({
        cpuinfo: fileNode(cpuinfoContent),
        meminfo: fileNode(meminfoContent),
        uptime: fileNode(uptimeFileContent),
        version: fileNode(`${KERNEL}\n`),
      }),
      sys: dirNode({}),
      var: dirNode({
        log: dirNode({
          "obc.log": fileNode(obcLogContent),
        }),
      }),
      opt: dirNode({
        adcs: dirNode({ "adcs.conf": fileNode("mode=SUNPOINT\nkp=0.080\nki=0.002\nkd=0.015\n") }),
        eps: dirNode({ "eps.conf": fileNode("battery_chem=Li-ion\ncells=8s4p\nlow_soc_cutoff=15\n") }),
      }),
      boot: dirNode({ "vmlinuz-5.15.0-rt-scc": fileNode("(binary)\n") }),
    });
  }

  function splitPath(p) { return p.split("/").filter(Boolean); }

  // 相対/絶対/~ を解決して絶対パスのセグメント配列を返す
  function resolvePath(cwdSegs, input, homeSegs) {
    if (!input) return cwdSegs.slice();
    let segs;
    if (input === "~" || input.indexOf("~/") === 0) {
      const rest = input.slice(1).replace(/^\//, "");
      segs = homeSegs.slice().concat(splitPath(rest));
    } else if (input.charAt(0) === "/") {
      segs = splitPath(input);
    } else {
      segs = cwdSegs.slice().concat(splitPath(input));
    }
    const out = [];
    for (const s of segs) {
      if (s === "." || s === "") continue;
      if (s === "..") out.pop();
      else out.push(s);
    }
    return out;
  }

  function getNode(root, segs) {
    let node = root;
    for (const s of segs) {
      if (!node || node.type !== "dir" || !node.children[s]) return null;
      node = node.children[s];
    }
    return node;
  }

  function readFile(node, session) {
    if (!node || node.type !== "file") return null;
    return typeof node.content === "function" ? node.content(session) : node.content;
  }

  function displayPath(session) {
    const cwdStr = "/" + session.cwd.join("/");
    const homeStr = "/" + session.home.join("/");
    if (cwdStr === homeStr) return "~";
    if (cwdStr.indexOf(homeStr + "/") === 0) return "~" + cwdStr.slice(homeStr.length);
    return cwdStr;
  }

  /* ============================================================
     プロンプト / バナー
     ============================================================ */
  function promptStr(session) {
    const path = displayPath(session);
    const userColor = session.user === "root" ? C.red : C.green;
    const sym = session.user === "root" ? "#" : "$";
    return `${C.bold}${userColor}${session.user}@${HOSTNAME}${C.reset}:${C.boldBlue}${path}${C.reset}${sym} `;
  }

  function banner(session) {
    const S = getState();
    const now = S ? S.simTime : new Date();
    return [
      `${C.cyan}${C.bold}HIKARI-1 OBC — オンボードコンピュータ運用コンソール${C.reset}`,
      KERNEL,
      "",
      `Last login: ${fmtDateUTC(now)} ${fmtHMS(now)} UTC from ground-segment (${session.cols}x${session.rows})`,
      `${C.yellow}注意: これは実機OBCへの直接アクセスです。コマンド実行は衛星の状態に影響します。${C.reset}`,
      "'help' でコマンド一覧を表示します。",
      "",
    ].join("\r\n");
  }

  /* ============================================================
     行編集プリミティブ (session.line / session.cursor を書き換えつつ
     再描画に必要な ANSI 断片を返す)
     ============================================================ */
  function insertText(session, text) {
    if (!text) return "";
    const before = session.line.slice(0, session.cursor);
    const after = session.line.slice(session.cursor);
    session.line = before + text + after;
    session.cursor += text.length;
    let s = text + after;
    if (after.length > 0) s += `\x1b[${after.length}D`;
    return s;
  }

  function backspaceEffect(session) {
    if (session.cursor === 0) return "";
    const before = session.line.slice(0, session.cursor - 1);
    const after = session.line.slice(session.cursor);
    session.line = before + after;
    session.cursor--;
    let s = "\b" + after + " ";
    const back = after.length + 1;
    s += `\x1b[${back}D`;
    return s;
  }

  function delForwardEffect(session) {
    if (session.cursor >= session.line.length) return "";
    const after = session.line.slice(session.cursor + 1);
    session.line = session.line.slice(0, session.cursor) + after;
    let s = after + " ";
    const back = after.length + 1;
    s += `\x1b[${back}D`;
    return s;
  }

  function moveLeft(session) {
    if (session.cursor === 0) return "";
    session.cursor--;
    return "\x1b[D";
  }
  function moveRight(session) {
    if (session.cursor >= session.line.length) return "";
    session.cursor++;
    return "\x1b[C";
  }
  function moveHome(session) {
    if (session.cursor === 0) return "";
    const back = session.cursor;
    session.cursor = 0;
    return `\x1b[${back}D`;
  }
  function moveEnd(session) {
    if (session.cursor >= session.line.length) return "";
    const fwd = session.line.length - session.cursor;
    session.cursor = session.line.length;
    return `\x1b[${fwd}C`;
  }

  // カーソル位置の現在行をまるごと newLine に置き換えて再描画 (履歴呼び出し用)
  function redrawLine(session, newLine) {
    let s = "";
    if (session.cursor > 0) s += `\x1b[${session.cursor}D`;
    s += "\x1b[K" + newLine;
    session.line = newLine;
    session.cursor = newLine.length;
    return s;
  }

  function pushHistory(session, line) {
    if (!line) return;
    if (session.history[session.history.length - 1] === line) return;
    session.history.push(line);
    if (session.history.length > 50) session.history.shift();
  }

  function histUp(session) {
    if (!session.history.length) return "";
    if (session.histIndex === -1) {
      session.savedLine = session.line;
      session.histIndex = session.history.length - 1;
    } else if (session.histIndex > 0) {
      session.histIndex--;
    } else {
      return "";
    }
    return redrawLine(session, session.history[session.histIndex]);
  }
  function histDown(session) {
    if (session.histIndex === -1) return "";
    if (session.histIndex < session.history.length - 1) {
      session.histIndex++;
      return redrawLine(session, session.history[session.histIndex]);
    }
    session.histIndex = -1;
    return redrawLine(session, session.savedLine || "");
  }

  function handleEscape(session, seq) {
    switch (seq) {
      case "[A": return histUp(session);
      case "[B": return histDown(session);
      case "[C": return moveRight(session);
      case "[D": return moveLeft(session);
      case "[3~": return delForwardEffect(session);
      case "[H": case "[1~": return moveHome(session);
      case "[F": case "[4~": return moveEnd(session);
      default: return "";
    }
  }

  function tabComplete(session) {
    const line = session.line, cursor = session.cursor;
    const wStart = line.lastIndexOf(" ", cursor - 1) + 1;
    const word = line.slice(wStart, cursor);
    const isFirstWord = line.slice(0, wStart).trim() === "";
    let candidates = [];
    if (isFirstWord) {
      candidates = Object.keys(COMMANDS).filter((c) => c.indexOf(word) === 0).sort();
    } else {
      const idx = word.lastIndexOf("/");
      const dirPart = idx >= 0 ? word.slice(0, idx + 1) : "";
      const prefix = idx >= 0 ? word.slice(idx + 1) : word;
      const dirSegs = resolvePath(session.cwd, dirPart || ".", session.home);
      const node = getNode(session.fs, dirSegs);
      if (node && node.type === "dir") {
        candidates = Object.keys(node.children)
          .filter((n) => n.indexOf(prefix) === 0)
          .sort()
          .map((n) => dirPart + n + (node.children[n].type === "dir" ? "/" : ""));
      }
    }
    if (candidates.length === 0) return "\x07";
    if (candidates.length === 1) return insertText(session, candidates[0].slice(word.length));
    let s = "\r\n" + candidates.join("  ") + "\r\n";
    s += promptStr(session) + session.line;
    const back = session.line.length - session.cursor;
    if (back > 0) s += `\x1b[${back}D`;
    return s;
  }

  /* ============================================================
     コマンドライン解析
     ============================================================ */
  function tokenize(s) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
    return out;
  }

  // 末尾の `> file` / `>> file` をごく簡易に検出 (引用符内の '>' は考慮しない)
  function parseRedirect(line) {
    const m = line.match(/^(.*?)(>>|>)\s*(\S+)\s*$/);
    if (!m || !m[1].trim()) return null;
    return { cmd: m[1].trim(), append: m[2] === ">>", file: m[3] };
  }

  function writeFileRedirect(session, fileArg, content, append) {
    const segs = resolvePath(session.cwd, fileArg, session.home);
    const name = segs.pop();
    if (!name) return;
    const parent = getNode(session.fs, segs);
    if (!parent || parent.type !== "dir") return;
    const existing = parent.children[name];
    const prev = (append && existing && existing.type === "file") ? (readFile(existing, session) || "") : "";
    const body = content + (content.length && content.charAt(content.length - 1) !== "\n" ? "\n" : "");
    parent.children[name] = fileNode(prev + body);
  }

  /* ============================================================
     コマンド実装
     ============================================================ */
  function cmdHelp() {
    return [
      "利用可能コマンド:",
      "  Linux基本 : pwd cd ls cat echo mkdir touch rm clear whoami id hostname",
      "              uname uptime date ps top free df dmesg env history sudo",
      "              reboot shutdown exit logout",
      "  衛星固有  : tlm [eps|tcs|adcs|com|cdh]   テレメトリ表示",
      "              adcs / eps / comm            サブシステム状態",
      "              pass [next|list]             パス予測",
      "              gs / stations                 地上局一覧",
      "              orbit                          軌道要素・現在位置",
      "              sysinfo                        機体諸元 (neofetch風)",
      "キー: ↑/↓ 履歴, ←/→ カーソル移動, Tab 補完, Ctrl-C 中断, Ctrl-D ログアウト, Ctrl-L 画面クリア",
    ].join("\n");
  }

  function cmdPwd(args, session) { return "/" + session.cwd.join("/"); }

  function cmdCd(args, session) {
    const target = args[0] || "~";
    const segs = resolvePath(session.cwd, target, session.home);
    const node = getNode(session.fs, segs);
    if (!node) return `bash: cd: ${target}: そのようなファイルやディレクトリはありません`;
    if (node.type !== "dir") return `bash: cd: ${target}: ディレクトリではありません`;
    session.cwd = segs;
    return "";
  }

  function cmdLs(args, session) {
    const opts = args.filter((a) => a.charAt(0) === "-").join("");
    const paths = args.filter((a) => a.charAt(0) !== "-");
    const target = paths[0] || ".";
    const segs = resolvePath(session.cwd, target, session.home);
    const node = getNode(session.fs, segs);
    if (!node) return `ls: ${target}: そのようなファイルやディレクトリはありません`;
    if (node.type === "file") return target;
    let names = Object.keys(node.children);
    if (opts.indexOf("a") === -1) names = names.filter((n) => n.charAt(0) !== ".");
    names.sort();
    if (opts.indexOf("l") !== -1) {
      return names.map((n) => {
        const c = node.children[n];
        const isDir = c.type === "dir";
        const content = isDir ? null : readFile(c, session);
        const size = isDir ? 4096 : (content || "").length;
        const perm = isDir ? "drwxr-xr-x" : "-rw-r--r--";
        const label = isDir ? `${C.boldBlue}${n}${C.reset}` : n;
        return `${perm} 1 ops ops ${String(size).padStart(6)} Jan  1 00:00 ${label}`;
      }).join("\n");
    }
    return names.map((n) => (node.children[n].type === "dir" ? `${C.boldBlue}${n}${C.reset}` : n)).join("  ");
  }

  function cmdCat(args, session) {
    if (!args.length) return "cat: 引数がありません";
    const outs = [];
    for (const a of args) {
      const segs = resolvePath(session.cwd, a, session.home);
      const node = getNode(session.fs, segs);
      if (!node) { outs.push(`cat: ${a}: そのようなファイルやディレクトリはありません`); continue; }
      if (node.type === "dir") { outs.push(`cat: ${a}: ディレクトリです`); continue; }
      const content = readFile(node, session) || "";
      outs.push(content.replace(/\n$/, ""));
    }
    return outs.join("\n");
  }

  function cmdEcho(args, session) {
    return args.map((a) => a.replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, v) => (session.env[v] !== undefined ? session.env[v] : ""))).join(" ");
  }

  function cmdMkdir(args, session) {
    if (!args.length) return "mkdir: 引数がありません";
    const msgs = [];
    for (const a of args) {
      const segs = resolvePath(session.cwd, a, session.home);
      const name = segs.pop();
      if (!name) { msgs.push(`mkdir: ${a}: 無効なパスです`); continue; }
      const parent = getNode(session.fs, segs);
      if (!parent || parent.type !== "dir") { msgs.push(`mkdir: ${a}: そのようなディレクトリはありません`); continue; }
      if (parent.children[name]) { msgs.push(`mkdir: ${a}: すでに存在します`); continue; }
      parent.children[name] = dirNode({});
    }
    return msgs.join("\n");
  }

  function cmdTouch(args, session) {
    if (!args.length) return "touch: 引数がありません";
    const msgs = [];
    for (const a of args) {
      const segs = resolvePath(session.cwd, a, session.home);
      const name = segs.pop();
      if (!name) { msgs.push(`touch: ${a}: 無効なパスです`); continue; }
      const parent = getNode(session.fs, segs);
      if (!parent || parent.type !== "dir") { msgs.push(`touch: ${a}: そのようなディレクトリはありません`); continue; }
      if (!parent.children[name]) parent.children[name] = fileNode("");
    }
    return msgs.join("\n");
  }

  function cmdRm(args, session) {
    const opts = args.filter((a) => a.charAt(0) === "-");
    const paths = args.filter((a) => a.charAt(0) !== "-");
    const recursive = opts.some((o) => o.indexOf("r") !== -1 || o.indexOf("R") !== -1);
    const msgs = [];
    for (const a of paths) {
      const segs = resolvePath(session.cwd, a, session.home);
      const name = segs.pop();
      const parent = name ? getNode(session.fs, segs) : null;
      if (!parent || !parent.children[name]) { msgs.push(`rm: ${a}: そのようなファイルやディレクトリはありません`); continue; }
      const node = parent.children[name];
      if (node.type === "dir" && !recursive && Object.keys(node.children).length) {
        msgs.push(`rm: ${a}: ディレクトリです (-r が必要です)`); continue;
      }
      delete parent.children[name];
    }
    return msgs.join("\n");
  }

  function cmdClear() { return "\x1b[2J\x1b[H"; }

  function cmdWhoami(args, session) { return session.user; }
  function cmdId(args, session) {
    return session.user === "root"
      ? "uid=0(root) gid=0(root) groups=0(root)"
      : "uid=1000(ops) gid=1000(ops) groups=1000(ops),27(sudo)";
  }
  function cmdHostname() { return HOSTNAME; }
  function cmdUname(args) {
    if (args.indexOf("-a") !== -1) return `${KERNEL} aarch64 GNU/Linux`;
    return "Linux";
  }

  function cmdUptime() {
    const S = getState();
    const secs = S ? S.sat.telemetry.cdh.uptime : 0;
    const cpu = S ? S.sat.telemetry.cdh.cpu : 30;
    const now = S ? S.simTime : new Date();
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return ` ${fmtHMS(now)} up ${d} days, ${h}:${pad2(m)}, 1 user, load average: ${(cpu / 100 * 1.2).toFixed(2)}, ${(cpu / 100).toFixed(2)}, ${(cpu / 100 * 0.8).toFixed(2)}`;
  }

  function cmdDate() {
    const S = getState();
    const d = S ? S.simTime : new Date();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  }

  function cmdPs() {
    const rows = [
      ["PID", "TTY", "TIME", "CMD"],
      ["1", "?", "00:00:12", "/sbin/init"],
      ["112", "?", "00:04:41", "obc_core"],
      ["118", "?", "00:02:03", "adcs_ctl"],
      ["121", "?", "00:01:37", "eps_mon"],
      ["134", "?", "00:03:58", "comm_link"],
      ["140", "?", "00:00:52", "payload_mgr"],
      ["201", "?", "00:00:09", "sshd"],
      ["205", "pts/0", "00:00:00", "bash"],
      ["209", "pts/0", "00:00:00", "ps"],
    ];
    return rows.map((r) => `${r[0].padStart(5)} ${r[1].padEnd(6)} ${r[2].padStart(8)} ${r[3]}`).join("\n");
  }

  function cmdTop() {
    const S = getState();
    const cpu = S ? S.sat.telemetry.cdh.cpu : 30;
    const mem = S ? S.sat.telemetry.cdh.mem : 41;
    const now = S ? S.simTime : new Date();
    return [
      `top - ${fmtHMS(now)} up, 1 user, load average: ${(cpu / 100).toFixed(2)}`,
      "Tasks:   9 total,   1 running,   8 sleeping",
      `%Cpu(s): ${cpu.toFixed(1)} us, ${(100 - cpu).toFixed(1)} id`,
      `MiB Mem : 1024.0 total, ${(1024 * (1 - mem / 100)).toFixed(1)} free, ${(1024 * mem / 100).toFixed(1)} used`,
      "",
      "  PID USER   PR  NI    VIRT    RES  %CPU  %MEM  TIME+  COMMAND",
      `  112 root   20   0   45120  12040  ${(cpu * 0.40).toFixed(1)}  ${(mem * 0.30).toFixed(1)}  4:41.02 obc_core`,
      `  134 root   20   0   38040   9820  ${(cpu * 0.30).toFixed(1)}  ${(mem * 0.20).toFixed(1)}  3:58.71 comm_link`,
      `  118 root   20   0   22080   6144  ${(cpu * 0.15).toFixed(1)}  ${(mem * 0.15).toFixed(1)}  2:03.10 adcs_ctl`,
      `  121 root   20   0   18040   4096  ${(cpu * 0.10).toFixed(1)}  ${(mem * 0.10).toFixed(1)}  1:37.44 eps_mon`,
    ].join("\n");
  }

  function cmdFree() {
    const S = getState();
    const memPct = S ? S.sat.telemetry.cdh.mem : 41;
    const totalMB = 1024;
    const usedMB = Math.round(totalMB * memPct / 100), freeMB = totalMB - usedMB;
    return [
      "              total        used        free      shared  buff/cache   available",
      `Mem:           ${totalMB}         ${usedMB}         ${freeMB}           0          64        ${freeMB + 64}`,
      "Swap:             0           0           0",
    ].join("\n");
  }

  function cmdDf() {
    const S = getState();
    const pct = S ? S.sat.telemetry.cdh.storagePct : 36;
    const totalGB = 8;
    const usedGB = (totalGB * pct / 100);
    const availGB = totalGB - usedGB;
    return [
      "Filesystem      Size  Used Avail Use% Mounted on",
      `/dev/mmcblk0p2  ${totalGB}.0G  ${usedGB.toFixed(1)}G  ${availGB.toFixed(1)}G  ${Math.round(pct)}% /`,
      "/dev/mmcblk0p1  128M   38M   90M  30% /boot",
    ].join("\n");
  }

  function cmdDmesg() {
    const S = getState();
    const boot = S ? S.sat.telemetry.cdh.bootCount : 47;
    return [
      "[    0.000000] Booting Linux on physical CPU 0x0",
      "[    0.000000] Linux version 5.15.0-rt-scc (build@scc) #1 SMP PREEMPT_RT",
      "[    0.412008] CPU: All CPU(s) started",
      "[    1.203981] obc_core: telemetry bus initialized",
      "[    1.401220] adcs_ctl: IMU calibration OK",
      "[    1.622310] eps_mon: battery pack detected (8s4p Li-ion)",
      "[    2.011932] comm_link: S/X transceiver ready",
      `[    2.301442] systemd[1]: Boot #${boot} complete`,
    ].join("\n");
  }

  function cmdEnv(args, session) {
    return Object.keys(session.env).map((k) => `${k}=${session.env[k]}`).join("\n");
  }

  function cmdHistory(args, session) {
    return session.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n");
  }

  function cmdSudo(args, session) {
    if (!args.length || args[0] === "-s") { session.user = "root"; return ""; }
    const prevUser = session.user;
    session.user = "root";
    let res;
    try { res = dispatch(session, args[0], args.slice(1)); }
    finally { session.user = prevUser === "root" ? "root" : "ops"; }
    return res;
  }

  // 注意: ここでは session.exited フラグを立てるだけで onExit() は呼ばない。
  // 呼び出し元 (processInput) がこのコマンドの出力メッセージを onOutput で
  // 送信し終えてから onExit() を呼ぶ — 「メッセージ表示 → 切断」の順序を保証するため。
  function cmdReboot(args, session) {
    session.exited = true;
    session.exitCode = 0;
    return "システム再起動シーケンス開始...\n約90秒後にOBCが再起動します。コンソール接続はここで切断されます。";
  }

  function cmdShutdown() {
    return "shutdown: 実機シャットダウンには地上局からの確認コマンド(OBC_SHUTDOWN_CONFIRM)が必要です。\nこのコンソールからは実行されません。";
  }

  function cmdExit(args, session) {
    if (session.user === "root") { session.user = "ops"; return ""; }
    session.exited = true;
    session.exitCode = 0;
    return "logout";
  }

  function cmdLogout(args, session) {
    session.exited = true;
    session.exitCode = 0;
    return "logout";
  }

  /* ---- 衛星固有コマンド ---- */
  function cmdTlm(args) {
    const S = getState();
    if (!S) return "tlm: テレメトリ取得不可 (SCC.state 未初期化)";
    const t = S.sat.telemetry;
    const sub = (args[0] || "").toLowerCase();
    const map = {
      eps: () => [
        "--- EPS ---",
        `Bus Voltage : ${num(t.eps.busV, 2, "V")}`,
        `Bus Current : ${num(t.eps.busI, 2, "A")}`,
        `SoC         : ${num(t.eps.soc, 0, "%")}`,
        `Solar Power : ${num(t.eps.solarW, 0, "W")}`,
        `Battery Temp: ${num(t.eps.battT, 1, "C")}`,
      ].join("\n"),
      tcs: () => [
        "--- TCS ---",
        `OBC Temp    : ${num(t.tcs.obcT, 1, "C")}`,
        `COMM Temp   : ${num(t.tcs.commT, 1, "C")}`,
        `Panel Temp  : ${num(t.tcs.panelT, 1, "C")}`,
        `Batt Temp   : ${num(t.tcs.battT, 1, "C")}`,
      ].join("\n"),
      adcs: () => [
        "--- ADCS ---",
        `Mode        : ${t.adcs.mode}`,
        `Rate X/Y/Z  : ${num(t.adcs.rateX, 3)} / ${num(t.adcs.rateY, 3)} / ${num(t.adcs.rateZ, 3)} deg/s`,
        `Sun Angle   : ${num(t.adcs.sunAngle, 1, "°")}`,
        `Quaternion  : [${t.adcs.quat.map((v) => v.toFixed(3)).join(", ")}]`,
      ].join("\n"),
      com: () => [
        "--- COM ---",
        `Mode        : ${t.com.mode}`,
        `RSSI        : ${num(t.com.rssi, 1, "dBm")}`,
        `SNR         : ${num(t.com.snr, 1, "dB")}`,
        `Bitrate     : ${num(t.com.bitrate, 2, "Mbps")}`,
        `AGC         : ${num(t.com.agc, 0)}`,
      ].join("\n"),
      cdh: () => [
        "--- CDH ---",
        `CPU         : ${num(t.cdh.cpu, 0, "%")}`,
        `Memory      : ${num(t.cdh.mem, 0, "%")}`,
        `Storage     : ${num(t.cdh.storagePct, 0, "%")}`,
        `Uptime      : ${fmtUptime(t.cdh.uptime)}`,
        `Boot Count  : ${t.cdh.bootCount}`,
      ].join("\n"),
    };
    if (!sub) {
      return [
        `=== HIKARI-1 テレメトリ概要 (orbit #${S.sat.orbitNo}) ===`,
        `EPS : busV=${num(t.eps.busV, 2, "V")} soc=${num(t.eps.soc, 0, "%")} solar=${num(t.eps.solarW, 0, "W")} battT=${num(t.eps.battT, 1, "C")}`,
        `TCS : obcT=${num(t.tcs.obcT, 1, "C")} commT=${num(t.tcs.commT, 1, "C")} panelT=${num(t.tcs.panelT, 1, "C")}`,
        `ADCS: mode=${t.adcs.mode} rate=[${num(t.adcs.rateX, 3)}, ${num(t.adcs.rateY, 3)}, ${num(t.adcs.rateZ, 3)}] deg/s sun=${num(t.adcs.sunAngle, 1, "°")}`,
        `COM : mode=${t.com.mode} rssi=${num(t.com.rssi, 1, "dBm")} snr=${num(t.com.snr, 1, "dB")} bitrate=${num(t.com.bitrate, 2, "Mbps")}`,
        `CDH : cpu=${num(t.cdh.cpu, 0, "%")} mem=${num(t.cdh.mem, 0, "%")} storage=${num(t.cdh.storagePct, 0, "%")} boot#${t.cdh.bootCount}`,
        "使い方: tlm eps|tcs|adcs|com|cdh でサブシステム詳細",
      ].join("\n");
    }
    if (map[sub]) return map[sub]();
    return `tlm: 不明なサブシステム '${sub}' (eps|tcs|adcs|com|cdh)`;
  }

  function cmdAdcs() {
    const S = getState();
    if (!S) return "adcs: 状態取得不可";
    const t = S.sat.telemetry.adcs;
    return [
      "ADCS STATUS",
      `Mode       : ${t.mode}`,
      `Rate(x,y,z): ${t.rateX.toFixed(3)}, ${t.rateY.toFixed(3)}, ${t.rateZ.toFixed(3)} deg/s`,
      `Sun Angle  : ${isFinite(t.sunAngle) ? t.sunAngle.toFixed(1) + "°" : "--- (eclipse)"}`,
    ].join("\n");
  }

  function cmdEps() {
    const S = getState();
    if (!S) return "eps: 状態取得不可";
    const e = S.sat.telemetry.eps;
    return [
      "EPS STATUS",
      `Bus Voltage: ${e.busV.toFixed(2)} V`,
      `SoC        : ${e.soc.toFixed(0)} %`,
      `Solar Power: ${e.solarW.toFixed(0)} W`,
      `Battery T  : ${e.battT.toFixed(1)} °C`,
    ].join("\n");
  }

  function cmdComm() {
    const S = getState();
    if (!S) return "comm: 状態取得不可";
    const locked = S.stations.filter((s) => s.antenna.lock);
    if (!locked.length) return "COMM STATUS\nリンクなし (圏外)";
    const lines = ["COMM STATUS", "STATION   RSSI[dBm]  SNR[dB]  BITRATE[Mbps]"];
    for (const st of locked) {
      lines.push(`${st.id.padEnd(9)} ${st.antenna.rssi.toFixed(1).padStart(9)}  ${st.antenna.snr.toFixed(1).padStart(6)}  ${(S.sat.telemetry.com.bitrate || 0).toFixed(2).padStart(12)}`);
    }
    return lines.join("\n");
  }

  function cmdPass(args) {
    const S = getState();
    if (!S) return "pass: 情報取得不可";
    const sub = args[0] || "next";
    if (sub === "list") {
      if (!S.passes.length) return "パス予定なし";
      return S.passes.slice(0, 10).map((p) => `${p.station}  AOS ${fmtHMS(p.aos)}  LOS ${fmtHMS(p.los)}  maxEl ${p.maxEl.toFixed(0)}°  [${p.status}]`).join("\n");
    }
    const nxt = S.passes.find((p) => p.status === "upcoming");
    if (!nxt) return "次パスなし";
    const secs = (nxt.aos.getTime() - S.simTime.getTime()) / 1000;
    return `次パス: ${nxt.station}  AOS ${fmtHMS(nxt.aos)} UTC (T-${fmtCountdown(secs)})  maxEl ${nxt.maxEl.toFixed(0)}°`;
  }

  function cmdGs() {
    const S = getState();
    if (!S) return "gs: 情報取得不可";
    const lines = ["ID       NAME              BAND   DISH   MODE      AZ     EL   LOCK"];
    for (const st of S.stations) {
      lines.push(`${st.id.padEnd(8)} ${st.name.padEnd(17)} ${st.band.padEnd(6)} ${st.dish.padEnd(6)} ${st.antenna.mode.padEnd(9)} ${st.antenna.az.toFixed(1).padStart(6)} ${st.antenna.el.toFixed(1).padStart(6)}  ${st.antenna.lock ? "LOCK" : "-"}`);
    }
    return lines.join("\n");
  }

  function cmdOrbit() {
    const scc = getSCC();
    const S = getState();
    if (!scc || !scc.orbit) return "orbit: 軌道情報取得不可";
    const o = scc.orbit;
    const tle = typeof o.getTLE === "function" ? o.getTLE() : null;
    const lines = ["=== 軌道情報 ==="];
    if (tle && tle.line1) { lines.push(tle.line1); lines.push(tle.line2); }
    if (typeof o.PERIOD === "number") lines.push(`周期    : ${(o.PERIOD / 60).toFixed(2)} min`);
    if (typeof o.ALT === "number") lines.push(`高度    : ${o.ALT.toFixed(1)} km`);
    if (S) lines.push(`現在位置: ${S.sat.pos.lat.toFixed(3)}°, ${S.sat.pos.lon.toFixed(3)}°  高度 ${S.sat.pos.alt.toFixed(1)} km`);
    return lines.join("\n");
  }

  function cmdSysinfo() {
    const S = getState();
    const art = [
      "     .  *  .    ___",
      "  *    __|[_]|__    *",
      "    __|  HIKARI-1 |__",
      "  *   |____________|   .",
      "     .  *    .   *",
    ];
    const info = [
      `${C.bold}ops@${HOSTNAME}${C.reset}`,
      "-----------------",
      "Mission  : HIKARI-1 (ひかり1号)",
      "Bus      : 50kg級マイクロサット",
      `OS       : SCC-SatOS 3.2 LTS`,
      `Kernel   : 5.15.0-rt-scc`,
    ];
    if (S) {
      info.push(`Orbit    : #${S.sat.orbitNo}`);
      info.push(`Uptime   : ${fmtUptime(S.sat.telemetry.cdh.uptime)}`);
      info.push(`EPS SoC  : ${num(S.sat.telemetry.eps.soc, 0, "%")}`);
      info.push(`ADCS     : ${S.sat.telemetry.adcs.mode}`);
    }
    const lines = [];
    const n = Math.max(art.length, info.length);
    for (let i = 0; i < n; i++) lines.push(`${C.cyan}${(art[i] || "").padEnd(26)}${C.reset}${info[i] || ""}`);
    return lines.join("\n");
  }

  const COMMANDS = {
    help: cmdHelp, pwd: cmdPwd, cd: cmdCd, ls: cmdLs, cat: cmdCat, echo: cmdEcho,
    mkdir: cmdMkdir, touch: cmdTouch, rm: cmdRm, clear: cmdClear,
    whoami: cmdWhoami, id: cmdId, hostname: cmdHostname, uname: cmdUname,
    uptime: cmdUptime, date: cmdDate, ps: cmdPs, top: cmdTop, free: cmdFree,
    df: cmdDf, dmesg: cmdDmesg, env: cmdEnv, history: cmdHistory, sudo: cmdSudo,
    reboot: cmdReboot, shutdown: cmdShutdown, exit: cmdExit, logout: cmdLogout,
    tlm: cmdTlm, adcs: cmdAdcs, eps: cmdEps, comm: cmdComm, pass: cmdPass,
    gs: cmdGs, stations: cmdGs, orbit: cmdOrbit, sysinfo: cmdSysinfo,
  };

  function dispatch(session, cmd, args) {
    if (!cmd) return "";
    const fn = COMMANDS[cmd];
    if (!fn) return `bash: ${cmd}: command not found`;
    return fn(args, session) || "";
  }

  function runLine(session, line) {
    if (!line) return "";
    const redirect = parseRedirect(line);
    const cmdLine = redirect ? redirect.cmd : line;
    const tokens = tokenize(cmdLine);
    if (!tokens.length) return "";
    const cmd = tokens[0];
    const args = tokens.slice(1);
    let result;
    try { result = dispatch(session, cmd, args); }
    catch (e) { result = `satshell: 内部エラー: ${e.message}`; }
    if (result == null) result = "";
    if (redirect) {
      writeFileRedirect(session, redirect.file, result, redirect.append);
      return "";
    }
    if (cmd === "clear") return result; // 画面クリアは生ANSIのまま (改行を足さない)
    return result ? result.replace(/\n/g, "\r\n") + "\r\n" : "";
  }

  /* ============================================================
     入力処理 (キー入力バイト列 → エコー/行編集/コマンド実行)
     ============================================================ */
  function isPrintable(ch) {
    const code = ch.codePointAt(0);
    return code >= 0x20 && code !== 0x7f;
  }

  function processInput(session, data) {
    if (session.exited || typeof data !== "string" || !data.length) return;
    let out = "";
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (session.esc) {
        session.escSeq += ch;
        i++;
        if (session.escSeq.length === 1) {
          if (ch !== "[" && ch !== "O") { session.esc = false; session.escSeq = ""; }
          continue;
        }
        if (/[A-Za-z~]/.test(ch)) {
          out += handleEscape(session, session.escSeq);
          session.esc = false; session.escSeq = "";
        }
        continue;
      }
      if (ch === "\x1b") { session.esc = true; session.escSeq = ""; i++; continue; }

      if (ch === "\r" || ch === "\n") {
        i++;
        if (ch === "\r" && data.charAt(i) === "\n") i++; // CRLF は1つの改行として扱う
        out += "\r\n";
        session.onOutput(out); out = "";
        const cmdLine = session.line;
        session.line = ""; session.cursor = 0; session.histIndex = -1;
        if (cmdLine.trim()) pushHistory(session, cmdLine.trim());
        const res = runLine(session, cmdLine.trim());
        if (res) session.onOutput(res);
        if (session.exited) {
          if (session.onExit) session.onExit(session.exitCode || 0);
          return;
        }
        session.onOutput(promptStr(session));
        continue;
      }

      if (ch === "\x7f" || ch === "\b") { out += backspaceEffect(session); i++; continue; }

      if (ch === "\x03") { // Ctrl-C
        out += "^C\r\n";
        session.line = ""; session.cursor = 0; session.histIndex = -1;
        out += promptStr(session);
        i++; continue;
      }

      if (ch === "\x04") { // Ctrl-D
        if (session.line === "") {
          out += "logout\r\n";
          session.onOutput(out); out = "";
          session.exited = true;
          if (session.onExit) session.onExit(0);
          return;
        }
        i++; continue;
      }

      if (ch === "\x0c") { // Ctrl-L
        out += "\x1b[2J\x1b[H" + promptStr(session) + session.line;
        const back = session.line.length - session.cursor;
        if (back > 0) out += `\x1b[${back}D`;
        i++; continue;
      }

      if (ch === "\t") { out += tabComplete(session); i++; continue; }

      if (isPrintable(ch)) {
        let j = i;
        while (j < data.length && isPrintable(data.charAt(j))) j++;
        out += insertText(session, data.slice(i, j));
        i = j;
        continue;
      }

      i++; // 未対応の制御文字は無視
    }
    if (out) session.onOutput(out);
  }

  /* ============================================================
     公開API
     ============================================================ */
  function createSession(opts) {
    opts = opts || {};
    const session = {
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: ["home", "ops"],
      home: ["home", "ops"],
      user: "ops",
      fs: buildFS(),
      line: "", cursor: 0,
      history: [], histIndex: -1, savedLine: "",
      esc: false, escSeq: "",
      exited: false, exitCode: 0,
      env: { PATH: "/bin:/usr/bin", HOME: "/home/ops", USER: "ops", SHELL: "/bin/bash", TERM: "xterm-256color" },
      onOutput: typeof opts.onOutput === "function" ? opts.onOutput : function () {},
      onExit: typeof opts.onExit === "function" ? opts.onExit : null,
    };

    setTimeout(function () {
      if (session.exited) return;
      session.onOutput(banner(session) + promptStr(session));
    }, 0);

    return {
      write(str) { processInput(session, str); },
      resize(cols, rows) { session.cols = cols || session.cols; session.rows = rows || session.rows; },
      close() { session.exited = true; },
    };
  }

  if (typeof window === "undefined") { /* Node の間接eval経由でも globalThis.window が張られている前提 */ }
  window.SCC = window.SCC || {};
  window.SCC.satshell = { createSession };
})();
