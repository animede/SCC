# SCC — Satellite Control Center 仕様書

自前人工衛星のための地上管制センター用アプリケーション。4Kモニタ(3840×2160)常設表示を前提とした
ミッションコントロール・ダッシュボード。

**フェーズ1: UIの完成**(済)— 全データはフロントエンド内のシミュレータ(モック)が生成。
**フェーズ2: SGP4/TLE + バックエンド接続**(済)—
- 軌道計算は satellite.js (ベンダリング済, MIT) の SGP4 に差し替え。TLEは `SCC.orbit.setTLE()` で更新可。
- 通信層 `SCC.net`(js/core/wsclient.js)がバックエンド(server/server.mjs)へ WebSocket 接続し、
  サーバ権威で state を駆動。未接続時は mockdata.js へ自動フォールバック(`?mode=mock` で強制)。
- バックエンドは依存ゼロの Node サーバ: 静的配信 + `/ws`(RFC6455自前実装)+ rotctld(Hamlib)
  アダプタでアンテナロータ実機に接続可(§8)。
全パネルは従来どおり `SCC.bus` / `SCC.state`(読取専用)/ `SCC.ops` のみに依存し、フェーズ間で無変更。

---

## 1. ミッション設定(モックデータの世界観)

- **衛星**: HIKARI-1 (ひかり1号) — 50kg級マイクロサット
  - 軌道要素は **ISS準拠**(高度 ≈418 km、傾斜角 51.64°、周期 ≈92.9 min、NORAD 25544 の要素を流用。
    orbit.js の既定TLE。`--tle` / `SCC.orbit.setTLE()` で差し替え可)
- **地上局(6局)**:
  | ID | 名称 | 位置 | アンテナ | バンド |
  |---|---|---|---|---|
  | GS-TKY | 東京・八王子 (主局) | 35.66°N, 139.32°E | 3.8m パラボラ | S/X |
  | GS-HKD | 北海道・根室 | 43.33°N, 145.58°E | 2.4m パラボラ | S |
  | GS-ISG | 沖縄・石垣島 | 24.34°N, 124.16°E | 1.8m パラボラ | S/UHF |
  | GS-TSU | 長崎・対馬 | 34.20°N, 129.29°E | 2.4m パラボラ | S |
  | GS-OGA | 父島・小笠原追跡所 (提携局) | 27.09°N, 142.19°E | 10m パラボラ | S/X |
  | GS-MTS | 東京・南鳥島 | 24.29°N, 153.98°E | 3.0m パラボラ | X |
- 最低運用仰角: 5°(パス判定)

## 2. 画面レイアウト(3840×2160)

固定ヘッダ + CSS Grid 24列のメインエリア。1080p等でも縮小して破綻しないこと(min-width 1600px、
それ以下は横スクロール)。

```
┌──────────────────────────── ヘッダバー (72px) ────────────────────────────┐
│ SCC ロゴ | 衛星名/状態 | UTC時計 | JST時計 | MET | 次パスAOSカウントダウン │
│          | ODステータス(EST OK / OD n=NN σ=XXXm) | アラームサマリ         │
│          | シミュレーション速度 (×1/×10/×60/×600)                        │
├──────────────┬──────────────────────┬───────────────────────────────────┤
│              │                      │                                   │
│  世界地図     │   スカイプロット      │   テレメトリ                       │
│  地平線円+    │   (極座標 Az/El)     │   ・ステータスタイル列              │
│  地上軌跡     │   + 追尾制御パネル    │   ・EPS / TCS / ADCS / COM        │
│  (col 1-10)  │   (col 11-16)        │     ストリップチャート群            │
│              ├──────────────────────┤   (col 17-24)                     │
│              │   アンテナ統合管理     │                                   │
│              │   4局カードグリッド    │                                   │
├──────────────┴──────────────────────┤                                   │
│  パススケジュール タイムライン (24h)  │                                   │
├───────────┬───────────┬─────────────┴──────────┬────────────────────────┤
│ コマンド   │ コマンド   │ ダウンリンク/ファイル    │  イベントログ           │
│ コンソール │ キュー/履歴│ + ソフトウェア更新管理   │                        │
└───────────┴───────────┴────────────────────────┴────────────────────────┘
```

グリッド定義は `index.html` + `css/main.css` が正。パネルはそれぞれ `<section class="panel" id="panel-XXX">`
で、ヘッダ(`.panel__title`)と本体(`.panel__body`)を持つ。

## 3. デザインシステム

ダークテーマ固定(管制室運用前提)。トークンは `css/main.css` の `:root` が正。

- 面: ページ `#0b0d10` / パネル面 `#14161a` / 凹面(入力・チャート) `#101216`
- インク: 主 `#e8eaed` / 副 `#9aa0a8` / 弱 `#6b7076` / 罫線 `#262a30`
- 数値の readout は `font-family: var(--mono)`, `font-variant-numeric: tabular-nums`
- **系列色(検証済・順序固定)**: 1 `#3987e5` 青 / 2 `#199e70` アクア / 3 `#c98500` 黄 /
  4 `#008300` 緑 / 5 `#9085e9` 紫 / 6 `#e66767` 赤系 — 系列に循環割当禁止。チャートは必ず直接ラベル併記
  (CVDフロア帯のため色のみで識別させない)。
- **ステータス色(専用・系列に流用禁止)**: NOMINAL `#0ca30c` / WARNING `#fab219` /
  SERIOUS `#ec835a` / CRITICAL `#d03b3b`。必ずアイコンまたはテキストラベルを併記。
- チャート: 線2px、グリッドはヘアライン `#262a30`、軸ラベルは弱インク、ホバーで
  クロスヘア+ツールチップ。二重Y軸禁止(スケールが違う量は別チャート)。

## 4. コアAPI(パネル実装者との契約)

グローバル `window.SCC`。読み込み順: state.js → orbit.js → mockdata.js → 各panel → main.js
(全て通常の `<script>`、ESモジュール不使用。各ファイルはIIFEで `SCC.*` に登録)。

### 4.1 SCC.bus — イベントバス
- `SCC.bus.on(event, fn)` / `SCC.bus.emit(event, payload)`
- イベント:
  - `tick` — シミュレーション1秒ごと(実時間では速度設定に依存、描画は requestAnimationFrame 側で間引き可)。payload = `SCC.state`
  - `pass-change` — AOS/LOS 発生時 `{type:'AOS'|'LOS', pass}`
  - `log` — イベントログ追記 `{t, level:'info'|'warn'|'serious'|'crit', source, msg}`
  - `command-sent` — `{cmd}` / `command-ack` — `{cmd, status:'ACK'|'NACK'|'EXEC'}`

### 4.2 SCC.state — 単一ステート(読み取り専用として扱う)
```js
{
  simTime: Date,           // シミュレーション現在時刻 (UTC)
  simSpeed: 1|10|60|600,
  met: Number,             // Mission Elapsed Time [s]
  sat: {
    name, noradId,
    pos: {lat, lon, alt},        // 地理座標 [deg, deg, km]
    eci: {x,y,z},                // [km]
    vel: Number,                 // [km/s]
    orbitNo: Number,
    telemetry: { eps:{busV,busI,soc,solarW,battT},
                 tcs:{obcT,commT,panelT,battT},
                 adcs:{mode,rateX,rateY,rateZ,sunAngle,quat:[..4]},
                 cdh:{cpu,mem,uptime,bootCount,storagePct},
                 com:{rssi,snr,bitrate,agc,mode} },
    alarms: [{id, level, msg, t, ack:false}]
  },
  stations: [ { id, name, lat, lon, band, dish,
    antenna: { az, el,               // 現在指向 [deg]
               cmdAz, cmdEl,         // 指令値
               mode: 'IDLE'|'TRACKING'|'SLEWING'|'STOWED'|'MAINT',
               autoTrack: true, rssi, snr, lock: bool } } ],
  passes: [ { station,               // station id
    aos: Date, los: Date, maxEl, aosAz, losAz, maxElT,
    status: 'upcoming'|'active'|'done' } ],   // 今後24h、時刻順
  contact: {                          // 統合コンタクトウィンドウ (全局パスの時間マージ、隙間5s以内は
    windows: [ { start: Date, end: Date,      //   ハンドオーバー継続扱い)。「局をまたいだ連続通信」の単位
                 stations: [id...] } ] },     //   stations は AOS 順のハンドオーバー系列
  groundTrack: { past: [[lat,lon],..], future: [[lat,lon],..] }, // ±1周回分
  commandQueue: [ {id, t, name, args, status:'QUEUED'|'SENT'|'ACK'|'EXEC'|'FAIL', station} ],
  downlink: { sessions: [...], files: [ {name, size, pct, state} ], totalMB },
  swUpdate: { current: 'v2.4.1', available: 'v2.5.0',
              state: 'IDLE'|'UPLOADING'|'VERIFYING'|'READY'|'INSTALLING', pct },
  history: [ log entries (最新500) ]
}
```

### 4.3 SCC.orbit — 軌道ユーティリティ(orbit.js)
フェーズ3(観測ベースOD)により、内部実装は `SCC.createOrbit()` ファクトリに包まれた。
`SCC.orbit` はそのファクトリで生成された既定インスタンス(従来どおりのシングルトン、公開APIは
完全互換)。`SCC.createOrbit()` を追加で呼べば、互いに独立した軌道インスタンスを複数生成できる
(mockdata.js の「真の軌道」「地上予測軌道」の分離、orbitdet.js の候補評価用インスタンス等に使用)。

- `SCC.orbit.propagate(date)` → `{lat, lon, alt, eci, vel}`
- `SCC.orbit.stateAt(date)` → `{r:{x,y,z}, v:{x,y,z}} | null` — ECI状態ベクトルの生値(km, km/s)。
  ODの初期推定値取得等に使用。
- `SCC.orbit.lookAngles(stationLatLon, date)` → `{az, el, range}` [deg, deg, km]
- `SCC.orbit.groundTrack(date, minutes, stepSec)` → `[[lat,lon],...]`
- `SCC.orbit.predictPasses(station, fromDate, hours)` → pass配列
- `SCC.orbit.footprintRadiusDeg(alt)` → 可視円半径 [deg](地図の可視域円用)
- `SCC.orbit.tleFromState(r, v, epochDate)` → `[l1, l2] | null` — ECI状態ベクトル(km, km/s)から
  TLE行対を作る(rv2coe→coe2tle、satrecには適用しない)。e≥1 や非有限値の場合は `null`。
  `applyBurn` 内部もこの関数を使う。
- `SCC.orbit.applyBurn(dvRsw, atDate)` → `boolean` — スラスタ噴射の反映API。`atDate` 時点の
  ECI状態ベクトル(位置・速度)に、RSW系(Radial=地心方向 / along-track=進行方向 / cross-track=軌道面法線)
  で与えたインパルスΔv `{radial, along, cross}` [km/s] を加算 → `tleFromState` でTLE行に再エンコード
  (epoch=`atDate`)→ 内部的に `setTLE()` を呼びsatrecを差し替える。オスキュレーティング要素をそのまま
  新epochの平均要素とみなす簡易変換(SGP4のKozai平均運動への近似的な逆変換は行うが、J2等の長期・短期
  周期項の再フィットは行わない、シミュレータ相応の近似)。失敗時(数値異常等)は既存軌道を維持し `false`。

  **重要**: 本近似には既知の精度限界がある。エポックの異なる2つのTLEを本APIで往復生成すると、
  数時間〜1周回のスケールで数km〜十数km程度の位置誤差が蓄積し得る(TLE=SGP4の平均要素であり、
  瞬間の状態ベクトルとの変換は本質的に近似であるため)。観測ベースOD(§4.6)は、比較的長時間
  (複数パス、300秒〜数時間)の観測窓を使うことでこの誤差を実用上十分小さく抑えている
  (§4.6のフィット条件を参照)。

### 4.4 操作API(mockdata.js が実装、パネルから呼ぶ)
- `SCC.ops.setSimSpeed(n)`
- `SCC.ops.sendCommand(name, args, stationId)` — キュー投入→パス中なら数秒でACK/EXEC遷移
- `SCC.ops.setAntennaMode(stationId, mode)` / `SCC.ops.setAutoTrack(stationId, bool)`
- `SCC.ops.slewAntenna(stationId, az, el)` — 手動指向(autoTrack=false時)
- `SCC.ops.ackAlarm(alarmId)`
- `SCC.ops.startSwUpdate()` / `SCC.ops.abortSwUpdate()`
- `SCC.ops.sendCommand("PROP_BURN", args, stationId)` — args形式 `"<dir> <dv_mps>"`
  (dir: `PRO`/`RETRO`/`RAD_IN`/`RAD_OUT`/`NORM_POS`/`NORM_NEG`)。他コマンドと同じくキュー→SENT→ACK→EXEC
  で進行するが、EXEC時の `applyCommandEffect`(mockdata.js)が dir+dv を RSW ベクトルへ変換して
  軌道に反映する点が異なる。フェーズ3(観測ベースOD)により、この反映は「真の軌道」と
  「地上予測軌道」の二段階になった(詳細は§6):
  1. 実行誤差込みのΔvを `trueOrbit.applyBurn()`(mockdata.js内、真の軌道専用インスタンス)に適用。
  2. コマンド通り(誤差なし)のΔvを作業インスタンスに適用した結果を `SCC.orbit.setTLE()` で
     地上表示軌道へ即時反映 → `recalcPasses()` / `recalcTrack()` を強制実行(通常の30分/60秒周期を
     待たず)、地図・スカイプロット・パススケジュール・ヘッダAOSカウントダウンを新軌道へ即時整合。
  3. `SCC.od.reset()` で観測ベース軌道決定(OD)を開始。以後パス中に観測が蓄積され、フィットが
     収束すると `SCC.orbit` のTLEが実行誤差込みの真の軌道に近い値へ再補正される(§4.6, §6)。
  新TLEのepoch/revに応じて `state.sat.orbitNo` が不連続に変わり得る。

### 4.6 SCC.od — 観測ベース軌道決定(orbitdet.js)
`SCC.state` に依存しない純粋な推定モジュール。satellite.js グローバルと `SCC.createOrbit` を
利用する。ブラウザ・Nodeサーバの両方で同一実装が動く(window/globalThisの扱いはorbit.js等と同様)。

- `SCC.od.reset(priorTle, burnDate)` — 観測バッファをクリアし `COLLECTING` 状態へ遷移。
  `priorTle=[l1, l2]` は初期推定(地上の予測軌道)として保持される。`priorTle` が無ければ `IDLE`。
- `SCC.od.addObs(obs)` — 観測を1件追加。
  `obs = {tMs, station:{id,lat,lon,altKm}, rangeKm, azDeg, elDeg}`。バッファ上限500件
  (古いものから破棄)。
- `SCC.od.step(nowMs)` — レート制限付きでフィットを試行する。シミュレーション時間で前回試行から
  15秒以上、かつ実時間(`performance.now()`/`Date.now()`)で1秒以上経過した場合のみ実際に計算する。
  収束・採用条件を満たせば `{tle:[l1,l2], stats:{rmsM, sigmaPosM, nObs, nStations, corrKm}}` を返し
  `IDLE` へ戻る(観測バッファも解放)。それ以外は `null`。
- `SCC.od.status()` → `{state:'IDLE'|'COLLECTING', nObs, nStations, sigmaPosM, rmsM}`
  (UI表示用のプレーンオブジェクト。直近のフィット試行が未収束でも `sigmaPosM`/`rmsM` は
  参考値として見える場合がある)。

**推定アルゴリズム(バッチ最小二乗 / Gauss-Newton + Levenberg-Marquardt)**:
推定パラメータ `x = [rx,ry,rz,vx,vy,vz]`(ECI, km・km/s。エポック=最初の観測時刻)。初期値は
`priorTle` の軌道を `stateAt(エポック)` で伝播した状態。候補xは `tleFromState` でTLE化し、作業用
`createOrbit()` インスタンスに `setTLE` した上で `lookAngles` により各観測時刻のrange/az/elを予測する。
残差は無次元化(range: σr=0.02km, el: σa=0.15°, az: ±180°ラップ後 cos(el) を掛けてσaで正規化)。
ヤコビアンは数値前進差分(位置摂動1.0km、速度摂動0.001km/s — TLEの角度4桁量子化≈12mを十分上回る幅)。
正規方程式は6×6ガウス消去(部分ピボット)で解き、LMのλは初期1e-3・コスト減で÷10・増で×10
(上限1e3で発散扱いとしそのtickのフィットを断念、次回の`step`で再試行)。反復上限8、
`|Δr|<10m` かつ `|Δv|<1cm/s` で収束。

**採用(収束確定)条件**: 観測≥30 かつ 観測時間スパン≥120秒 かつ 反復収束 かつ `sigmaPosM<500m`。
加えて 局数≥2 または スパン≥300秒。フィットに使う観測は直近150点まで(観測窓が複数パスに
またがるほど平均運動の推定精度が向上し、TLE化に伴う近似誤差(§4.3)の影響を抑えられる)。

### 4.5 パネル登録
各パネルファイルは `SCC.panels.XXX = { init(rootEl) }` を登録。main.js が DOMContentLoaded 後に
全 `init` を呼び、`tick` 購読は各パネル内で行う。canvas は `devicePixelRatio` 対応と
`ResizeObserver` でのリサイズ追従を必須とする。

## 5. パネル仕様

### 5.1 世界地図 (panel-map) — js/panels/map.js
- Canvas 等距円筒図法。内蔵の簡易海岸線データ(`SCC.geo.coastlines`、mockdataではなく map.js 内に保持)
  を線で描画。グリッド(経緯度30°)はヘアライン。
- 衛星現在位置マーカー(系列1青、パルスするリング)、可視域円(footprint、青20%塗り+線)。
- 地上軌跡: 過去1周回は弱インク実線、未来1周回は青の破線。日付変更線をまたぐ際の横線禁止(分割描画)。
- 地上局4局: マーカー+ID。パス中の局は衛星と局を結ぶリンク線(NOMINAL色)+ RSSI 表示。
- 昼夜ターミネータ(太陽直下点から計算、夜側を10%黒で塗る)。
- ホバー: 衛星/局に近づくとツールチップ(名称・座標・仰角)。

### 5.2 スカイプロット+追尾制御 (panel-sky) — js/panels/antenna.js
- 極座標プロット: 外周=仰角0°、中心=90°。方位N/E/S/W表示。仰角30/60°の同心円。
- 選択中の局(既定 GS-TKY、ドロップダウンで切替)について:
  - 現在パス or 次パスの予測軌跡を破線で、AOS/LOS点に方位ラベル。
  - 衛星が可視中なら現在位置を青マーカーで、アンテナ指向を十字レティクルで重畳。
- 追尾制御: AUTO TRACK トグル、モード表示、手動スルー(Az/El数値入力+SLEWボタン、AUTO時は無効)、
  指向誤差 readout(ΔAz/ΔEl)。

### 5.3 アンテナ統合管理 (panel-farm) — js/panels/antenna.js(同ファイル)
- 4局のカード。各カード: 局ID/名称/バンド、モードバッジ(色=ステータス色規約に従い
  TRACKING=NOMINAL緑, SLEWING=WARNING黄, MAINT=SERIOUS, STOWED/IDLE=弱インク)、
  Az/El の大きな readout(mono)、RSSI/SNR ミニバー、次パスまでのカウントダウン、LOCKインジケータ。
- カードクリックでスカイプロットの選択局を切替(bus経由: `SCC.bus.emit('select-station', id)`)。

### 5.4 テレメトリ (panel-tlm) — js/panels/telemetry.js
- 上段: ステータスタイル6枚。各タイルのラベルは**プルダウン**で、全32チャンネルのカタログ
  (EPS/TCS/ADCS/CDH/COM/DYN の6グループ、optgroup表示)から表示項目を選択できる。
  既定は バスV / SoC / OBC温度 / 角速度ノルム / RSSI / DLレート。選択は localStorage
  (`scc.tlm.tiles`)に永続化。値+単位+微小トレンド矢印。閾値超過でステータス色の左ボーダー+アイコン。
  32chカタログは telemetry.js の `CATALOG`(id/group/label/unit/dec/get/warn/crit/fmt)が正。
- 下段: ストリップチャート4枚(直近30分、simTime基準):
  1. EPS: バスV(青)+ バッテリ電流(アクア) — 単位が違うので**別チャート2段**にするか正規化しない2枚構成
  2. 温度: OBC/COMM/PANEL/BATT 4系列(系列1-4順)、直接ラベル必須
  3. ADCS: 角速度 X/Y/Z [deg/s]
  4. COM: RSSI [dBm] — パス中のみ有意、LOS中はデータ欠損として途切れさせる(0で繋がない)
- 各チャートにクロスヘア+ツールチップ(時刻+全系列値)。凡例=右上に直接ラベル。二重軸禁止。
- リングバッファは telemetry.js 内で `tick` から蓄積(30分×1s=1800点、simSpeed高速時は間引き)。

### 5.5 パススケジュール (panel-sched) — js/panels/ops.js
- 先頭行 = **NET(統合コンタクトウィンドウ)**: `state.contact.windows` をアクア色バーで描画
  (バー内に局数、ホバーで開始/終了/連続通信時間/ハンドオーバー系列)。
- ヘッダバーの CONTACT 表示: 通信中は「+経過 / -残り」(経過は局をまたいで継続)、圏外は次
  ウィンドウまでの T- カウントダウン。HANDOVER には系列を表示し可視中の局を緑でハイライト。
- 横軸=今後24hの時間軸、行=各局のガントチャート。パスをバー(高さ細め、局ごとに系列色ではなく
  単色青+仰角で濃淡: maxEl<20°は淡, ≥20°濃, ≥60°最濃)で描画、バー内に maxEl°。
- 現在時刻の縦線(NOMINAL色)。アクティブパスはパルス。ホバーでAOS/LOS/継続時間/最大仰角ツールチップ。

### 5.6 コマンドコンソール (panel-cmd) — js/panels/ops.js
- コマンドパレット(カテゴリ別ボタン: OBC / EPS / ADCS / COM / PAYLOAD / **PROP**、例: `OBC_REBOOT`,
  `ADCS_MODE_SUNPOINT`, `COM_TX_ON`, `PLD_CAPTURE`, `PROP_BURN` 等) + 引数入力欄 + 送信局選択。
- 送信ボタンは**2段階**(ARM → SEND、ARMで赤枠5秒)。危険コマンド(REBOOT等)は確認ダイアログ。
- パス外なら「次パスで自動送信」としてキュー(QUEUED表示)。
- **PROP** カテゴリ: `PROP_BURN`(危険コマンド)。引数は `<dir> <dv_mps>`
  (dir: PRO=進行方向 / RETRO=逆行 / RAD_IN・RAD_OUT=地心方向・反地心方向 / NORM_POS・NORM_NEG=軌道面法線±)。
  軌道変更は不可逆のため確認ダイアログ必須(§4.3, §4.4)。

### 5.7 コマンドキュー/履歴 (panel-queue) — js/panels/ops.js
- 上: キュー(QUEUED/SENT)、下: 履歴(ACK/EXEC/FAIL、ステータスバッジ)。mono表、時刻はUTC。

### 5.8 ダウンリンク+SW更新 (panel-data) — js/panels/ops.js
- ファイル受信リスト(名前/サイズ/進捗バー/状態)、セッション合計レート・累計MB。
- SW更新カード: 現行/最新バージョン、状態遷移バー(UPLOAD→VERIFY→READY→INSTALL)、
  開始/中断ボタン(2段階確認)。進捗はパス中のみ進む。
- モックの進行は mockdata.js が管理し、このパネルは表示+操作APIの呼び出しのみ。

### 5.9 イベントログ (panel-log) — js/panels/ops.js
- `log` イベントを追記表示(最新が上)。レベル別色ドット+mono時刻+ソース+メッセージ。
  フィルタチップ(ALL/INFO/WARN/CRIT)。自動スクロール(ユーザがスクロール中は停止)。

## 6. モックシミュレータ挙動 (mockdata.js)

- 1秒tick(simSpeed倍速: 実時間 1000/speed ms ごと、speed≥60では1tickで複数sim秒進める)。
- テレメトリ: 軌道位置と整合(日照でsolarW>0・SoC回復、食で放電; パス中のみ rssi/snr 有意)。
  ランダムウォーク+物理っぽい時定数。まれに WARNING アラーム(温度高、SoC低下等)を発生させる。
- アンテナ: autoTrack時、パスのAOS 3分前に SLEWING→AOS方位へ、AOS で TRACKING、LOS で IDLE。
  スルーレート 5°/s で滑らかに動かす。
- コマンド: SENT→(1-3s)→ACK→(2-5s)→EXEC。5%で FAIL。対応する log を emit。
- 初期状態: 起動時に「もうすぐ次のパスが来る」状態(次AOSまで5〜10分)になるよう simTime の
  エポックを調整すると画面が映える。

### 6.1 「物理的現実」と「地上の知識」の分離(フェーズ3: 観測ベースOD)

mockdata.js は2つの軌道インスタンスを使い分ける:

- **trueOrbit**(mockdata.js冒頭で `SCC.createOrbit()` により生成、init()で `SCC.orbit` と同一TLEに
  初期化) = 物理的現実(衛星の実位置・実際に飛んでくる電波)。メインループの伝播
  (`S.sat.pos`/`eci`/`vel`)、`stepAntenna` 内の自動追尾ターゲット算出とリンク品質判定(電波の
  閉ループ追尾なので真値を使う)、`stepTelemetry` の食判定、`checkPassEdges` の可視判定、
  OD向け観測の生成に使う。
- **SCC.orbit** = 地上の知識(予測軌道・スケジュール)。`recalcPasses`/`recalcTrack`/`orbitNumber`/
  `ALT`/`PERIOD` など、画面表示・パス予測に使う従来どおりのインスタンス。

### 6.2 `PROP_BURN` EXEC → 観測ベース軌道決定(OD)のフロー

1. **実行誤差の生成**: スラスタ噴射には実行誤差があるため、指定Δvをそのまま真の軌道に適用しない。
   大きさに `×(1+N(0,0.02))` の乗算誤差、方向に標準偏差0.5°相当の微小な傾き(指定RSW軸に直交する
   2軸成分へ `N(0, dv·sin(0.5°))` を加える簡易実装)を加える。ガウス乱数はBox-Muller法で生成。
2. **真の軌道の更新**: 実行誤差込みのΔvを `trueOrbit.applyBurn(dv, atDate)` に適用。失敗時
   (数値異常)は従来どおりエラーログを出し中断する。
3. **地上予測の即時整合**: コマンド通り(誤差なし)のΔvを作業用インスタンス
   (`scratch = SCC.createOrbit(); scratch.setTLE(...SCC.orbitの現在TLE...)`)に適用し、その結果を
   `SCC.orbit.setTLE()` で地上表示軌道へ反映 → `recalcPasses()` / `recalcTrack()` を即時強制実行
   (通常の30分/60秒周期を待たない)。過去分の地上軌跡(実績)は書き換えず、未来分のみ新要素で
   再生成する。ログに新軌道要素(高度・周期)を出力(例:「PROP_BURN 実行完了 — Δv=5.2m/s PRO,
   高度≈421km 周期≈93.0min」)。ここまでは受け入れ基準6前半(即時整合)に相当し、実行誤差を
   知らない「コマンド通りの結果」を表示する。
4. **OD開始**: `SCC.od.reset(SCC.orbitの現在TLE, atDate)` を呼び観測収集(`COLLECTING`)を開始。
   ログ `[OD] 軌道決定開始 — 観測収集中` を出力。
5. **観測生成**(メインループ、`COLLECTING`中のみ): 可視中(`antenna.lock`)の各局について、
   前回観測から5シミュレーション秒以上経過していれば `trueOrbit.lookAngles(station, simTime)` から
   range/az/elを求め、観測ノイズ(range: `N(0,0.02)`km、az/el: `N(0,0.15)`°)を加えて
   `SCC.od.addObs()` する。
6. **フィット駆動と採用**: 毎tick末尾で `SCC.od.step(simTime)` を呼ぶ。フィットが収束・採用条件
   (§4.6)を満たすと `{tle, stats}` が返り、`SCC.orbit.setTLE(...)` → `recalcPasses()` /
   `recalcTrack()` を実行し、地上表示軌道を実行誤差込みの真の軌道へ補正する。ログ例:
   「[OD] 軌道決定完了 — 残差RMS 20m / σpos 93m / 観測150点(2局) — 予測軌道との差 2.34km を補正」。
   これが受け入れ基準6後半(OD収束後の補正)に相当する。
7. **状態同期**: 毎tick `S.od = SCC.od.status()` を代入し、ヘッダのODステータスチップ(§2, §5)の
   表示に使う。
8. **再噴射時の扱い**: `COLLECTING` 中に別の `PROP_BURN` が実行されると、`SCC.od.reset()` が
   再度呼ばれ、収集中だった観測は単純に破棄される(新しい噴射後の観測収集がゼロから始まる)。

## 7. フェーズ2: 通信プロトコル / バックエンド

### 7.1 WebSocket プロトコル(正: js/core/proto.js)
JSON テキストフレーム。`Date → {"__dt": epochMs}`、`NaN → "__NaN"` で符号化。
- server→client: `hello`(接続直後の全量 state、history 含む)/ `tick`(history 除く state)/
  `log` / `pass-change` / `command-sent` / `command-ack`
- client→server: `{type:"op", name, args}`。`name` は `SCC.proto.OPS_WHITELIST` のみ受理。

### 7.2 接続シーケンス(js/core/wsclient.js)
1. `?mode=mock` またはWS URL導出不能(file://等)→ ローカルシミュレータ起動。
2. `?ws=<URL>` または同一オリジン `/ws` へ接続。2.5秒以内に `hello` が来なければローカルへフォールバック。
3. `hello` 受信で `SCC.ops` をWSプロキシに差し替え、以後サーバ権威。接続断は3秒間隔で再接続
   (ヘッダの DATA SOURCE が WS LINK / LOCAL SIM / RECONNECT... を表示)。

### 7.3 バックエンド(server/server.mjs, 依存ゼロNode)
- フロントエンドと**同一の** state.js / orbit.js / orbitdet.js / mockdata.js / proto.js をロードして
  シミュレータをサーバ側で実行し、bus イベントをWSへブリッジする。
- `--tle <file>` で実TLE読み込み(2行/3行形式)。`--config <json>` で rotctld アダプタ設定:
  `{"rotators": {"GS-TKY": {"host":"127.0.0.1","port":4533}}}`
- rotctld 接続中の局は `antenna.hw=true` となり、シミュレータはスルー積分をスキップ、
  サーバが 500ms ごとに `P az el`(指令)/`p`(実測読み戻し)で実機と同期する。
- セルフテスト: `node server/test.mjs`(偽rotctld込みで ALL PASS すること)。

## 8. 受け入れ基準

1. `python3 -m http.server` で配信して Chrome で開くだけで動く(ビルド不要・外部CDN不使用)。
2. 3840×2160 で全パネルがスクロールなしに収まり、1920幅でも崩壊しない。
3. パス予測と地図・スカイプロット・スケジュール・アンテナ挙動が同一の軌道計算に基づき整合する。
4. ×600 倍速にしてパスを跨いだとき、AOS/LOS・追尾・RSSI・ログ・キュー消化が連動する。
5. コンソールにエラーが出ない。
6. `PROP_BURN` 実行後、以下の2段階で軌道表示が整合すること。
   (1) 実行直後: コマンド通り(誤差なしの)予測軌道要素に基づき、地図/スカイプロット/
       パススケジュール/ヘッダAOSカウントダウンが同一tick内(遅くとも次tick)で整合し、旧要素
       ベースの矛盾したパス予測が残らないこと。
   (2) OD収束後: 観測ベース軌道決定(§4.6, §6.2)が収束すると、これらの表示が実行誤差込みの
       真の軌道へ再補正されること。
7. `PROP_BURN` 後、OD(§4.6)が観測を収集し、パス中に収束すると表示軌道が実軌道へ補正され、
   ヘッダのODチップ(§2)とログ(`[OD]` ソース)で進行状況(観測収集中→収束→補正量)が
   確認できること。
