/* SCC proto — WebSocket プロトコル共有コーデック(ブラウザ/Nodeサーバ両用)
   JSON で表現できない Date / NaN を往復させる:
     Date → {"__dt": epochMs} / NaN → "__NaN"
   メッセージ種別:
     server→client: {type:"hello", state}            接続直後の全量スナップショット (history含む)
                    {type:"tick", state}             毎tick (history除外; ログは log イベントで増分)
                    {type:"log", entry}
                    {type:"pass-change", payload}
                    {type:"command-sent"|"command-ack", payload}
     client→server: {type:"op", name, args}          SCC.ops.* の呼び出し (nameはホワイトリスト制)
     端末 (OBC SSH コンソール、接続ごと1セッション):
       client→server: {type:"term-open", cols, rows}
                      {type:"term-input", data}       生のキー入力バイト列 (エコー/行編集はシェル側)
                      {type:"term-resize", cols, rows}
                      {type:"term-close"}
       server→client: {type:"term-output", data}      ANSI含む端末出力
                      {type:"term-exit", code}         セッション終了 (実ssh切断等) */
(function () {
  "use strict";

  function encodeVal(v) {
    if (v instanceof Date) return { __dt: v.getTime() };
    if (typeof v === "number" && Number.isNaN(v)) return "__NaN";
    if (Array.isArray(v)) return v.map(encodeVal);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) {
        const e = encodeVal(v[k]);
        if (e !== undefined) o[k] = e;
      }
      return o;
    }
    if (typeof v === "function") return undefined;
    return v;
  }

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

  const OPS_WHITELIST = [
    "setSimSpeed", "sendCommand", "setAntennaMode", "setAutoTrack",
    "slewAntenna", "ackAlarm", "startSwUpdate", "installSwUpdate", "abortSwUpdate",
  ];

  const proto = {
    OPS_WHITELIST,
    encodeMsg(type, payload) { return JSON.stringify({ type, ...encodeVal(payload) }); },
    decodeMsg(text) { return decodeVal(JSON.parse(text)); },
    // tick 用: history を除いた state を包む
    stateForTick(state) {
      const { history, ...rest } = state;
      return { state: rest };
    },
  };

  window.SCC.proto = proto;
})();
