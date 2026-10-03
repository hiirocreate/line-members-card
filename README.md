# LINE会員証 — 動的会員登録フォーム

店舗ごとに登録項目・入力形式・必須/任意・表示順・選択肢を変更できる動的フォーム基盤 (依存ライブラリなし / Node 20+)。

- `npm test` — テスト / `npm start` — サーバ起動 (環境変数と手順は `docs/DEPLOY.md`)
- 会員向け: `/app` (LINEミニアプリ: 自動ログイン・会員証QR・公式ショップカードへのリンク・登録情報変更・退会/再登録) と `/t/<token>/{form,confirm,register,me,qr,withdraw}` (LINE IDトークン検証)
- 管理画面 `/admin`: フォーム設定[D&D・スマホプレビュー] / 会員検索[AND・OR]・編集・退会/復帰・Excel出力 / 来店スキャン[QR] / メッセージ配信 / 会員証デザイン[背景・ロゴ・文字・QR位置・画面テーマ・カード画像] / LINE連携設定 / 登録URL / 監査ログ / アカウント[パスワード・二段階認証(パスキー/認証アプリ)] / 運営[店舗・管理者・マスタ項目・禁止語]
- 管理API: `/api/admin/*` (ログイン→Bearerトークン。店舗は常にログイン管理者の `tenant_id` に固定、`?tenant=` は運営のみ)
- `src/sheetsStore.js` Google Sheets 永続化 (列が増えても既存データを保持して自動移行) / `src/store.js` シート定義 / `src/xlsx.js` `.xlsx` 出力 / `src/auth.js` 認証・2FA・再設定 / `src/vault.js` 暗号化・署名 / `src/totp.js` / `src/webauthn.js` `src/cbor.js` (パスキー)
- `src/settings.js` 店舗ごとのLINE設定 / `src/messaging.js` 配信 / `src/line.js` Messaging API / `src/master.js` マスタ・禁止語 / `src/forms.js` 項目管理 / `src/members.js` 登録・検索・退会・来店 / `src/render.js` プレビュー
- `src/card.js` 会員証デザイン・画像 / `public/cardkit.js` カード描画(会員画面・管理プレビュー・画像保存で共通)
- `public/vendor/` 同梱ライブラリ (QR生成/読み取り。外部CDNへ依存しない)

設計の要点: 項目は無効化のみ・退会も削除せず `status=WITHDRAWN` (データ保持・同意は取消・再登録で同じ会員番号に復帰) / 全操作 `tenant_id` で分離 / 配信は「有効 かつ LINE配信に同意」の会員のみ / LINEトークンと2FA秘密鍵は暗号化保存 / 出力は `EXPORT_*` 権限を独立管理。

未実装: 「パスワードを忘れた」メール送信 (メール基盤が無いため、管理者が発行する1回限りの再設定リンクで代替)、会員の完全削除(意図的に未提供)。
