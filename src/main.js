// 起動エントリ。環境変数:
//  SESSION_SECRET (32文字以上) / LINE_LOGIN_CHANNEL_ID / LIFF_ID / PORT
//  ストア: GOOGLE_SERVICE_ACCOUNT_JSON + SPREADSHEET_ID (Sheets) | DATA_FILE (ローカル開発)
//  初回の運営管理者: OPERATOR_EMAIL / OPERATOR_PASSWORD
import { createApp } from './app.js';
import { createServer } from './server.js';
import { SheetsStore } from './sheetsStore.js';
import { bootstrapOperator } from './auth.js';

let store;
if (process.env.SPREADSHEET_ID) {
  store = new SheetsStore({ spreadsheetId: process.env.SPREADSHEET_ID, serviceAccount: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  await store.init();
}
const app = createApp(store ?? process.env.DATA_FILE ?? null);
if (bootstrapOperator(app.store, process.env.OPERATOR_EMAIL, process.env.OPERATOR_PASSWORD)) console.log('operator account created');
await app.store.flush?.();

const server = createServer(app).listen(process.env.PORT ?? 8080);
process.on('SIGTERM', () => server.close(async () => { await app.store.flush?.(); process.exit(0); }));
