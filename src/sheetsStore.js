// Google Sheets 永続化ストア。全テーブルをメモリに保持し、変更したシートだけ書き戻す。
// 認証はサービスアカウント(JWT)。シートはサービスアカウントにのみ共有する (店舗には共有しない)。
// 制約: 単一インスタンス運用前提 (Cloud Run max-instances=1)。
import { createSign } from 'node:crypto';
import { Store, SHEETS } from './store.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export class SheetsStore extends Store {
  constructor({ spreadsheetId, serviceAccount, fetchImpl = fetch, tokenUrl = 'https://oauth2.googleapis.com/token' }) {
    super(null);
    Object.assign(this, { spreadsheetId, sa: serviceAccount, fetch: fetchImpl, tokenUrl });
    this.dirty = new Set(); this.chain = Promise.resolve(); this.token = null;
  }

  async #accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: this.tokenUrl, iat, exp: iat + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key, 'base64url');
    const r = await this.fetch(this.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
    if (!r.ok) throw new Error(`Google auth failed: ${r.status}`);
    const j = await r.json();
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }
  async #call(path, init = {}) {
    const r = await this.fetch(`${API}/${this.spreadsheetId}${path}`, { ...init,
      headers: { authorization: `Bearer ${await this.#accessToken()}`, 'content-type': 'application/json' } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  // 起動時: 不足シートを作成し、全データを読み込む
  async init() {
    const meta = await this.#call('?fields=sheets.properties.title');
    const have = new Set(meta.sheets.map((s) => s.properties.title));
    const missing = Object.keys(SHEETS).filter((n) => !have.has(n));
    if (missing.length) await this.#call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }) });
    const ranges = Object.keys(SHEETS).map((n) => `ranges=${encodeURIComponent(n)}`).join('&');
    const data = await this.#call(`/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    const sheets = {};
    data.valueRanges.forEach((vr, i) => {
      const name = Object.keys(SHEETS)[i];
      const [head, ...rows] = vr.values ?? [];
      // ヘッダーが無い/不一致なら新規扱いでヘッダーを書く
      if (!head || head.join() !== SHEETS[name].join()) { sheets[name] = [SHEETS[name]]; this.dirty.add(name); } else sheets[name] = [head, ...rows];
    });
    const orig = this._changed; this._changed = () => {};
    this.importSheets(sheets);
    this._changed = orig;
    await this.flush();
  }

  _changed(table) { this.dirty.add(table); }

  // 変更があったシートを書き戻す。書き込みは直列化。
  flush() {
    const run = this.chain.then(async () => {
      const names = [...this.dirty]; this.dirty.clear();
      if (!names.length) return;
      const all = this.exportSheets();
      try {
        for (const n of names) {
          await this.#call(`/values/${encodeURIComponent(n)}:clear`, { method: 'POST', body: '{}' });
          await this.#call(`/values/${encodeURIComponent(`${n}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: all[n] }) });
        }
      } catch (e) { names.forEach((n) => this.dirty.add(n)); throw e; }
    });
    this.chain = run.catch(() => {}); // 失敗しても後続の書き込みは継続 (dirtyに戻してある)
    return run;
  }
}
