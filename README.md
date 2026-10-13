# SCC — Satellite Control Center

自前人工衛星 **HIKARI-1**(架空。軌道要素はISS準拠、TLE差し替え可)のための地上管制センター用Webアプリ。
4Kモニタ(3840×2160)での常設表示を前提としたミッションコントロール・ダッシュボード。

![status](https://img.shields.io/badge/phase-2%20(SGP4%20%2B%20WS%20backend)-blue)

## インストール

ビルドツールもパッケージインストールも不要。ソース一式を配置し、Node.js を入れるだけで動く。

### 必要環境

| ソフトウェア | バージョン | 必須 | 用途 |
|---|---|---|---|
| [Node.js](https://nodejs.org/) | v18 以上 | ○ | バックエンド(`server/server.mjs`)。`node:` 組み込みモジュールのみ使用し、npm パッケージは不要 |
| モダンブラウザ | 最新版の Chrome / Edge / Firefox 等 | ○ | 4K(3840×2160)常設表示前提のダッシュボード表示 |
| Python 3 | 3.x | — | バックエンド無しでフロント単体配信する場合のみ(`python3 -m http.server`)。任意の静的サーバで代替可 |
| [Hamlib](https://hamlib.github.io/) (`rotctld`) | — | — | アンテナロータ実機(またはダミー)を接続する場合のみ。詳細は [server/README.md](server/README.md) |

Node.js のバージョン確認:

```bash
node --version   # v18.0.0 以上であること
```

### 取得と配置

```bash
# リポジトリを取得(または配布アーカイブを展開)
git clone <repository-url> SCC
cd SCC
```

依存パッケージのインストール(`npm install` 等)は不要。`js/vendor/satellite.min.js`(satellite.js v6, MIT)は同梱済み。

### 動作確認

```bash
node server/test.mjs     # セルフテスト。成功で ALL PASS を出力
```

`ALL PASS` が表示されればインストール完了。続けて下記「起動」へ。

## 起動

ビルド不要・npm不要(Node組み込みのみ)。

**推奨: バックエンドごと起動**(静的配信 + WebSocket + rotctld対応):

```bash
cd SCC
node server/server.mjs                # → http://localhost:8000 (ヘッダに WS LINK と出れば接続済)
node server/server.mjs --tle my.tle   # 実TLEで運用
node server/server.mjs --config server/config.json   # rotctld でロータ実機接続 (server/README.md 参照)
```

**フロントエンド単体**(バックエンドなし。自動でローカルシミュレータにフォールバック):

```bash
python3 -m http.server 8000   # → ヘッダの DATA SOURCE が LOCAL SIM 表示
```

## 機能(フェーズ1 = UI + シミュレータ)

| パネル | 内容 |
|---|---|
| GROUND TRACK | 世界地図(Natural Earth 110m)+ 地上軌跡±1周回、可視域円、昼夜ターミネータ、局リンク表示 |
| SKY PLOT | 選択局の極座標パス予測・衛星位置・アンテナ指向レティクル、AUTO TRACK/手動スルー制御 |
| ANTENNA FARM | 6局(八王子/根室/石垣島/対馬/父島・小笠原/南鳥島)の統合監視カード |
| TELEMETRY | ステータスタイル6枚(プルダウンで全32chから選択・永続化)+ EPS/温度/ADCS/COM ストリップチャート(直近30分) |
| PASS SCHEDULE | 今後24時間のパス計画ガント(仰角で濃淡)+ NET行(局をまたいだ統合コンタクトウィンドウ) |
| COMMAND | 2段階送信(ARM→SEND)、危険コマンド確認、パス外は自動キューイング |
| QUEUE / HISTORY | コマンドキューとACK/EXEC/FAIL履歴 |
| DOWNLINK / SW UPDATE | ファイル受信進捗、フライトソフトウェアOTA更新の状態機械 |
| EVENT LOG | AOS/LOS・FDIR・コマンド等の時系列ログ(レベルフィルタ付き) |

ヘッダバーでシミュレーション速度を ×1/×10/×60/×600 に変更可能。×600にするとパスの
AOS→追尾→ダウンリンク→LOS の一連の連動が短時間で確認できる。

## アーキテクチャ

```
index.html             レイアウト(CSS Grid 24列)
css/main.css           デザイントークン+共通部品(ダークテーマ固定)
js/vendor/satellite.min.js  satellite.js v6 (MIT) — SGP4 伝播エンジン
js/core/state.js       SCC.bus(イベントバス)/ SCC.state(単一ステート)/ 共通ユーティリティ
js/core/orbit.js       軌道計算: SGP4/TLE (公開APIは座標系非依存、setTLE で要素更新)
js/core/mockdata.js    ローカルシミュレータ(バックエンド未接続時のフォールバック)
js/core/proto.js       WSプロトコル共有コーデック(ブラウザ/サーバ両用)
js/core/wsclient.js    SCC.net — WS接続・サーバ権威化・自動フォールバック・再接続
js/panels/*.js         各パネル(SCC.state 読取 + SCC.ops 呼出のみ。通信層に非依存)
server/server.mjs      依存ゼロNodeバックエンド: 静的配信+WS(RFC6455自前)+rotctldアダプタ
server/test.mjs        セルフテスト(偽rotctld込み、`node server/test.mjs` → ALL PASS)
```

バックエンドはフロントエンドと**同一のシミュレータコード**をサーバ側で実行して配信する
(将来ここを実衛星のTNC/SDR受信系に置き換えても、プロトコル(SPEC.md §7)は不変)。
アンテナロータは Hamlib `rotctld` 経由で実機接続可能: 接続された局は実測 Az/El が
UIに反映される。URLパラメータ: `?mode=mock`(ローカル強制)/ `?ws=ws://host:port/ws`(接続先指定)。

詳細仕様は [SPEC.md](SPEC.md) を参照。

## ライセンス

本リポジトリのソースコードは [Apache License 2.0](LICENSE) で提供します。
著作権者: © 2026 YUZUKI (animede)。著作権表示と [NOTICE](NOTICE) の内容は、再配布時も保持してください。
モデルや依存ライブラリ等には各配布元のライセンスが別途適用されます。
