import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADMIN_A, OP } from './helpers.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';

const SECRET = 'x'.repeat(40);
// LINE検証のモック: トークン文字列がそのまま userId
const verifyLine = async (tok) => { if (!tok || !tok.startsWith('line:')) throw new (await import('../src/sanitize.js')).ValidationError('LINEの認証に失敗しました'); return tok.slice(5); };

async function boot(app) {
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1234-abcd' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
    const type = r.headers.get('content-type') ?? '';
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type, headers: r.headers, json: type.includes('json') ? JSON.parse(buf.toString()) : null, buf };
  };
  return { srv, call };
}
const login = async (call, email, password) => (await call('/api/admin/login', { method: 'POST', body: { email, password } })).json?.token;

test('会員API: LINE認証必須。フォーム取得→確認→登録→me→更新', async () => {
  const { app, tokenA } = setup();
  app.forms.applyTemplate(ADMIN_A, 'SHOP001', 'basic');
  const { srv, call } = await boot(app);
  try {
    const form = (await call(`/t/${tokenA}/form`)).json;
    assert.ok(!('tenant_id' in form.fields[0]));
    const [n, p] = form.fields.map((f) => f.field_id);
    const values = { [n]: '山田', [p]: '09011112222' };
    assert.equal((await call(`/t/${tokenA}/confirm`, { method: 'POST', body: { values } })).status, 200);
    assert.equal((await call(`/t/${tokenA}/register`, { method: 'POST', body: { values, confirmed: true } })).status, 400); // 認証なし
    assert.equal((await call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { values } })).status, 400); // 未確認
    assert.equal((await call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { values, confirmed: true } })).status, 201);
    const me = (await call(`/t/${tokenA}/me`, { token: 'line:U1' })).json;
    assert.equal(me.registered, true); assert.equal(me.member_number, '000001');
    assert.equal((await call(`/t/${tokenA}/me`, { token: 'line:U9' })).json.registered, false);
    assert.equal((await call(`/t/${tokenA}/me`, { method: 'PATCH', token: 'line:U1', body: { values: { [n]: '山田 花子' } } })).status, 200);
    assert.equal((await call(`/t/${'0'.repeat(32)}/form`)).status, 400);
    assert.match((await call('/app')).headers.get('content-security-policy'), /script-src/);
    assert.equal((await call('/app/config.json')).json.liffId, '1234-abcd');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('管理API: 認証・店舗分離・権限・Excel出力', async () => {
  const { app, tokenA } = setup();
  const pw = 'correct-horse-battery';
  createAdmin(app.store, OP, { role: 'OPERATOR', email: 'op@x.jp', password: pw });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP001', email: 'a@x.jp', password: pw });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP002', email: 'b@x.jp', password: pw });
  createAdmin(app.store, OP, { role: 'STAFF', tenantId: 'SHOP001', email: 's@x.jp', password: pw });
  const { srv, call } = await boot(app);
  try {
    assert.equal((await call('/api/admin/form')).status, 401);
    assert.equal((await call('/api/admin/form', { token: 'forged.token' })).status, 401);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: 'wrong' } })).status, 400);
    const A = await login(call, 'a@x.jp', pw), B = await login(call, 'b@x.jp', pw), S = await login(call, 's@x.jp', pw), O = await login(call, 'op@x.jp', pw);

    // 店舗Aがフォーム構築
    assert.equal((await call('/api/admin/form/template', { method: 'POST', token: A, body: { name: 'standard' } })).status, 200);
    const fields = (await call('/api/admin/form', { token: A })).json.fields;
    assert.equal(fields.length, 5);
    // 店舗Bには見えない。?tenant= を付けても自店舗に固定される
    assert.equal((await call('/api/admin/form?tenant=SHOP001', { token: B })).json.fields.length, 0);
    assert.equal((await call(`/api/admin/form/fields/${fields[0].field_id}`, { method: 'PATCH', token: B, body: { field_name: 'x' } })).status, 400); // B側には存在しない項目
    // 運営は ?tenant= 指定が必要
    assert.equal((await call('/api/admin/form', { token: O })).status, 400);
    assert.equal((await call('/api/admin/form?tenant=SHOP001', { token: O })).json.fields.length, 5);
    // スタッフはフォーム編集不可・Excel出力不可
    assert.equal((await call('/api/admin/form/template', { method: 'POST', token: S, body: { name: 'basic' } })).status, 403);
    assert.equal((await call('/api/admin/export', { method: 'POST', token: S, body: { columns: ['member_number'] } })).status, 403);
    // 運営専用APIは店舗管理者不可
    assert.equal((await call('/api/admin/tenants', { method: 'POST', token: A, body: { tenantId: 'X', name: 'x' } })).status, 403);

    // 会員登録→店舗A管理者のExcel出力
    const [n, p] = fields.map((f) => f.field_id);
    await call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { confirmed: true, values: { [n]: '山田 太郎', [p]: '09011112222' } } });
    const x = await call('/api/admin/export', { method: 'POST', token: A, body: { format: 'xlsx', columns: ['member_number', n, p] } });
    assert.equal(x.status, 200); assert.match(x.type, /spreadsheetml/);
    assert.equal(x.buf.subarray(0, 2).toString(), 'PK');
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: B, body: {} })).json.total, 0); // 店舗Bには0件
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: A, body: {} })).json.total, 1);
    // 登録URL発行 (リッチメニュー用)
    const u = (await call('/api/admin/registration-url', { method: 'POST', token: A })).json;
    assert.match(u.url, /^https:\/\/miniapp\.line\.me\/1234-abcd\?t=[0-9a-f]{32}$/);
    // 管理者無効化は即時反映
    await call(`/api/admin/admins/${app.store.find('admins', (a) => a.email === 's@x.jp').admin_id}/disable`, { method: 'POST', token: O });
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: S, body: {} })).status, 401);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('ログイン試行制限', async () => {
  const { app } = setup();
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP001', email: 'a@x.jp', password: 'correct-horse-battery' });
  const { srv, call } = await boot(app);
  try {
    for (let i = 0; i < 5; i++) await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: 'bad' } });
    const r = await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: 'correct-horse-battery' } });
    assert.equal(r.status, 400); assert.match(r.json.error, /上限/);
  } finally { srv.closeAllConnections(); srv.close(); }
});
