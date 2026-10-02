# LINE会員証 — 動的会員登録フォーム

店舗ごとに登録項目・入力形式・必須/任意・表示順・選択肢を変更できる動的フォーム基盤 (依存ライブラリなし / Node 20+)。

- `npm test` — テスト / `npm start` — サーバ起動 (環境変数と手順は `docs/DEPLOY.md`)
- 会員向け: `/app` (LINEミニアプリ画面) と `/t/<token>/{form,confirm,register,me}` (LINE IDトークン検証)
- 管理画面: `/admin` (フォーム設定[D&D並び替え・スマホプレビュー]/会員検索・編集・Excel出力/登録URL/監査ログ/運営[店舗・管理者])
- 管理API: `/api/admin/*` (ログイン→Bearerトークン。店舗は常にログイン管理者の `tenant_id` に固定、`?tenant=` は運営のみ)
- `src/sheetsStore.js` Google Sheets 永続化 / `src/store.js` シート定義とメモリストア / `src/xlsx.js` `.xlsx` 出力 / `src/auth.js` 認証
- `src/master.js` 項目マスタ・禁止語 / `src/forms.js` 項目管理・バージョン・テンプレ・監査 / `src/members.js` 登録・検索・出力 / `src/render.js` プレビュー用HTML

設計の要点: 項目は無効化のみ (完全削除は運営のみ)・値は `field_id` で保持するため過去会員は壊れない / 全操作 `tenant_id` で分離 / 配信同意は同意項目からのみ付与 / 出力は `EXPORT_*` 権限を独立管理。

未実装: 運営用のマスタ項目追加・禁止語設定のUI (APIは用意済み)、OR条件のUI。
