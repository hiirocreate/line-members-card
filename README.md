# LINE会員証 — 動的会員登録フォーム

店舗ごとに登録項目・入力形式・必須/任意・表示順・選択肢を変更できる動的フォーム基盤 (依存ライブラリなし / Node 20+)。

- `npm test` — テスト実行 / `npm start` — 会員向け公開API (`/t/<token>`, `/t/<token>/form|confirm|register`)
- `src/store.js` — テーブル型ストア。`SHEETS` が Google Sheets のシート/ヘッダー定義 (`members` / `custom_fields` / `member_custom_values` ほか)。`exportSheets()/importSheets()` で相互変換。Sheets API 実装へは同じメソッド群を実装して差し替え
- `src/master.js` 項目マスタ・禁止語(高リスク情報) / `src/forms.js` 項目管理・バージョン・テンプレ・監査 / `src/members.js` 登録・変更・検索・CSV / `src/render.js` スマホ向けフォームHTML(全値エスケープ)

設計の要点: 項目は無効化のみ (完全削除は運営のみ)・値は `field_id` で保持するため過去会員は壊れない / 全操作 `tenant_id` で分離 / 配信同意は同意項目からのみ付与 / 出力は `EXPORT_*` 権限を独立管理。

未実装(要件外の接続部分): LINE IDトークン検証 (`createServer` の `verifyUser` フック)、管理画面UI(D&D・リアルタイムプレビューは `renderForm` を利用)、Sheets API アダプタ、OR条件のUI。
