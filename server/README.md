# SCC server — フェーズ2 参照バックエンド

`js/core/state.js` / `orbit.js` / `mockdata.js` をそのまま Node 上で動かし、静的配信と
WebSocket(`/ws`)で配信する。npm パッケージ不使用、`node:` 組み込みモジュールのみ。

## 起動

```bash
cd SCC
node server/server.mjs
# → ブラウザで http://localhost:8000 を開く
```

オプション:

```bash
node server/server.mjs --port 8000 --config server/config.json --tle path/to/hikari1.tle
```

| オプション | 既定値 | 内容 |
|---|---|---|
| `--port` | `8000` | HTTP/WebSocket 待受ポート |
| `--config` | (無効) | rotctld 連携設定ファイル(下記) |
| `--tle` | (内蔵の円軌道モデル) | TLE ファイルで軌道を上書き(`SCC.orbit.setTLE` が実装されている場合のみ) |

`ws://<host>:<port>/ws` に接続すると、接続直後に `hello`(全量スナップショット)、以降は
`tick` / `log` / `pass-change` / `command-sent` / `command-ack` が配信される。プロトコルの
正は `js/core/proto.js`。クライアント→サーバは `{"type":"op","name":"...","args":[...]}` の
形で `SCC.proto.OPS_WHITELIST` に載っているオペレーションのみ実行される。

## config.json (rotctld 連携)

`--config` を指定しない場合、ロータ連携は無効(シミュレータ内蔵のアンテナ挙動のみ)。

```json
{
  "rotators": {
    "GS-TKY": { "host": "127.0.0.1", "port": 4533 }
  }
}
```

(`server/config.example.json` をコピーして使う。)

キーは `SCC.state.stations[].id`(GS-TKY / GS-HKD / GS-OKN / GS-SVB)。エントリごとに
Hamlib rotctld(TCP)へ接続し、接続中は 500ms ごとに `P <az> <el>` で指令 → `p` で実測値を
読み取り `SCC.state` に反映する。接続中は該当局の `antenna.hw = true` となり、シミュレータの
自前スルー積分は止まる(実測値がそのまま `az`/`el` になる)。切断時は自動的に10秒ごと再接続。

### 実機(またはダミー)rotctld を試す

Hamlib がインストールされていれば、ダミーロータで動作確認できる:

```bash
rotctld -m 1 -T 127.0.0.1 -t 4533     # モデル1 = ダミーロータ、127.0.0.1:4533 で待受
node server/server.mjs --config server/config.example.json
```

## OBCコンソール (擬似シェル / 実SSH)

フロントエンドのターミナルパネルは WebSocket 上の `term-open` / `term-input` /
`term-resize` / `term-close` ⇄ `term-output` / `term-exit`(プロトコルの正は
`js/core/proto.js`)で、WS接続ごとに最大1つの端末セッションを持つ。

**既定(config に `obc` を書かない、または `"obc": {"mode": "sim"}`)**: サーバが
`js/core/satshell.js` の擬似OBCシェル(HIKARI-1 相当の仮想Linux環境)をそのまま
実行し、その出力を `term-output` としてそのクライアントにのみ返す。実機無しで
フルに動作確認できる。エコー・行編集・履歴・カーソル移動・Tab補完はすべて
satshell 側の責務(実PTYと同じ流儀)。

利用可能コマンド例:

```
$ tlm eps          # EPS(電源)サブシステムのテレメトリ
$ adcs             # 姿勢制御の現在モード・角速度
$ pass next        # 次の地上局パスの予測
$ gs               # 地上局一覧とアンテナ状態
$ orbit            # 現在のTLE・周期・高度・現在位置
$ uname -a / uptime / ps / top / free -m / df -h   # 通常のLinuxコマンド一通り
```

**実機接続 (`config.obc.mode: "ssh"`)**: config.json に以下のように書くと、
サーバはそのクライアントの端末セッションを実機OBCへの実SSH接続に切り替える
(util-linux の `script` コマンドで擬似PTYを確保して `ssh -tt` を起動する)。

```json
{
  "obc": {
    "mode": "ssh",
    "host": "192.168.1.50",
    "user": "ops",
    "port": 22,
    "sshArgs": []
  }
}
```

`script` が無い・起動に失敗した場合は、その旨を端末に表示した上で自動的に
擬似シェル(satshell)にフォールバックする。ウィンドウサイズ変更(resize)は
`script` 経由の子プロセスに `TIOCSWINSZ` を直接送る手段が無いためベストエフォート
(実質何もしない)。

セキュリティ注記: 実SSH経由は運用者が config で明示的に有効化した場合のみ動作
する。ホスト鍵検証・認証(パスワード/鍵)は OS の ssh クライアント設定
(`~/.ssh/config` / `known_hosts` / `ssh-agent` 等)にすべて委ねる — 本サーバは
認証情報を扱わない。信頼できないネットワークにこの WebSocket を公開する場合は
別途アクセス制御を行うこと。

## TLE ファイル指定

2行 TLE、または3行(1行目=衛星名、無視)のテキストファイルを渡す:

```
HIKARI-1
1 99001U 25999A   26001.00000000  .00000000  00000-0  00000-0 0  9999
2 99001  97.6000 130.0000 0001000   0.0000   0.0000 15.05000000    01
```

```bash
node server/server.mjs --tle ./hikari1.tle
```

読み込みに失敗した場合(ファイルなし・パース不能・`orbit.setTLE` が false/例外を返す)は
警告を出して既定の軌道モデルで続行する。`orbit.js` が `setTLE` を実装していない版の場合は
黙ってスキップする(フェーズ1互換)。

## セルフテスト

```bash
node server/test.mjs
```

サーバを子プロセスで起動し、偽の rotctld(net）と WebSocket クライアントで一連の動作
(hello/tick 受信・op 送信・rotctld 連携・OBC端末ブリッジ(擬似シェル)の起動と応答)を
検証する。依存ゼロ。成功時は `ALL PASS` を出力して終了する。
