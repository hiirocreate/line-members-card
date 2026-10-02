import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SheetsStore } from '../src/sheetsStore.js';
import { SHEETS } from '../src/store.js';
import { createApp } from '../src/app.js';
import { OP, ADMIN_A } from './helpers.js';

// 最小の Google Sheets / OAuth 偽サーバ (fetch 差し替え)
function fakeGoogle() {
  const sheets = new Map(); let authCalls = 0; const log = [];
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    if (url.includes('oauth2')) { authCalls++; return json({ access_token: 't', expires_in: 3600 }); }
    assert.equal(init.headers.authorization, 'Bearer t');
    const path = decodeURIComponent(url.split('/spreadsheets/SID')[1]); log.push(`${init.method ?? 'GET'} ${path.split('?')[0]}`);
    if (path.startsWith('?fields')) return json({ sheets: [...sheets.keys()].map((title) => ({ properties: { title } })) });
    if (path.startsWith(':batchUpdate')) { for (const r of JSON.parse(init.body).requests) sheets.set(r.addSheet.properties.title, []); return json({}); }
    if (path.startsWith('/values:batchGet')) return json({ valueRanges: [...path.matchAll(/ranges=([^&]+)/g)].map((m) => ({ values: sheets.get(m[1]) })) });
    let m;
    if ((m = /^\/values\/(\w+):clear/.exec(path))) { sheets.set(m[1], []); return json({}); }
    if ((m = /^\/values\/(\w+)!A1/.exec(path))) { assert.ok(path.includes('valueInputOption=RAW')); sheets.set(m[1], JSON.parse(init.body).values); return json({}); }
    throw new Error(`unexpected ${path}`);
  };
  return { fetchImpl, sheets, log, get authCalls() { return authCalls; } };
}
const sa = () => ({ client_email: 'sa@x.iam', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });

test('SheetsStore: 初期化→書き込み→再起動で復元。変更シートのみ書き戻し', async () => {
  const g = fakeGoogle();
  const mk = () => new SheetsStore({ spreadsheetId: 'SID', serviceAccount: sa(), fetchImpl: g.fetchImpl, tokenUrl: 'https://oauth2.example/token' });
  const s1 = mk(); await s1.init();
  assert.deepEqual([...g.sheets.keys()].sort(), Object.keys(SHEETS).sort());
  const app = createApp(s1);
  app.forms.createTenant(OP, 'SHOP001', 'テスト店');
  app.forms.applyTemplate(ADMIN_A, 'SHOP001', 'standard');
  const f = app.forms.fields('SHOP001');
  const m = app.members.register('SHOP001', 'U1', { [f[0].field_id]: '山田', [f[1].field_id]: '09011112222' }, { confirmed: true });
  await s1.flush();
  g.log.length = 0;
  app.members.updateByStaff(ADMIN_A, 'SHOP001', m.member_id, { [f[2].field_id]: 'a@b.co' });
  await s1.flush();
  const written = g.log.filter((l) => l.startsWith('PUT')).map((l) => l.split('/')[2].split('!')[0]);
  assert.ok(written.every((n) => ['members', 'audit_logs', 'member_custom_values'].includes(n)), written.join());
  assert.ok(!written.includes('custom_fields'));

  // 先頭ゼロの電話番号/会員番号が文字列のまま、再起動後に復元される
  const s2 = mk(); await s2.init();
  const app2 = createApp(s2);
  const mem = s2.find('members', (x) => x.user_id === 'U1');
  assert.equal(mem.phone, '09011112222'); assert.equal(mem.member_number, '000001'); assert.equal(mem.email, 'a@b.co');
  assert.equal(app2.forms.fields('SHOP001').length, 5);
  assert.equal(app2.members.profile(ADMIN_A, 'SHOP001', mem.member_id).items.find((i) => i.label === 'メールアドレス').value, 'a@b.co');
  assert.equal(g.authCalls <= 2, true); // トークンはキャッシュされる
});

test('SheetsStore: flush失敗時は dirty を保持して再試行できる', async () => {
  const g = fakeGoogle(); let fail = false;
  const s = new SheetsStore({ spreadsheetId: 'SID', serviceAccount: sa(), tokenUrl: 'https://oauth2.example/token',
    fetchImpl: (u, i) => (fail && String(u).includes(':clear') ? Promise.resolve(new Response('x', { status: 500 })) : g.fetchImpl(u, i)) });
  await s.init();
  s.insert('settings', { key: 'k', value: 1 });
  fail = true; await assert.rejects(s.flush(), /Sheets API 500/);
  fail = false; await s.flush();
  assert.deepEqual(g.sheets.get('settings')[1], ['k', '1']);
});
