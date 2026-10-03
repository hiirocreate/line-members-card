import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADMIN_A, OP } from './helpers.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';

const SECRET = 'x'.repeat(40);
// LINE検証のモック: トークン文字列がそのまま userId
import { AuthError } from '../src/sanitize.js';
const verifyLine = async (tok) => { if (!tok || !tok.startsWith('line:')) throw new AuthError('LINEの認証に失敗しました'); return tok.slice(5); };

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
const login = async (call, email, password, code) => (await call('/api/admin/login', { method: 'POST', body: { email, password, code } })).json?.token;

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
    assert.equal((await call(`/t/${tokenA}/register`, { method: 'POST', body: { values, confirmed: true } })).status, 401); // 認証なし
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
    assert.match(u.url, /^https:\/\/liff\.line\.me\/1234-abcd\?t=[0-9a-f]{32}$/);
    // 管理者無効化は即時反映
    await call(`/api/admin/admins/${app.store.find('admins', (a) => a.email === 's@x.jp').admin_id}/disable`, { method: 'POST', token: O });
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: S, body: {} })).status, 401);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('死活確認用パス /status', async () => {
  const { app } = setup();
  const { srv, call } = await boot(app);
  try { assert.deepEqual((await call('/status')).json, { ok: true }); assert.deepEqual((await call('/healthz')).json, { ok: true }); } finally { srv.closeAllConnections(); srv.close(); }
});

test('管理画面の静的配信: CSPは自己ホストのスクリプトのみ', async () => {
  const { app } = setup();
  const { srv, call } = await boot(app);
  try {
    for (const p of ['/admin', '/admin.js', '/admin.css', '/formkit.js', '/vendor/qrcode.min.js', '/vendor/jsQR.js']) assert.equal((await call(p)).status, 200, p);
    const csp = (await call('/admin')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/); assert.ok(!csp.includes('unsafe-inline') || !/script-src[^;]*unsafe-inline/.test(csp));
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

test('会員API: 店舗ごとのLINEチャネルで検証 / QR / ショップカード / 退会 / 再入会', async () => {
  const { app, tokenA, tokenB } = setup();
  app.forms.applyTemplate(ADMIN_A, 'SHOP001', 'basic');
  const { setLine } = await import('../src/settings.js');
  setLine(app.store, app.vault, ADMIN_A, 'SHOP001', { liffId: '1111111111-AaAaAaAa', loginChannelId: '1111111111', shopcardUrl: 'https://lin.ee/shop1' });
  const channels = [];
  const srv = createServer(app, { sessionSecret: SECRET, liffId: '9999999999-Default', lineChannelId: '9999999999', verifyLine: async (tok, ch) => { channels.push(ch); return verifyLine(tok); } }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    // 店舗ごとのLIFF ID (未設定の店舗は既定値)
    assert.equal((await call(`/app/config.json?t=${tokenA}`)).json.liffId, '1111111111-AaAaAaAa');
    assert.equal((await call(`/app/config.json?t=${tokenB}`)).json.liffId, '9999999999-Default');
    assert.equal((await call('/app/config.json?t=zzz')).json.liffId, '9999999999-Default');
    const [n, p] = (await call(`/t/${tokenA}/form`)).json.fields.map((f) => f.field_id);
    const values = { [n]: '山田', [p]: '09011112222' };
    const reg = () => call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { values, confirmed: true } });
    assert.equal((await reg()).status, 201);
    assert.equal(channels.at(-1), '1111111111'); // 店舗Aのチャネルで検証
    await call(`/t/${tokenB}/me`, { token: 'line:U1' }); assert.equal(channels.at(-1), '9999999999');
    const me = (await call(`/t/${tokenA}/me`, { token: 'line:U1' })).json;
    assert.equal(me.shopcardUrl, 'https://lin.ee/shop1');
    assert.equal((await call(`/t/${tokenA}/qr`)).status, 401);
    const qr = (await call(`/t/${tokenA}/qr`, { token: 'line:U1' })).json;
    assert.match(qr.code, /^MC1\./);
    assert.equal((await call(`/t/${tokenA}/qr`, { token: 'line:U9' })).status, 400); // 未登録者
    // 退会
    assert.equal((await call(`/t/${tokenA}/withdraw`, { method: 'POST', token: 'line:U1', body: { reason: 'テスト' } })).status, 200);
    assert.deepEqual((await call(`/t/${tokenA}/me`, { token: 'line:U1' })).json, { registered: false, withdrawn: true, shop: 'テスト美容室' });
    assert.equal((await call(`/t/${tokenA}/qr`, { token: 'line:U1' })).status, 400);
    assert.equal((await call(`/t/${tokenA}/me`, { method: 'PATCH', token: 'line:U1', body: { values: { [n]: 'x' } } })).status, 400);
    assert.equal(app.store.select('members').length, 1); // データは残っている
    // 再入会
    assert.equal((await reg()).json.member_number, '000001');
    assert.equal((await call(`/t/${tokenA}/me`, { token: 'line:U1' })).json.registered, true);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('管理API: 来店QRスキャン・退会/復帰・2FA・再設定リンク・配信・LINE設定', async () => {
  const sent = [];
  const { app, tokenA } = setup();
  app.fetchImpl = async (u, i) => { sent.push([String(u), i.body && JSON.parse(i.body)]); return new Response(JSON.stringify({ displayName: '店A' }), { status: 200 }); };
  app.messaging.fetchImpl = app.fetchImpl;
  const pw = 'correct-horse-battery';
  createAdmin(app.store, OP, { role: 'OPERATOR', email: 'op@x.jp', password: pw });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP001', email: 'a@x.jp', password: pw });
  createAdmin(app.store, OP, { role: 'STAFF', tenantId: 'SHOP001', email: 's@x.jp', password: pw });
  app.forms.applyTemplate(ADMIN_A, 'SHOP001', 'basic');
  const consent = app.forms.addCustomField(ADMIN_A, 'SHOP001', { field_name: 'LINE配信', field_type: 'CHECKBOX', consent_target: 'LINE' }).field_id;
  const [n, p] = app.forms.fields('SHOP001').map((f) => f.field_id);
  const { srv, call } = await boot(app);
  try {
    const A = await login(call, 'a@x.jp', pw), S = await login(call, 's@x.jp', pw), O = await login(call, 'op@x.jp', pw);
    const R = (uid, c) => call(`/t/${tokenA}/register`, { method: 'POST', token: `line:${uid}`, body: { confirmed: true, values: { [n]: uid, [p]: '09011112222', [consent]: c } } });
    await R('U1', true); await R('U2', false);
    // スキャン (スタッフ可)
    const code = (await call(`/t/${tokenA}/qr`, { token: 'line:U1' })).json.code;
    const scan = await call('/api/admin/visits/scan', { method: 'POST', token: S, body: { code } });
    assert.equal(scan.status, 200); assert.equal(scan.json.visit_count, 1);
    assert.equal((await call('/api/admin/visits/scan', { method: 'POST', token: S, body: { code } })).status, 400);
    assert.equal((await call('/api/admin/visits', { token: S })).json.visits[0].method, 'QR');
    // 退会/復帰: スタッフ不可、管理者可。検索の状態フィルタ
    assert.equal((await call('/api/admin/members/M002/withdraw', { method: 'POST', token: S, body: {} })).status, 403);
    assert.equal((await call('/api/admin/members/M002/withdraw', { method: 'POST', token: A, body: { reason: '依頼' } })).status, 200);
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: A, body: {} })).json.total, 1);
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: A, body: { status: 'WITHDRAWN' } })).json.total, 1);
    assert.equal((await call('/api/admin/members/M002/restore', { method: 'POST', token: A })).status, 200);
    // LINE設定 → テスト → 配信
    assert.equal((await call('/api/admin/line-settings', { token: S })).status, 403);
    const set = await call('/api/admin/line-settings', { method: 'PUT', token: A, body: { messagingToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', shopcardUrl: 'https://lin.ee/x1' } });
    assert.equal(set.json.hasMessagingToken, true); assert.ok(!JSON.stringify(set.json).includes('abcdefghij'));
    assert.equal((await call('/api/admin/line-settings', { method: 'PUT', token: A, body: { shopcardUrl: 'https://evil.example' } })).status, 400);
    assert.equal((await call('/api/admin/line-settings/test', { method: 'POST', token: A })).json.displayName, '店A');
    assert.equal((await call('/api/admin/messages/preview', { method: 'POST', token: A, body: {} })).json.audience, 1);
    assert.equal((await call('/api/admin/messages/send', { method: 'POST', token: S, body: { text: 'x', expectedCount: 1 } })).status, 403);
    const sendRes = await call('/api/admin/messages/send', { method: 'POST', token: A, body: { text: 'こんにちは', expectedCount: 1 } });
    assert.equal(sendRes.status, 201); assert.equal(sendRes.json.sent, 1);
    assert.deepEqual(sent.at(-1)[1].to, ['U1']);
    assert.equal((await call('/api/admin/messages', { token: A })).json.messages.length, 1);
    // 2FA: 設定→再ログインにコード必須
    const su = await call('/api/admin/security/2fa/setup', { method: 'POST', token: A, body: { password: pw } });
    const { totp } = await import('../src/totp.js');
    const en = await call('/api/admin/security/2fa/enable', { method: 'POST', token: A, body: { code: totp(su.json.secret) } });
    assert.equal(en.json.recoveryCodes.length, 8);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: pw } })).json.requires2fa, true);
    assert.ok(await login(call, 'a@x.jp', pw, totp(su.json.secret)));
    // 再設定リンク: スタッフのパスワードを店舗管理者が再発行 → スタッフの旧セッション失効
    const sid = (await call('/api/admin/admins', { token: A })).json.admins.find((x) => x.email === 's@x.jp').admin_id;
    const link = (await call(`/api/admin/admins/${sid}/reset-link`, { method: 'POST', token: A })).json;
    assert.match(link.path, /^\/admin#reset=/);
    assert.equal((await call('/api/admin/password-reset/consume', { method: 'POST', body: { token: link.token, password: 'a-brand-new-password' } })).status, 200);
    assert.equal((await call('/api/admin/members/search', { method: 'POST', token: S, body: {} })).status, 401);
    assert.ok(await login(call, 's@x.jp', 'a-brand-new-password'));
    // 運営: 禁止語・マスタ追加
    assert.ok((await call('/api/admin/banned-terms', { token: O })).json.terms.includes('病歴'));
    assert.equal((await call('/api/admin/banned-terms', { token: A })).status, 403);
  } finally { srv.closeAllConnections(); srv.close(); }
});
