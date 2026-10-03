// 起動エントリ。環境変数:
//  SESSION_SECRET (32文字以上) / DATA_ENCRYPTION_KEY (32文字以上・推奨) / LINE_LOGIN_CHANNEL_ID / LIFF_ID (店舗未設定時の既定) / PORT
//  ストア: SPREADSHEET_ID (Sheets。GOOGLE_SERVICE_ACCOUNT_JSON が無ければキーレス認証) | DATA_FILE (ローカル開発)
//  初回の運営管理者: OPERATOR_EMAIL / OPERATOR_PASSWORD
import { createApp } from './app.js';
import { createServer } from './server.js';
import { SheetsStore } from './sheetsStore.js';
import { bootstrapOperator } from './auth.js';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET (32文字以上) が必要です');
if (!process.env.DATA_ENCRYPTION_KEY) console.warn('DATA_ENCRYPTION_KEY が未設定です: SESSION_SECRET を変更すると、保存済みのLINEトークン/二段階認証の秘密鍵が復号できなくなります');

let store;
if (process.env.SPREADSHEET_ID) {
  store = new SheetsStore({ spreadsheetId: process.env.SPREADSHEET_ID, serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null });
  await store.init();
}
const app = createApp(store ?? process.env.DATA_FILE ?? null, { secret: process.env.SESSION_SECRET, dataKey: process.env.DATA_ENCRYPTION_KEY || null });
if (bootstrapOperator(app.store, process.env.OPERATOR_EMAIL, process.env.OPERATOR_PASSWORD)) console.log('operator account created');
await app.store.flush?.();

const server = createServer(app).listen(process.env.PORT ?? 8080);
process.on('SIGTERM', () => server.close(async () => { await app.store.flush?.(); process.exit(0); }));
