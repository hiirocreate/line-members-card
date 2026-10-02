# デプロイ手順 (Cloud Run + Google Sheets + LINEミニアプリ)

## 1. Google Sheets (運営者のみ)
1. 新しいスプレッドシートを作成 (シートは起動時に自動作成される)。URLの `/d/<ID>/` が `SPREADSHEET_ID`。
2. GCP でサービスアカウントを作成し JSON キーを発行。Sheets API を有効化。
3. スプレッドシートを **サービスアカウントのメールにのみ「編集者」で共有**。店舗・スタッフには共有しない (店舗は管理画面経由でのみ閲覧)。
4. JSON キーは Secret Manager に保存し、Cloud Run のシークレットとして `GOOGLE_SERVICE_ACCOUNT_JSON` に渡す。

## 2. LINE
1. LINE Developers で「LINEログイン」チャネルを作成 → **チャネルID** = `LINE_LOGIN_CHANNEL_ID`。
2. LIFF アプリ (LINEミニアプリ) を作成。エンドポイントURL = `https://<Cloud RunのURL>/app`。スコープは `openid`(必須)。→ **LIFF ID** = `LIFF_ID`。
3. 各店舗の公式アカウントのリッチメニューに、管理API `POST /api/admin/registration-url` が返す URL
   (`https://miniapp.line.me/<LIFF_ID>?t=<店舗token>`) を設定する。token が漏れた場合は `DELETE /api/admin/registration-url/<token>` で無効化し再発行。
4. 別法人の公式アカウントとミニアプリのプロバイダーの関係は LINE の仕様に従う。導入前に、各社の公式アカウントからこのURLを開けること・userId が取得できることを実機で確認する。

## 3. Cloud Run
```
gcloud run deploy line-members --source . --region asia-northeast1 \
  --max-instances 1 --allow-unauthenticated \
  --set-env-vars LINE_LOGIN_CHANNEL_ID=...,LIFF_ID=...,SPREADSHEET_ID=...,OPERATOR_EMAIL=you@example.com \
  --set-secrets SESSION_SECRET=session-secret:latest,GOOGLE_SERVICE_ACCOUNT_JSON=sa-key:latest,OPERATOR_PASSWORD=operator-password:latest
```
- `--max-instances 1` は必須 (Sheets へ全シート書き戻しのため、複数インスタンスだと上書きし合う)。
- `SESSION_SECRET` は 32 文字以上のランダム文字列。
- 初回起動で運営管理者が作成される。以後 `OPERATOR_PASSWORD` はシークレットから外してよい。
- 運営管理者でログイン → `POST /api/admin/tenants` で店舗作成 (登録token返却) → `POST /api/admin/admins` で店舗管理者作成。

## 4. 運用上の注意
- Sheets は書き込み1回あたり対象シートを全書き換えする。会員が数千件規模になったら DB (Firestore 等) への移行を検討 (`Store` と同じメソッドを実装すれば差し替え可能)。
- Sheets 側の手作業編集は、次回起動時に取り込まれる。稼働中のシート直接編集はしない。
