/* SCC panels — terminal.js
   SPEC.md §5(OBC CONSOLE / #panel-term) 実装。
   衛星OBC(Linux)への SSH ターミナルUI。VT100サブセットの自前エミュレータ(canvas描画)。
   セッションは SCC.net.term(js/core/wsclient.js)経由でモード非依存に確立する。
   ローカルエコーは行わない — シェル側のエコーバックのみを画面に反映する。 */
(function () {
  "use strict";

  const bus = SCC.bus;

  /* ============================================================ CSS ============================================================ */
  function injectCSS() {
    if (document.getElementById("term-style")) return;
    const style = document.createElement("style");
    style.id = "term-style";
    style.textContent = `
      #term-body { background: var(--surface-in); overflow: hidden; }
      .term-canvas {
        position: absolute; inset: 8px;
        width: calc(100% - 16px); height: calc(100% - 16px);
        display: block; cursor: text;
      }
      .term-canvas:focus, .term-canvas:focus-visible { outline: none; }
      .term-hidden-input {
        position: absolute; inset: 8px;
        width: calc(100% - 16px); height: calc(100% - 16px);
        opacity: 0; border: none; outline: none; resize: none; padding: 0; margin: 0;
        background: transparent; color: transparent; caret-color: transparent;
        overflow: hidden; white-space: pre;
      }
      .term-badge { cursor: default; }
    `;
    document.head.appendChild(style);
  }

  /* ============================================================ ANSI/VT100 パレット ============================================================ */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function buildPalette() {
    const bg = cssVar("--surface-in", "#101216");
    const fg = cssVar("--ink", "#e8eaed");
    const ink3 = cssVar("--ink-3", "#6b7076");
    const s1 = cssVar("--s1", "#3987e5");   // 青
    const s2 = cssVar("--s2", "#199e70");   // アクア(緑寄り)
    const s5 = cssVar("--s5", "#9085e9");   // 紫
    const s6 = cssVar("--s6", "#e66767");   // 赤系(bright red)
    const warn = cssVar("--warn", "#fab219");
    const crit = cssVar("--crit", "#d03b3b");
    return {
      bg, fg, ink3, cursor: fg,
      // 0:黒 1:赤 2:緑 3:黄 4:青 5:マゼンタ 6:シアン 7:白
      basic: ["#3a3f47", crit, s2, warn, s1, s5, "#3ad6c9", fg],
      bright: [ink3, s6, "#2fd499", "#ffd166", "#6ea8f0", "#b3a9f5", "#7be8de", "#ffffff"],
    };
  }

  function xterm256(pal, n) {
    n = n | 0;
    if (n < 8) return pal.basic[n];
    if (n < 16) return pal.bright[n - 8];
    if (n < 232) {
      const idx = n - 16;
      const r = Math.floor(idx / 36), g = Math.floor((idx % 36) / 6), b = idx % 6;
      const lv = [0, 95, 135, 175, 215, 255];
      return `rgb(${lv[r]},${lv[g]},${lv[b]})`;
    }
    const gray = 8 + (n - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
  }

  /* ============================================================ 端末インスタンス ============================================================ */
  function createTerminal(canvas, hiddenInput, w, h, ctx) {
    const FONT_STACK = 'ui-monospace, "Cascadia Code", Consolas, monospace';
    const FONT_SIZE = 13;
    const PAL = buildPalette();
    const SCROLLBACK_MAX = 1000;

    let cols = 80, rows = 24;
    let cellW = 8, cellH = 18;
    let screen = makeGrid(cols, rows);
    let scrollback = [];
    let scrollOffset = 0;
    const cur = { row: 0, col: 0 };
    const pen = { fg: null, bg: null, bold: false, inverse: false };
    let cursorVisible = true;
    let pending = "";       // 分割されたエスケープシーケンスの継続待ち
    let dirty = true;
    let focused = false;
    let blinkOn = true;

    let session = null;
    let opened = false;
    let manualReconnectNeeded = false;
    let netReady = false;
    let gridReady = false;

    /* ---------- バッファ操作 ---------- */
    // 全角(East Asian Wide/Fullwidth)文字は2セル幅として扱う(日本語出力の重なり防止)。
    function isWideChar(ch) {
      const c = ch.codePointAt(0);
      return (
        (c >= 0x1100 && c <= 0x115F) ||
        c === 0x2329 || c === 0x232A ||
        (c >= 0x2E80 && c <= 0xA4CF && c !== 0x303F) ||
        (c >= 0xAC00 && c <= 0xD7A3) ||
        (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFE6F) ||
        (c >= 0xFF00 && c <= 0xFF60) ||
        (c >= 0xFFE0 && c <= 0xFFE6) ||
        (c >= 0x20000 && c <= 0x3FFFD)
      );
    }
    function blankCell() { return { ch: " ", fg: null, bg: null, bold: false, inverse: false, wide: false, cont: false }; }
    function makeRow(n) { const r = new Array(n); for (let i = 0; i < n; i++) r[i] = blankCell(); return r; }
    function makeGrid(c, r) { const g = new Array(r); for (let i = 0; i < r; i++) g[i] = makeRow(c); return g; }

    function resetPen() { pen.fg = null; pen.bg = null; pen.bold = false; pen.inverse = false; }

    function resetTerminalState() {
      scrollback = [];
      screen = makeGrid(cols, rows);
      cur.row = 0; cur.col = 0;
      resetPen();
      cursorVisible = true;
      scrollOffset = 0;
      pending = "";
      dirty = true;
    }

    function scrollUp() {
      const removed = screen.shift();
      scrollback.push(removed);
      if (scrollback.length > SCROLLBACK_MAX) scrollback.shift();
      else if (scrollOffset > 0) scrollOffset = Math.min(scrollOffset + 1, scrollback.length);
      screen.push(makeRow(cols));
    }

    function resizeGrid(newCols, newRows) {
      newCols = Math.max(1, newCols | 0);
      newRows = Math.max(1, newRows | 0);
      if (newCols === cols && newRows === rows) return;
      const old = screen, oldRows = rows, oldCols = cols;
      const ns = new Array(newRows);
      for (let r = 0; r < newRows; r++) {
        const row = makeRow(newCols);
        if (r < oldRows) {
          const oldRow = old[r];
          for (let c = 0; c < Math.min(newCols, oldCols); c++) row[c] = oldRow[c];
        }
        ns[r] = row;
      }
      screen = ns;
      cols = newCols; rows = newRows;
      cur.row = Math.min(cur.row, rows - 1);
      cur.col = Math.min(cur.col, cols - 1);
    }

    function putChar(ch) {
      const wide = isWideChar(ch);
      if (wide && cur.col >= cols - 1) {
        // 全角文字が行末で入りきらない場合は先に折り返す
        cur.col = 0; cur.row++;
        if (cur.row >= rows) { scrollUp(); cur.row = rows - 1; }
      }
      const row = screen[cur.row];
      if (row) {
        row[cur.col] = { ch, fg: pen.fg, bg: pen.bg, bold: pen.bold, inverse: pen.inverse, wide, cont: false };
        if (wide && cur.col + 1 < cols) {
          row[cur.col + 1] = { ch: "", fg: pen.fg, bg: pen.bg, bold: pen.bold, inverse: pen.inverse, wide: false, cont: true };
        }
      }
      cur.col += wide ? 2 : 1;
      if (cur.col >= cols) {
        cur.col = 0;
        cur.row++;
        if (cur.row >= rows) { scrollUp(); cur.row = rows - 1; }
      }
    }

    function doNewline() {
      cur.row++;
      if (cur.row >= rows) { scrollUp(); cur.row = rows - 1; }
    }

    function eraseLine(mode) {
      const row = screen[cur.row];
      if (!row) return;
      if (mode === 1) { for (let c = 0; c <= cur.col; c++) row[c] = blankCell(); }
      else if (mode === 2) { for (let c = 0; c < cols; c++) row[c] = blankCell(); }
      else { for (let c = cur.col; c < cols; c++) row[c] = blankCell(); }
    }

    function eraseScreen(mode) {
      if (mode === 1) {
        eraseLine(1);
        for (let r = 0; r < cur.row; r++) screen[r] = makeRow(cols);
      } else if (mode === 2) {
        for (let r = 0; r < rows; r++) screen[r] = makeRow(cols);
      } else {
        eraseLine(0);
        for (let r = cur.row + 1; r < rows; r++) screen[r] = makeRow(cols);
      }
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    /* ---------- SGR ---------- */
    function doSGR(params) {
      for (let i = 0; i < params.length; i++) {
        const n = params[i];
        if (!isFinite(n) || n === 0) { resetPen(); continue; }
        if (n === 1) pen.bold = true;
        else if (n === 22) pen.bold = false;
        else if (n === 7) pen.inverse = true;
        else if (n === 27) pen.inverse = false;
        else if (n === 39) pen.fg = null;
        else if (n === 49) pen.bg = null;
        else if (n >= 30 && n <= 37) pen.fg = PAL.basic[n - 30];
        else if (n >= 90 && n <= 97) pen.fg = PAL.bright[n - 90];
        else if (n >= 40 && n <= 47) pen.bg = PAL.basic[n - 40];
        else if (n >= 100 && n <= 107) pen.bg = PAL.bright[n - 100];
        else if (n === 38 || n === 48) {
          const mode = params[i + 1];
          if (mode === 5) {
            const col = xterm256(PAL, params[i + 2]);
            if (n === 38) pen.fg = col; else pen.bg = col;
            i += 2;
          } else if (mode === 2) {
            const r = params[i + 2] | 0, g = params[i + 3] | 0, b = params[i + 4] | 0;
            const col = `rgb(${r},${g},${b})`;
            if (n === 38) pen.fg = col; else pen.bg = col;
            i += 4;
          }
        }
        // 未知のSGRは安全に無視
      }
    }

    /* ---------- CSI ディスパッチ ---------- */
    function handleCSI(paramsStr, final) {
      const isPrivate = paramsStr.charAt(0) === "?";
      const body = isPrivate ? paramsStr.slice(1) : paramsStr;
      const params = body.length ? body.split(";").map(s => (s === "" ? NaN : parseInt(s, 10))) : [];
      const p1 = isFinite(params[0]) ? params[0] : undefined;
      switch (final) {
        case "m": doSGR(params.length ? params : [0]); break;
        case "H": case "f": {
          const r = (isFinite(params[0]) ? params[0] : 1) - 1;
          const c = (isFinite(params[1]) ? params[1] : 1) - 1;
          cur.row = clamp(r, 0, rows - 1);
          cur.col = clamp(c, 0, cols - 1);
          break;
        }
        case "A": cur.row = clamp(cur.row - (p1 || 1), 0, rows - 1); break;
        case "B": cur.row = clamp(cur.row + (p1 || 1), 0, rows - 1); break;
        case "C": cur.col = clamp(cur.col + (p1 || 1), 0, cols - 1); break;
        case "D": cur.col = clamp(cur.col - (p1 || 1), 0, cols - 1); break;
        case "G": cur.col = clamp((p1 || 1) - 1, 0, cols - 1); break;
        case "K": eraseLine(isFinite(params[0]) ? params[0] : 0); break;
        case "J": eraseScreen(isFinite(params[0]) ? params[0] : 0); break;
        case "h": if (isPrivate && p1 === 25) cursorVisible = true; break;
        case "l": if (isPrivate && p1 === 25) cursorVisible = false; break;
        default: break; // 未対応シーケンスは読み飛ばす(効果なし)
      }
    }

    /* ---------- 入力ストリームのパース ---------- */
    function feed(raw) {
      if (pending.length > 4096) pending = ""; // 異常な滞留を防止
      const str = pending + raw;
      pending = "";
      const n = str.length;
      let i = 0;
      while (i < n) {
        const ch = str[i];
        const code = ch.charCodeAt(0);
        if (ch === "\x1b") {
          const rest = str.slice(i);
          if (rest.length < 2) { pending = rest; break; }
          const c1 = rest[1];
          if (c1 === "[") {
            const after = rest.slice(2);
            const m = /[@-~]/.exec(after);
            if (!m) { pending = rest; break; }
            const finalCh = after[m.index];
            const paramsStr = after.slice(0, m.index);
            if (/^[0-9;?]*$/.test(paramsStr)) handleCSI(paramsStr, finalCh);
            i += 2 + m.index + 1;
            continue;
          } else if (c1 === "]") {
            const bel = rest.indexOf("\x07");
            const st = rest.indexOf("\x1b\\");
            let end = -1, len = 0;
            if (bel !== -1 && (st === -1 || bel < st)) { end = bel; len = 1; }
            else if (st !== -1) { end = st; len = 2; }
            if (end === -1) { pending = rest; break; }
            i += end + len;
            continue;
          } else {
            i += 2; // 単発ESCシーケンスは安全に読み飛ばす
            continue;
          }
        } else if (ch === "\r") { cur.col = 0; i++; }
        else if (ch === "\n") { doNewline(); i++; }
        else if (ch === "\b") { if (cur.col > 0) cur.col--; i++; }
        else if (ch === "\t") { cur.col = Math.min(cols - 1, (Math.floor(cur.col / 8) + 1) * 8); i++; }
        else if (code < 32 || code === 127) { i++; } // その他制御文字は無視
        else { putChar(ch); i++; }
      }
      dirty = true;
    }
    function localWrite(s) { feed(s); }

    /* ---------- 画面サイズ ↔ グリッド ---------- */
    function updateGridFromSize() {
      const cw = w(), ch2 = h();
      if (!isFinite(cw) || !isFinite(ch2) || cw <= 0 || ch2 <= 0) return;
      ctx.font = FONT_SIZE + "px " + FONT_STACK;
      const mw = ctx.measureText("M").width;
      cellW = mw > 0 ? mw : 8;
      cellH = Math.max(8, Math.round(FONT_SIZE * 1.45));
      let newCols = Math.floor(cw / cellW);
      let newRows = Math.floor(ch2 / cellH);
      if (!isFinite(newCols) || newCols < 10) newCols = 80;
      if (!isFinite(newRows) || newRows < 4) newRows = 24;
      gridReady = true;
      if (newCols !== cols || newRows !== rows) {
        resizeGrid(newCols, newRows);
        if (session) session.resize(cols, rows);
      }
      maybeOpen();
    }

    /* ---------- セッション制御 ---------- */
    function maybeOpen() {
      if (opened || manualReconnectNeeded || !netReady || !gridReady) return;
      resetTerminalState();
      openNow();
    }

    function openNow() {
      opened = true;
      session = SCC.net.term.open({
        cols, rows,
        onOutput: str => { feed(str); },
        onExit: code => {
          session = null;
          opened = false;
          manualReconnectNeeded = true;
          localWrite("\r\n\x1b[33mセッション終了 (code " + code + ")。上の「再接続」ボタンを押してください。\x1b[0m\r\n");
          dirty = true;
        },
      });
    }

    function reconnect() {
      if (session) { try { session.close(); } catch (e) { /* noop */ } session = null; }
      opened = false;
      manualReconnectNeeded = false;
      resetTerminalState();
      if (netReady && gridReady) {
        openNow();
      } else {
        localWrite("\x1b[90m接続待ち…\x1b[0m");
      }
    }

    function clearScreen() {
      screen = makeGrid(cols, rows);
      cur.row = 0; cur.col = 0; scrollOffset = 0; dirty = true;
    }

    function scrollBy(lines) {
      scrollOffset = clamp(scrollOffset + lines, 0, scrollback.length);
      dirty = true;
    }

    function setFocused(v) { focused = v; dirty = true; }
    function onNetTick() {
      if (SCC.net && SCC.net.mode !== "init" && SCC.net.mode !== "connecting") {
        netReady = true;
        maybeOpen();
      }
    }

    /* ---------- 描画 ---------- */
    function getLine(idx) {
      if (idx < scrollback.length) return scrollback[idx];
      const r = idx - scrollback.length;
      return (r >= 0 && r < rows) ? screen[r] : null;
    }

    function render() {
      updateGridFromSize();
      const cw = w(), ch2 = h();
      ctx.save();
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, cw, ch2);
      ctx.textBaseline = "top";

      const viewStart = clamp(scrollback.length - scrollOffset, 0, scrollback.length);
      for (let r = 0; r < rows; r++) {
        const line = getLine(viewStart + r);
        if (!line) continue;
        for (let c = 0; c < cols; c++) {
          const cell = line[c];
          if (!cell) continue;
          let fg = cell.fg || PAL.fg;
          let bg = cell.bg;
          if (cell.inverse) { const t = fg; fg = bg || PAL.bg; bg = t || PAL.fg; }
          if (bg) { ctx.fillStyle = bg; ctx.fillRect(c * cellW, r * cellH, cellW, cellH); }
          if (cell.ch && cell.ch !== " ") {
            ctx.font = (cell.bold ? "bold " : "") + FONT_SIZE + "px " + FONT_STACK;
            ctx.fillStyle = fg;
            ctx.fillText(cell.ch, c * cellW, r * cellH);
          }
        }
      }

      if (scrollOffset === 0 && cursorVisible && cur.row < rows) {
        const cx = cur.col * cellW, cy = cur.row * cellH;
        const cell = screen[cur.row] && screen[cur.row][cur.col];
        const cw = (cell && cell.wide) ? cellW * 2 : cellW;
        if (focused) {
          if (blinkOn) {
            ctx.fillStyle = PAL.cursor;
            ctx.fillRect(cx, cy, cw, cellH);
            if (cell && cell.ch && cell.ch !== " ") {
              ctx.fillStyle = PAL.bg;
              ctx.font = (cell.bold ? "bold " : "") + FONT_SIZE + "px " + FONT_STACK;
              ctx.fillText(cell.ch, cx, cy);
            }
          }
        } else {
          ctx.strokeStyle = PAL.cursor;
          ctx.lineWidth = 1;
          ctx.strokeRect(cx + 0.5, cy + 0.5, Math.max(1, cw - 1), Math.max(1, cellH - 1));
        }
      }

      if (!focused) {
        ctx.fillStyle = "rgba(154,160,168,.55)";
        ctx.font = "11px " + FONT_STACK;
        ctx.textAlign = "right";
        ctx.fillText("クリックして操作", cw - 6, ch2 - 16);
        ctx.textAlign = "left";
      }
      ctx.restore();
    }

    /* 初期プレースホルダ */
    localWrite("\x1b[90m接続待ち…\x1b[0m");

    return {
      feed, render, reconnect, clearScreen, scrollBy, setFocused, onNetTick,
      markDirty() { dirty = true; },
      isDirty() { return dirty; },
      clearDirty() { dirty = false; },
      toggleBlink() { blinkOn = !blinkOn; if (focused) dirty = true; },
      writeInput(s) { if (session) session.write(s); },
    };
  }

  /* ============================================================ パネル登録 ============================================================ */
  SCC.panels.term = {
    init() {
      injectCSS();
      const root = document.getElementById("term-body");
      const extra = document.getElementById("term-extra");
      if (!root || !extra) return;

      root.innerHTML = "";
      const canvas = document.createElement("canvas");
      canvas.className = "term-canvas";
      canvas.tabIndex = 0;
      const hiddenInput = document.createElement("textarea");
      hiddenInput.className = "term-hidden-input";
      hiddenInput.setAttribute("autocomplete", "off");
      hiddenInput.setAttribute("autocorrect", "off");
      hiddenInput.setAttribute("autocapitalize", "off");
      hiddenInput.setAttribute("spellcheck", "false");
      hiddenInput.setAttribute("wrap", "off");
      hiddenInput.rows = 1;
      root.appendChild(canvas);
      root.appendChild(hiddenInput);

      extra.innerHTML =
        '<span class="badge term-badge" id="term-badge">---</span>' +
        '<button class="btn btn--sm" id="term-btn-clear" title="表示のみクリア(シェルには影響しません)">Clear</button>' +
        '<button class="btn btn--sm" id="term-btn-reconn">再接続</button>';
      const badgeEl = document.getElementById("term-badge");
      const btnClear = document.getElementById("term-btn-clear");
      const btnReconn = document.getElementById("term-btn-reconn");

      const { ctx, w, h } = SCC.bindCanvas(canvas, () => { term.markDirty(); });
      const term = createTerminal(canvas, hiddenInput, w, h, ctx);

      function updateBadge() {
        if (!SCC.net || !SCC.net.term) return;
        const remote = SCC.net.term.backendKind() === "obc-remote";
        badgeEl.textContent = remote ? "OBC ● REMOTE" : "OBC ● SIM";
        badgeEl.className = "badge term-badge" + (remote ? " badge--ok" : "");
      }

      /* ---- キー入力 ---- */
      canvas.addEventListener("mousedown", () => hiddenInput.focus());
      canvas.addEventListener("focus", () => hiddenInput.focus());
      hiddenInput.addEventListener("focus", () => term.setFocused(true));
      hiddenInput.addEventListener("blur", () => term.setFocused(false));

      hiddenInput.addEventListener("keydown", ev => {
        if (ev.isComposing || ev.keyCode === 229) return;
        const key = ev.key;
        let bytes = null;
        let pd = true;

        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && /^[a-zA-Z]$/.test(key)) {
          if (key.toLowerCase() === "c" && window.getSelection().toString()) {
            pd = false; // 選択中はブラウザのコピーに委ねる
          } else {
            bytes = String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96);
          }
        } else if (ev.ctrlKey && !ev.altKey && !ev.metaKey && key.toLowerCase() === "v") {
          pd = false; // ペーストは 'paste' イベントに委ねる
        } else if (key === "Enter") bytes = "\r";
        else if (key === "Backspace") bytes = "\x7f";
        else if (key === "Tab") bytes = "\t";
        else if (key === "Escape") bytes = "\x1b";
        else if (key === "ArrowUp") bytes = "\x1b[A";
        else if (key === "ArrowDown") bytes = "\x1b[B";
        else if (key === "ArrowRight") bytes = "\x1b[C";
        else if (key === "ArrowLeft") bytes = "\x1b[D";
        else if (key === "Home") bytes = "\x1b[H";
        else if (key === "End") bytes = "\x1b[F";
        else if (key === "Delete") bytes = "\x1b[3~";
        else if (ev.altKey && !ev.ctrlKey && !ev.metaKey && key.length === 1) bytes = "\x1b" + key;
        else if (!ev.ctrlKey && !ev.metaKey && key.length === 1) { pd = false; /* input イベント経由(IME安全) */ }
        else pd = false;

        if (bytes !== null) {
          term.writeInput(bytes);
          hiddenInput.value = "";
        }
        if (pd) ev.preventDefault();
      });

      hiddenInput.addEventListener("input", () => {
        const val = hiddenInput.value;
        if (val) term.writeInput(val);
        hiddenInput.value = "";
      });

      hiddenInput.addEventListener("paste", ev => {
        ev.preventDefault();
        const text = (ev.clipboardData || window.clipboardData).getData("text");
        if (text) term.writeInput(text);
        hiddenInput.value = "";
      });

      root.addEventListener("wheel", ev => {
        ev.preventDefault();
        term.scrollBy(ev.deltaY > 0 ? -3 : 3);
      }, { passive: false });

      btnClear.addEventListener("click", () => { term.clearScreen(); hiddenInput.focus(); });
      btnReconn.addEventListener("click", () => { term.reconnect(); updateBadge(); hiddenInput.focus(); });

      /* ---- 接続モード監視 ---- */
      bus.on("tick", () => { updateBadge(); term.onNetTick(); });
      // tick が来ない極端なケースへの保険(ネットモード確定を見逃さない)
      const pollTimer = setInterval(() => { updateBadge(); term.onNetTick(); }, 400);
      window.addEventListener("beforeunload", () => clearInterval(pollTimer));

      /* ---- カーソル点滅 / 描画ループ ---- */
      setInterval(() => term.toggleBlink(), 530);
      function loop() {
        if (term.isDirty()) { term.clearDirty(); term.render(); }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);

      updateBadge();
    },
  };
})();
