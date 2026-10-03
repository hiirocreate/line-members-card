import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { setup, OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';
import { normalizeDesign, DEFAULT_DESIGN } from '../src/card.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';
import { AuthError } from '../src/sanitize.js';

const T = 'SHOP001';
// 最小の有効なPNG (1x1)。本物のヘッダを持つので形式チェックを通る
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (extra = 0) => Buffer.concat([PNG, Buffer.alloc(extra)]); // 後ろに余分なバイトを足してサイズだけ増やす
const b64 = (b) => b.toString('base64');

test('デザインの検証: 既定値の補完・色/列挙値/文字数/HTMLの拒否', () => {
  assert.deepEqual(normalizeDesign({}), DEFAULT_DESIGN);
  const d = normalizeDesign({ textColor: '#ABCDEF', title: 'VIP', page: { welcomeText: 'ようこそ' }, background: { type: 'solid', color1: '#000000' } });
  assert.equal(d.textColor, '#abcdef'); assert.equal(d.title, 'VIP'); assert.equal(d.page.welcomeText, 'ようこそ'); assert.equal(d.background.type, 'solid');
  const bad = (input, re) => assert.throws(() => normalizeDesign(input), (e) => e.details.some((x) => re.test(x)));
  bad({ textColor: 'red' }, /文字色/); bad({ textColor: '#12345' }, /文字色/); bad({ qr: 'hidden' }, /QR/); bad({ font: 'comic' }, /書体/);
  bad({ title: 'x'.repeat(25) }, /24文字/); bad({ title: '<b>x</b>' }, /HTML/); bad({ page: { welcomeText: '<img src=x onerror=alert(1)>' } }, /HTML/);
  bad({ background: { type: 'image' } }, /画像をアップロード/); bad({ background: { overlay: 99 } }, /暗さ/); bad({ logo: { imageId: 'nope' } }, /ロゴ/);
});

test('画像の保管: 形式・サイズ・分割保存・テナント分離・削除・GC', () => {
  const { app } = setup(); const c = app.card;
  const up = (a, t, over = {}) => c.addAsset(a, t, { kind: 'logo', mime: 'image/png', data: b64(png()), ...over });
  assert.throws(() => up(STAFF_A, T), /権限/); assert.throws(() => up(ADMIN_B, T), /他店舗/);
  assert.throws(() => up(ADMIN_A, T, { mime: 'image/svg+xml' }), /PNG/);
  assert.throws(() => up(ADMIN_A, T, { data: b64(Buffer.from('<svg onload=alert(1)>')) }), /形式/);       // 拡張子/MIMEを偽装しても中身で判定
  assert.throws(() => up(ADMIN_A, T, { data: '!!not base64!!' }), /不正/);
  assert.throws(() => up(ADMIN_A, T, { kind: 'script' }), /種類/);
  assert.throws(() => up(ADMIN_A, T, { data: b64(png(400_001)) }), /大きすぎ/);
  // 大きい画像は分割されて保存され、元どおり復元できる
  const big = png(150_000), r = up(ADMIN_A, T, { data: b64(big) });
  assert.ok(app.store.select('card_assets', (a) => a.asset_id === r.id).length >= 5);
  assert.ok(app.store.select('card_assets').every((a) => a.data.length <= 40_000));
  assert.ok(c.getAsset(T, r.id).buffer.equals(big)); assert.equal(c.getAsset(T, r.id).mime, 'image/png');
  assert.equal(c.getAsset('SHOP002', r.id), null); // 他店舗からは取得できない
  // 他店舗の画像IDをデザインに使えない
  const other = c.addAsset(ADMIN_B, 'SHOP002', { kind: 'logo', mime: 'image/png', data: b64(png()) });
  assert.throws(() => c.save(ADMIN_A, T, { logo: { imageId: other.id } }), (e) => e.details.some((x) => /ロゴ/.test(x)));
  // 使用中の画像は削除できない。外せば削除できる
  c.save(ADMIN_A, T, { logo: { imageId: r.id } });
  assert.throws(() => c.deleteAsset(ADMIN_A, T, r.id), /使用中/);
  c.save(ADMIN_A, T, { logo: { imageId: null } });
  c.deleteAsset(ADMIN_A, T, r.id); assert.equal(c.getAsset(T, r.id), null);
  // 枚数の上限
  for (let i = 0; i < 12; i++) up(ADMIN_A, T);
  assert.throws(() => up(ADMIN_A, T), /12枚/);
  // 未使用で1時間以上たった画像は、保存時に自動削除される
  app.store.update('card_assets', (a) => a.tenant_id === T, { created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
  c.save(ADMIN_A, T, {}); assert.equal(c.assets(T).length, 0);
});

test('デザインの保存: 権限・バージョン・監査ログ・他店舗に影響しない', () => {
  const { app } = setup(); const c = app.card;
  assert.deepEqual(c.get(T).design, DEFAULT_DESIGN); assert.equal(c.get(T).version, 0);
  assert.throws(() => c.save(STAFF_A, T, {}), /権限/); assert.throws(() => c.save(ADMIN_B, T, {}), /他店舗/);
  const r = c.save(ADMIN_A, T, { template: 'dark', textColor: '#ffffff', page: { welcomeText: 'ご来店ありがとうございます' } });
  assert.equal(r.version, 1); assert.equal(c.save(ADMIN_A, T, { template: 'custom' }).version, 2);
  assert.equal(c.get(T).design.template, 'custom'); assert.equal(c.get('SHOP002').design.template, 'classic');
  assert.ok(app.store.select('audit_logs').some((l) => l.action === 'CARD_DESIGN_UPDATE' && l.tenant_id === T));
  // 将来の項目追加で古い保存データが欠けていても、既定値で補われる
  app.store.update('card_designs', () => true, { config: { template: 'dark' } });
  assert.equal(c.get(T).design.page.accentColor, DEFAULT_DESIGN.page.accentColor);
});

// ---- HTTP ----
const SECRET = 's'.repeat(40), PW = 'correct-horse-battery';
async function boot(app) {
  const verifyLine = async (t) => { if (!t?.startsWith('line:')) throw new AuthError('x'); return t.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token, raw } = {}) => {
    const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
    const buf = Buffer.from(await r.arrayBuffer()); const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, headers: r.headers, buf, json: type.includes('json') ? JSON.parse(buf.toString()) : null };
  };
  return { srv, call };
}
const adminLogin = async (call, email) => (await call('/api/admin/login', { method: 'POST', body: { email, password: PW } })).json.token;

test('API: 管理画面でデザインを保存 → 会員の /me と画像配信に反映される', async () => {
  const { app, tokenA, tokenB } = setup();
  app.forms.applyTemplate(ADMIN_A, T, 'basic');
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STAFF', tenantId: T, email: 's@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP002', email: 'b@x.jp', password: PW });
  const { srv, call } = await boot(app);
  try {
    const A = await adminLogin(call, 'a@x.jp'), S = await adminLogin(call, 's@x.jp'), B = await adminLogin(call, 'b@x.jp');
    assert.equal((await call('/api/admin/card', { token: S })).status, 403);
    assert.equal((await call('/api/admin/card/assets', { method: 'POST', token: S, body: { kind: 'logo', mime: 'image/png', data: b64(png()) } })).status, 403);
    // 画像アップロード (約300KBでもJSON上限に収まる)
    const up = await call('/api/admin/card/assets', { method: 'POST', token: A, body: { kind: 'logo', mime: 'image/png', data: b64(png(300_000)) } });
    assert.equal(up.status, 201); const id = up.json.id;
    assert.equal((await call('/api/admin/card/assets', { method: 'POST', token: A, body: { kind: 'logo', mime: 'image/svg+xml', data: b64(png()) } })).status, 400);
    // 保存
    const put = await call('/api/admin/card', { method: 'PUT', token: A, body: { design: { template: 'custom', textColor: '#112233', logo: { imageId: id, position: 'top-right', size: 'L' }, title: 'GOLD', qr: 'inside', page: { welcomeText: 'ようこそ' } } } });
    assert.equal(put.status, 200); assert.equal(put.json.version, 1);
    assert.equal((await call('/api/admin/card', { method: 'PUT', token: A, body: { design: { textColor: 'red' } } })).status, 400);
    assert.equal((await call('/api/admin/card', { method: 'PUT', token: B, body: { design: { logo: { imageId: id } } } })).status, 400); // 他店舗の画像は使えない
    assert.equal((await call('/api/admin/card', { token: A })).json.design.title, 'GOLD');
    assert.equal((await call(`/api/admin/card/assets/${id}`, { token: B })).status, 404); // 他店舗の管理者は取得できない
    assert.equal((await call(`/api/admin/card/assets/${id}`, { token: A })).buf.length, png(300_000).length);
    // 会員側: 登録すると /me にデザインとカード用データが入る
    const [n, p] = (await call(`/t/${tokenA}/form`)).json.fields.map((f) => f.field_id);
    await call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { confirmed: true, values: { [n]: '山田 太郎', [p]: '09011112222' } } });
    const me = (await call(`/t/${tokenA}/me`, { token: 'line:U1' })).json;
    assert.equal(me.card.title, 'GOLD'); assert.equal(me.card.logo.imageId, id); assert.equal(me.card_data.name, '山田 太郎'); assert.equal(me.card.qr, 'inside');
    // 画像配信: 正しい店舗のtokenでのみ。長期キャッシュ・nosniff・種類は画像のみ
    const img = await call(`/t/${tokenA}/asset/${id}`);
    assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.match(img.headers.get('cache-control'), /immutable/); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await call(`/t/${tokenB}/asset/${id}`)).status, 404);  // 他店舗のtokenでは見えない
    assert.equal((await call(`/t/${'0'.repeat(32)}/asset/${id}`)).status, 400);
    assert.equal((await call(`/t/${tokenA}/asset/${'0'.repeat(32)}`)).status, 404);
    // 静的ファイル
    assert.equal((await call('/cardkit.js')).status, 200);
  } finally { srv.closeAllConnections(); srv.close(); }
});
