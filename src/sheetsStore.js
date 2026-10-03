// Google Sheets 永続化ストア。全テーブルをメモリに保持し、変更したシートだけ書き戻す。
// 認証は2通り (どちらもシートはサービスアカウントにのみ共有する。店舗には共有しない):
//  - キーレス(推奨): Cloud Run の実行用サービスアカウント自身の権限でトークンを発行 (JSONキー不要)
//  - JSONキー: serviceAccount を渡した場合のみ
// 制約: 単一インスタンス運用前提 (Cloud Run max-instances=1)。
import { createSign } from 'node:crypto';
import { Store, SHEETS } from './store.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export class SheetsStore extends Store {
  constructor({ spreadsheetId, serviceAccount = null, fetchImpl = fetch, tokenUrl = 'https://oauth2.googleapis.com/token',
    metadataUrl = 'http://metadata.google.internal', iamUrl = 'https://iamcredentials.googleapis.com' }) {
    super(null);
    Object.assign(this, { spreadsheetId, sa: serviceAccount, fetch: fetchImpl, tokenUrl, metadataUrl, iamUrl });
    this.dirty = new Set(); this.chain = Promise.resolve(); this.token = null;
  }

  // キーレス: メタデータサーバー(実行用アカウント)→ IAM Credentials で Sheets 用スコープのトークンを自分自身に発行。
  // 実行用アカウントに「サービスアカウント トークン作成者」(自分自身に対して) が必要。
  async #keylessToken() {
    const md = { headers: { 'metadata-flavor': 'Google' } };
    const [e, t] = await Promise.all([this.fetch(`${this.metadataUrl}/computeMetadata/v1/instance/service-accounts/default/email`, md),
      this.fetch(`${this.metadataUrl}/computeMetadata/v1/instance/service-accounts/default/token`, md)]);
    if (!e.ok || !t.ok) throw new Error('メタデータサーバーからサービスアカウントを取得できません (Cloud Run 上で実行していますか?)');
    const email = (await e.text()).trim(), base = (await t.json()).access_token;
    const r = await this.fetch(`${this.iamUrl}/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`, { method: 'POST',
      headers: { authorization: `Bearer ${base}`, 'content-type': 'application/json' }, body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/spreadsheets'], lifetime: '3600s' }) });
    if (!r.ok) throw new Error(`アクセストークンの発行に失敗 (${r.status}): 「サービスアカウント トークン作成者」ロールを ${email} 自身に付与してください`);
    const j = await r.json();
    this.token = { value: j.accessToken, exp: Date.parse(j.expireTime) || Date.now() + 3_000_000 };
    return this.token.value;
  }
  async #accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    if (!this.sa) return this.#keylessToken();
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
      if (!head) { sheets[name] = [SHEETS[name]]; this.dirty.add(name); return; }
      // 列が増減していても、シート側のヘッダー名で読み込んで既存データを保持する (新列は空欄)。
      if (head.join() !== SHEETS[name].join()) this.dirty.add(name);
      sheets[name] = [head, ...rows];
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
