# デプロイ手順 (Cloud Run + Google Sheets + LINEミニアプリ)

## 1. Google Sheets (運営者のみ) — JSONキー不要の方式
1. 新しいスプレッドシートを作成 (シートは起動時に自動作成される)。URLの `/d/<ID>/` が `SPREADSHEET_ID`。
2. GCP で Sheets API / Cloud Run Admin API / Cloud Build API / Artifact Registry API / Secret Manager API を有効化。
3. サービスアカウント(例 `sheets-writer`)を作成する。**キーは作らない**(組織ポリシーでキー作成が禁止されていても問題なし)。
4. このサービスアカウントに次のロールを付与 (IAM):
   - 「Secret Manager のシークレット アクセサー」(プロジェクト)
   - 「サービスアカウント トークン作成者」(**このサービスアカウント自身**に対して。サービスアカウントの権限タブ→「アクセスを許可」→プリンシパルに自分自身のメールを指定)
5. スプレッドシートを **このサービスアカウントのメールにのみ「編集者」で共有**。店舗・スタッフには共有しない (店舗は管理画面経由でのみ閲覧)。
6. デプロイ時に `--service-account sheets-writer@<プロジェクトID>.iam.gserviceaccount.com` を指定して、Cloud Run の実行アカウントにする。
(従来どおり JSON キーを使う場合は、キーを Secret Manager に保存して `GOOGLE_SERVICE_ACCOUNT_JSON` に渡す。未設定ならキーレスで動く。)

## 2. LINE
1. LINE Developers で「LINEログイン」チャネルを作成 → **チャネルID** = `LINE_LOGIN_CHANNEL_ID`。
2. LIFF アプリ (LINEミニアプリ) を作成。エンドポイントURL = `https://<Cloud RunのURL>/app`。スコープは `openid`(必須)。→ **LIFF ID** = `LIFF_ID`。
3. 各店舗の公式アカウントのリッチメニューに、管理API `POST /api/admin/registration-url` が返す URL
   (`https://liff.line.me/<LIFF_ID>?t=<店舗token>`) を設定する。token が漏れた場合は `DELETE /api/admin/registration-url/<token>` で無効化し再発行。
4. 別法人の公式アカウントとミニアプリのプロバイダーの関係は LINE の仕様に従う。導入前に、各社の公式アカウントからこのURLを開けること・userId が取得できることを実機で確認する。

## 3. Cloud Run
```
gcloud run deploy line-members --source . --region asia-northeast1 \
  --service-account sheets-writer@<プロジェクトID>.iam.gserviceaccount.com \
  --max-instances 1 --allow-unauthenticated \
  --set-env-vars LINE_LOGIN_CHANNEL_ID=...,LIFF_ID=...,SPREADSHEET_ID=...,OPERATOR_EMAIL=you@example.com,PUBLIC_ORIGIN=https://<サービスURL> \
  --set-secrets SESSION_SECRET=session-secret:latest,DATA_ENCRYPTION_KEY=data-key:latest,OPERATOR_PASSWORD=operator-password:latest
```
- `--max-instances 1` は必須 (Sheets へ全シート書き戻しのため、複数インスタンスだと上書きし合う)。
- `SESSION_SECRET` は 32 文字以上のランダム文字列。変更すると全員が再ログインになる。
- `DATA_ENCRYPTION_KEY` (32文字以上・必須級): 店舗のLINEチャネルアクセストークンと二段階認証の秘密鍵の暗号化に使う。**紛失・変更すると保存済みの値は復号できなくなる**ので、Secret Manager で厳重に保管し、`SESSION_SECRET` とは別の値にする。
- 初回起動で運営管理者が作成される。以後 `OPERATOR_PASSWORD` はシークレットから外してよい。
- 運営管理者でログイン → `POST /api/admin/tenants` で店舗作成 (登録token返却) → `POST /api/admin/admins` で店舗管理者作成。

## 4. 運用上の注意
- Sheets は書き込み1回あたり対象シートを全書き換えする。会員が数千件規模になったら DB (Firestore 等) への移行を検討 (`Store` と同じメソッドを実装すれば差し替え可能)。
- Sheets 側の手作業編集は、次回起動時に取り込まれる。稼働中のシート直接編集はしない。

## 5. 店舗ごとのLINE連携 (管理画面「LINE連携」タブ)
別法人の店舗は、**店舗の公式アカウントと同じプロバイダー内**に次を作成してもらい、値を設定する。
- LINEログインチャネル (→ チャネルID) と LIFF アプリ (→ LIFF ID、エンドポイントURL = `https://<Cloud RunのURL>/app`)
- 公式アカウントの Messaging API チャネルのチャネルアクセストークン (長期) → メッセージ配信に使用 (暗号化保存・画面には再表示されない)。Messaging API チャネルはコンソールから直接は作れない(2024-09-04〜)。LINE公式アカウントを作成し、LINE Official Account Manager で Messaging API を有効化する際に、ログインチャネルと同じプロバイダーを選ぶ(後から変更不可)。
- 会員にメッセージが届くのは、公式アカウントを友だち追加していてブロックしていない場合のみ。LIFF の「Add friend option」を有効にしておく。
- 公式LINEの「ショップカード」の配布URL (`https://lin.ee/...` 等) → 会員証の「ショップカードを開く」ボタン。LINEドメインのURLのみ設定可
- 注意: プロバイダーが異なると、ミニアプリで取得するユーザーIDと Messaging API のユーザーIDが一致せず、配信できない。
- 配信は LINE の月間メッセージ数・プランの制限に従う (店舗の公式アカウントの契約内)。

## 6. 運用メモ
- **来店QR**: 会員証のQRは署名付き・5分有効・1回限り。スタッフは管理画面「来店スキャン」(HTTPSでカメラ許可が必要) で読み取る。同じ会員の連続記録は30分抑止。
- **退会**: 会員本人(ミニアプリ)または店舗管理者が実行。データは削除せず `status=WITHDRAWN`。配信同意は取り消され、検索は既定で除外。再登録で同じ会員番号に復帰。
- **パスワード再設定**: 管理画面の管理者一覧(店舗管理者=自店舗スタッフ / 運営=全員)から「再設定リンク」を発行して本人に渡す (1時間・1回限り)。二段階認証の解除も同じ画面。
- **二段階認証**: 各管理者が「アカウント」タブで任意に有効化 (認証アプリ + 回復コード8個)。
- **Sheets の列追加**: 新バージョンで列が増えても、起動時に既存データを保持したまま自動で列が追加される。

## 7. 二段階認証 (アプリ不要のパスキー)
- 管理画面「アカウント」→「パスキー」で、端末の指紋認証・顔認証・画面ロック解除をログインの二段階目として登録できる (認証アプリは不要)。認証アプリ(6桁コード)とも併用でき、どちらでもログインできる。
- パスキーは「ドメイン」に紐づく。**管理画面は常に同じURLで開く**こと。Cloud Run は URL を2種類発行する (`…-<プロジェクト番号>.<リージョン>.run.app` と `…-xxxx-an.a.run.app`)。環境変数 `PUBLIC_ORIGIN` に、普段使うURL(例 `https://line-members-730765585909.asia-northeast1.run.app`)を設定して固定すると、取り違えを防げる。独自ドメインへ移行するとパスキーは作り直しになる。
- 端末を紛失したときは、店舗管理者(自店舗スタッフ)または運営が「2FAリセット」で、パスキーと認証アプリの設定をまとめて解除できる。

## 8. 会員証デザイン (管理画面「会員証デザイン」タブ)
- 店舗管理者が、カード面(背景=単色/グラデーション/画像、文字色、書体、角の丸み、ロゴ、店舗名・タイトル、表示する項目、QRの位置)と、会員画面の見た目(ボタンの色、背景色、メッセージ、一覧/ショップカードボタンの表示)を設定できる。プレビューを見ながら調整し、「保存」で会員のスマホに反映される。
- 会員は「カード画像を保存」で、カードをPNG画像として保存できる (QRは5分で失効するため、保存画像には含めない)。管理画面からも「カード画像をダウンロード」できる。
- 画像(ロゴ/背景)は端末側で縮小・圧縮してアップロードされ、**スプレッドシート(`card_assets` シート)に4万文字ずつ分割して保存**される。1画像400KBまで・1店舗12枚まで。使っていない画像は、保存時に(1時間以上たったものが)自動削除される。SVGは許可しない。
- 店舗数や画像が増えてスプレッドシートが重くなったら、画像だけ Cloud Storage 等へ移す (`src/card.js` の `CardService` の画像まわりを差し替える)。
- 店舗間の分離: 画像は店舗ごとにしか取得できず、他店舗の画像IDをデザインに指定すると保存時に拒否される。
