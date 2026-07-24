# PageWatch

自分専用のWebサイト更新モニターツールです。管理画面は <https://t-shiokawa1.github.io/Page-Watch/> で、モニターの実行場所を2つから選べます。

| モード | モニターする場所 | Macを閉じたら | データの保存先 | 使える人 |
|--------|--------------|---------------|----------------|----------|
| **このMac** | 手元のMac（`server.py`） | 止まる（復帰後に再開） | このMacの中だけ（`data/`） | 誰でも |
| **クラウド** | GitHub Actions | 動き続ける | 非公開リポジトリ `pagewatch-data` | オーナーのみ |

通常アクセスした人には「このMac」モードだけが表示されます。クラウドはオーナー（リポジトリ所有者）専用で、書き込みトークンは所有者にしか作れないため他の人は使えません。

### オーナーがクラウドを有効にする

クラウドの切り替えは既定で隠れています。オーナーは一度だけ `?admin` 付きでページを開くと、そのブラウザで切替が表示されるようになります。

- 有効化: <https://t-shiokawa1.github.io/Page-Watch/?admin>
- 解除: <https://t-shiokawa1.github.io/Page-Watch/?admin=off>

（ソースは公開のためこの切替はUI上の出し分けにすぎませんが、クラウドを実際に操作するには所有者しか作れないトークンが必須なので、他人は操作できません。）

## できること

- サイト単位で複数のモニターURLをまとめて追加・削除・一時停止・今すぐ確認
- サイト登録時に同じドメイン内のリンクを、探索なし／1階層／2階層から選んで自動収集（最大40ページ）。詳細画面で各URLをチェックしてモニター対象を選択でき、URLの手動追加も可能
- 確認間隔をサイトごとに設定（ローカル: 5分〜6時間 / クラウド: 30分〜6時間）
- HTML・JSON・プレーンテキストの変化を検知（表示テキストと画像URLを比較。並び順だけの変化は無視）
- 更新履歴の記録、メール通知（ローカルはmacOS通知も）

## クラウドモードの初期設定（1回だけ）

1. GitHubの **Settings → Developer settings → Fine-grained tokens** でトークンを作成
   - Repository access: `pagewatch-data` のみ
   - Permissions: **Contents (Read and write)** と **Actions (Read and write)**
2. <https://t-shiokawa1.github.io/Page-Watch/> を開き、「クラウド」→ 右上の歯車 → トークンを貼り付けて保存
3. メール通知が必要なら、`pagewatch-data` の **Settings → Secrets and variables → Actions** に以下を登録
   - `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_TO`（任意で `SMTP_FROM`、SSL直結なら `SMTP_SSL=1`）

チェックは30分ごとのスケジュールで起動し、各サイトの間隔に従って実行されます（GitHub Actionsの仕様上、数分遅れることがあります）。

## ローカルモードを使う

`start.command` をダブルクリックします。起動後は Pages の画面か `http://127.0.0.1:8765` のどちらからでも操作できます（Node.jsがあれば初回に自動ビルドしますが、Pages画面を使うならPython3だけで動きます）。

ダウンロードした `start.command` は、初回だけ macOS のセキュリティ確認で開けないことがあります（「"start.command" is not opened」）。その場合は **「ゴミ箱に入れる」を押さず**「完了」を押し、**システム設定 →「プライバシーとセキュリティ」→「このまま開く（Open Anyway）」** を押してから、もう一度ダブルクリックしてください。ターミナルなら `xattr -dr com.apple.quarantine <展開したフォルダ>` で解除できます。

ログイン時の自動起動:

```bash
./install-macos.sh   # 解除は ./uninstall-macos.sh
```

メール通知・macOS通知は歯車から設定します。Gmailはアプリパスワードが必要です（SMTPホスト `smtp.gmail.com` / ポート `587` / SSLオフ）。認証情報は `data/settings.json` に所有者だけが読める権限で保存されます。

## 開発・テスト

```bash
npm install
npm run dev          # フロント (Vite)
python3 server.py    # ローカルAPI（別ターミナル）
```

```bash
python3 -m unittest discover -s tests -v
npm run build
```

`main` へpushすると GitHub Actions が自動で Pages へデプロイします。

## 構成

```
server.py        ローカルモニターサーバー + JSON API（127.0.0.1:8765）
cloud_check.py   クラウドモニター（pagewatch-data の Actions から実行）
src/             管理画面（React）。backend.ts がローカル/クラウドを切替
data/            ローカルのモニターデータ（Git非公開）
pagewatch-data   クラウドのモニターリスト・履歴（非公開リポジトリ）
```

## 検知できないもの

- JavaScriptの実行後にだけ表示される内容
- 同じURLのまま中身だけ差し替わった画像
- ボット対策で自動アクセスを拒否するサイト（HTTP 403など。画面に理由を表示します）

## 複数ページを1サイトとしてモニターする

登録時に「探索する階層」を選べます。「探索しない」を選ぶとトップURLだけをモニターします。1階層または2階層を選ぶと、同一ドメインのナビゲーションリンクを最大40ページまで候補として収集します。例えば `https://fukazawa.icems.kyoto-u.ac.jp/` なら `/whats-new/` や `/research-2/` が候補になります。PDF・画像などのダウンロードファイルと外部サイトは対象外です。

各サイト行を開くと候補URLの一覧がチェックボックスで表示されます。チェックしたURLだけをモニターし、外したURLも候補に残るため、後から再び選べます。トップURLは常にモニター対象です。URLを1件ずつ手動追加することもできます。更新があった場合はサイトを1件として通知し、履歴には変更されたURLを併記します。
