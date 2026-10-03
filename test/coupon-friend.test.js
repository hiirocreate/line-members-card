import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';
import { setLine, publicLine, resolveLine } from '../src/settings.js';
import { AuthError } from '../src/sanitize.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', PW = 'correct-horse-battery', SECRET = 'c'.repeat(40), TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const day = (offset = 0) => new Date(Date.now() + 9 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10); // 日本時間の日付

function env({ fetchImpl } = {}) {
  const app = createApp(null, { secret: SECRET, fetchImpl });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗');
  app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id);
  const consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  const reg = (uid, c = true) => app.members.register(T, uid, { [n]: uid, [p]: '09011112222', [consent]: c }, { confirmed: true });
  return { app, reg, n, p };
}

// ---------------- クーポン ----------------
test('クーポンの作成: 入力検証・権限・店舗分離', () => {
  const { app } = env(); const c = app.coupons;
  const bad = (input, re) => assert.throws(() => c.create(ADMIN_A, T, input), (e) => e.details.some((x) => re.test(x)));
  bad({}, /クーポン名は必須/); bad({ title: 'x'.repeat(41) }, /40文字/); bad({ title: '<script>' }, /HTML/);
  bad({ title: 'a', valid_until: '2026-13-40' }, /有効期限/); bad({ title: 'a', valid_from: '2026-05-02', valid_until: '2026-05-01' }, /利用開始日以降/);
  assert.throws(() => c.create(STAFF_A, T, { title: 'a' }), /権限/); assert.throws(() => c.create(ADMIN_B, T, { title: 'a' }), /他店舗/);
  const a = c.create(ADMIN_A, T, { title: 'ドリンク1杯無料', benefit: '1杯無料', description: '会計時にご提示ください', valid_until: day(30) });
  assert.equal(c.list(ADMIN_A, T).length, 1); assert.equal(c.list(ADMIN_B, 'SHOP002').length, 0);
  assert.throws(() => c.list(STAFF_A, T), /権限/); assert.throws(() => c.update(ADMIN_B, T, a.coupon_id, { title: 'x' }), /他店舗/);
  assert.equal(c.update(ADMIN_A, T, a.coupon_id, { title: '改名' }).title, '改名');
  c.setStatus(ADMIN_A, T, a.coupon_id, 'ARCHIVED'); assert.equal(c.list(ADMIN_A, T)[0].window, 'archived');
});

test('クーポン付き配信: テキスト+カード(Flex)を送り、届いた会員にだけ付与 / 期限切れ・終了は添付不可', async () => {
  const calls = [];
  let failSecond = false;
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); if (failSecond && calls.length === 2) return new Response('{"message":"x"}', { status: 400 }); return new Response('{}', { status: 200 }); };
  const { app, reg } = env({ fetchImpl });
  app.messaging.couponUrl = (a, t, id) => `https://liff.line.me/1-abcde?t=tok&coupon=${id}`;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const m1 = reg('U1'), m2 = reg('U2', false);
  const cp = app.coupons.create(ADMIN_A, T, { title: '10%OFF', benefit: '全品10%OFF', description: '他の割引との併用不可', valid_until: day(7) });
  const r = await app.messaging.send(ADMIN_A, T, { text: '感謝祭のお知らせ', expectedCount: 1, couponId: cp.coupon_id });
  assert.deepEqual([r.sent, r.granted], [1, 1]);
  assert.equal(calls[0].messages.length, 2); assert.equal(calls[0].messages[0].text, '感謝祭のお知らせ');
  const flex = calls[0].messages[1]; assert.equal(flex.type, 'flex'); assert.match(flex.altText, /テスト店.*10%OFF/);
  const body = JSON.stringify(flex); assert.ok(body.includes('全品10%OFF') && body.includes(`coupon=${cp.coupon_id}`) && body.includes('クーポンを使う'));
  assert.equal(app.coupons.state(cp, m1.member_id), 'available'); assert.equal(app.coupons.state(cp, m2.member_id), 'not_granted'); // 同意していない会員には付与されない
  // クーポンだけの配信もできる
  await app.messaging.send(ADMIN_A, T, { text: '', expectedCount: 1, couponId: cp.coupon_id }); assert.equal(calls.at(-1).messages.length, 1);
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: '', expectedCount: 1 }), /入力/);
  // 期限切れ / 終了 / 他店舗のクーポンは添付できない
  const old = app.coupons.create(ADMIN_A, T, { title: '終了', valid_until: day(-1) });
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: 'x', expectedCount: 1, couponId: old.coupon_id }), /有効期限が過ぎ/);
  app.coupons.setStatus(ADMIN_A, T, cp.coupon_id, 'ARCHIVED');
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: 'x', expectedCount: 1, couponId: cp.coupon_id }), /終了/);
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: 'x', expectedCount: 1, couponId: 'f'.repeat(32) }), /存在しません/);
  // 一部の送信が失敗したときは、届いたまとまりの会員にだけ付与 (600人 → 500成功 / 100失敗)
  const cp2 = app.coupons.create(ADMIN_A, T, { title: '部分', valid_until: day(7) });
  for (let i = 0; i < 599; i++) { const id = `X${i}`; app.store.insert('members', { member_id: id, tenant_id: T, user_id: id, member_number: id, name: '', phone: '', email: '', registered_at: '', last_visit_at: '', visit_count: 0, status: 'ACTIVE', form_version: 1 }); app.store.insert('member_consents', { member_id: id, tenant_id: T, channel: 'LINE', granted: true, updated_at: '' }); }
  calls.length = 0; failSecond = true;
  const big = await app.messaging.send(ADMIN_A, T, { text: 'x', expectedCount: 600, couponId: cp2.coupon_id });
  assert.deepEqual([big.sent, big.failed, big.granted], [500, 100, 500]);
});

test('クーポンの使用: 会員のQR→スタッフが読み取り。1人1回・期限・店舗・退会・コードの使い回しを検証', () => {
  const { app, reg } = env(); const c = app.coupons;
  const m1 = reg('U1'), m2 = reg('U2');
  const cp = c.create(ADMIN_A, T, { title: 'A', valid_until: day(0) });          // 今日(日本時間)の終わりまで有効
  c.grant(T, cp.coupon_id, [m1.member_id], 'msg');
  assert.equal(c.grant(T, cp.coupon_id, [m1.member_id]), 0);                      // 重複付与しない
  assert.deepEqual(c.memberList(T, m1.member_id).map((x) => [x.coupon.title, x.state]), [['A', 'available']]);
  assert.deepEqual(c.memberList(T, m2.member_id), []);
  assert.throws(() => c.memberCoupon(T, m2.member_id, cp.coupon_id), /配布されていません/);
  assert.throws(() => c.issueRedeemCode(T, m2.member_id, cp.coupon_id), /配布されていません/);
  const { code } = c.issueRedeemCode(T, m1.member_id, cp.coupon_id);
  assert.match(code, /^MCP1\./);
  assert.throws(() => c.redeemByCode(STAFF_A, 'SHOP002', code), /権限|他店舗/);
  assert.throws(() => c.redeemByCode(STAFF_A, T, `${code}x`), /無効/);                // 改ざん
  assert.throws(() => c.redeemByCode(STAFF_A, T, 'MC1.abc'), /無効/);                  // 来店用QRはクーポンには使えない
  const r = c.redeemByCode(STAFF_A, T, code);
  assert.deepEqual([r.title, r.member_number], ['A', m1.member_number]);
  assert.throws(() => c.redeemByCode(STAFF_A, T, code), /使用済み|無効/);              // コードの使い回し
  assert.equal(c.memberCoupon(T, m1.member_id, cp.coupon_id).state, 'used');
  assert.throws(() => c.issueRedeemCode(T, m1.member_id, cp.coupon_id), /使用済み/);   // 1人1回
  assert.throws(() => c.redeemManual(STAFF_A, T, { couponId: cp.coupon_id, memberNumber: m1.member_number }), /使用済み/);
  // 手動(会員番号): 付与済みで有効なときだけ
  const cp2 = c.create(ADMIN_A, T, { title: 'B' }); c.grant(T, cp2.coupon_id, [m1.member_id]);
  assert.throws(() => c.redeemManual(STAFF_A, T, { couponId: cp2.coupon_id, memberNumber: '999999' }), /見つかりません/);
  assert.throws(() => c.redeemManual(STAFF_A, T, { couponId: cp2.coupon_id, memberNumber: m2.member_number }), /配布されていません/);
  assert.equal(c.redeemManual(STAFF_A, T, { couponId: cp2.coupon_id, memberNumber: m1.member_number }).title, 'B');
  assert.ok(app.store.select('audit_logs').filter((l) => l.action === 'COUPON_REDEEM').length === 2);
  // 退会した会員は使えない / 終了したクーポンは使えない
  const cp3 = c.create(ADMIN_A, T, { title: 'C' }); c.grant(T, cp3.coupon_id, [m2.member_id, m1.member_id]);
  const k = c.issueRedeemCode(T, m2.member_id, cp3.coupon_id).code;
  app.members.withdrawByUser(T, 'U2'); assert.throws(() => c.redeemByCode(STAFF_A, T, k), /退会済み/);
  const k1 = c.issueRedeemCode(T, m1.member_id, cp3.coupon_id).code;
  c.setStatus(ADMIN_A, T, cp3.coupon_id, 'ARCHIVED'); assert.throws(() => c.redeemByCode(STAFF_A, T, k1), /終了/);
});

test('クーポンの期限: 日本時間の日付で、その日の終わりまで有効', () => {
  const { app, reg } = env(); const c = app.coupons; const m = reg('U1');
  const cp = c.create(ADMIN_A, T, { title: 'D', valid_from: '2030-01-10', valid_until: '2030-01-20' }); c.grant(T, cp.coupon_id, [m.member_id]);
  const at = (iso) => Date.parse(iso);
  assert.equal(c.state(cp, m.member_id, at('2030-01-09T14:59:59Z')), 'not_started');   // 日本時間 1/9 23:59
  assert.equal(c.state(cp, m.member_id, at('2030-01-09T15:00:00Z')), 'available');     // 日本時間 1/10 00:00
  assert.equal(c.state(cp, m.member_id, at('2030-01-20T14:59:59Z')), 'available');     // 日本時間 1/20 23:59:59
  assert.equal(c.state(cp, m.member_id, at('2030-01-20T15:00:00Z')), 'expired');       // 日本時間 1/21 00:00
});

// ---------------- 友だち追加の確認 ----------------
function friendApp({ profile = () => 200, botBasic = '@shop123' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    url = String(url); calls.push(url);
    if (url.includes('/v2/bot/profile/')) { const s = profile(url.split('/').pop()); return new Response(s === 200 ? JSON.stringify({ displayName: 'x' }) : '{}', { status: s }); }
    if (url.endsWith('/v2/bot/info')) return new Response(JSON.stringify({ displayName: '店', basicId: botBasic, userId: 'Ubot' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const e = env({ fetchImpl });
  createAdmin(e.app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  return { ...e, calls };
}
async function boot(app) {
  const verifyLine = async (t) => { if (!t?.startsWith('line:')) throw new AuthError('x'); return t.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  return { srv, call };
}

test('友だち追加が会員登録の条件: 友だちでないと登録できず、友だち追加後は登録できる', async () => {
  const friends = new Set(); let status = null;
  const { app, calls } = friendApp({ profile: (uid) => status ?? (friends.has(uid) ? 200 : 404) });
  const tok = app.forms.issueRegistrationUrl(ADMIN_A, T);
  const { srv, call } = await boot(app);
  try {
    const [n, p] = (await call(`/t/${tok}/form`)).json.fields.map((f) => f.field_id);
    const reg = (uid) => call(`/t/${tok}/register`, { method: 'POST', token: `line:${uid}`, body: { confirmed: true, values: { [n]: uid, [p]: '09011112222', [app.forms.fields(T).find((f) => f.consent_target).field_id]: false } } });
    // トークン未設定の間は確認しない(既定) → 登録できる
    assert.deepEqual((await call(`/t/${tok}/friend`, { token: 'line:U0' })).json, { required: false, friend: true });
    assert.equal((await reg('U0')).status, 201);
    // トークンを設定すると、既定で有効になる
    setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN });
    assert.equal(publicLine(app.store, app.vault, T, {}).requireFriend, true);
    const st = (await call(`/t/${tok}/friend`, { token: 'line:U1' })).json;
    assert.deepEqual([st.required, st.friend, st.addUrl], [true, false, 'https://line.me/R/ti/p/%40shop123']); // 友だち追加のURLは、公式アカウントのベーシックIDから作る
    assert.equal((await call(`/t/${tok}/friend`)).status, 401);
    const blocked = await reg('U1');
    assert.equal(blocked.status, 400); assert.equal(blocked.json.code, 'friend_required'); assert.match(blocked.json.error, /友だち追加/); assert.match(blocked.json.addUrl, /line\.me\/R\/ti\/p/);
    assert.equal(app.store.find('members', (m) => m.user_id === 'U1'), null);                 // 登録されていない
    friends.add('U1');                                                                         // 友だち追加した
    assert.equal((await call(`/t/${tok}/friend`, { token: 'line:U1' })).json.friend, true);
    assert.equal((await reg('U1')).status, 201);
    assert.ok(calls.some((u) => u.endsWith('/v2/bot/profile/U1')));
    // 退会→再登録でも、友だちであることを確認する
    app.members.withdrawByUser(T, 'U1'); friends.delete('U1');
    assert.equal((await reg('U1')).json.code, 'friend_required');
    // 店舗が設定した友だち追加URLを優先する
    setLine(app.store, app.vault, ADMIN_A, T, { friendUrl: 'https://lin.ee/abc123' });
    assert.equal((await call(`/t/${tok}/friend`, { token: 'line:U1' })).json.addUrl, 'https://lin.ee/abc123');
    // LINE側の確認に失敗したとき(障害・トークン不正)は、登録させない(確認できないので)
    status = 500; const e500 = await reg('U9'); assert.equal(e500.status, 400); assert.match(e500.json.error, /確認ができませんでした/); assert.equal(e500.json.code, undefined);
    status = 401; assert.match((await reg('U9')).json.error, /トークンを確認/);
    status = null;
    // 必須にしない設定: 友だちでなくても登録できる
    setLine(app.store, app.vault, ADMIN_A, T, { requireFriend: false });
    assert.equal((await call(`/t/${tok}/friend`, { token: 'line:U7' })).json.required, false);
    assert.equal((await reg('U7')).status, 201);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('友だち確認の設定: トークンが無いと有効にできない / URLはLINEのドメインのみ / 設定値の取得', () => {
  const { app } = env();
  assert.equal(resolveLine(app.store, app.vault, T, {}).requireFriend, false);                // トークンなし → 既定は無効
  assert.throws(() => setLine(app.store, app.vault, ADMIN_A, T, { requireFriend: true }), /トークンが必要/);
  assert.throws(() => setLine(app.store, app.vault, ADMIN_A, T, { requireFriend: 'yes' }), /true\/false/);
  assert.throws(() => setLine(app.store, app.vault, ADMIN_A, T, { friendUrl: 'https://evil.example/' }), /LINEのURL/);
  assert.throws(() => setLine(app.store, app.vault, STAFF_A, T, { requireFriend: false }), /権限/);
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: true, friendUrl: 'https://lin.ee/xyz' });
  const pub = publicLine(app.store, app.vault, T, {});
  assert.deepEqual([pub.requireFriend, pub.requireFriendExplicit, pub.friendUrl], [true, true, 'https://lin.ee/xyz']);
  setLine(app.store, app.vault, ADMIN_A, T, { requireFriend: false });
  assert.equal(publicLine(app.store, app.vault, T, {}).requireFriend, false);
  // 明示的に有効でも、トークンを消した後は「確認できない」状態になる(設定画面で気づける)
  setLine(app.store, app.vault, ADMIN_A, T, { requireFriend: true });
  assert.throws(() => setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: '', requireFriend: true }), /トークンが必要/);
});

test('API: 会員のクーポン画面(一覧・詳細・QR) と 管理画面のクーポン操作', async () => {
  const { app, reg } = env();
  app.messaging.couponUrl = (a, t, id) => `https://liff.line.me/1-abcde?t=tok&coupon=${id}`;
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STAFF', tenantId: T, email: 's@x.jp', password: PW });
  const tok = app.forms.issueRegistrationUrl(ADMIN_A, T);
  const { srv, call } = await boot(app);
  try {
    const m = reg('U1'); reg('U2');
    const A = (await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW } })).json.token;
    const S = (await call('/api/admin/login', { method: 'POST', body: { email: 's@x.jp', password: PW } })).json.token;
    assert.equal((await call('/api/admin/coupons', { method: 'POST', token: S, body: { title: 'x' } })).status, 403);
    const made = await call('/api/admin/coupons', { method: 'POST', token: A, body: { title: '来店感謝', benefit: 'コーヒー無料', valid_until: day(10) } });
    assert.equal(made.status, 201); const id = made.json.coupon_id;
    assert.equal((await call('/api/admin/coupons', { method: 'POST', token: A, body: { title: '' } })).status, 400);
    assert.equal((await call(`/api/admin/coupons/${id}`, { method: 'PUT', token: A, body: { description: '会計時に提示' } })).json.description, '会計時に提示');
    app.coupons.grant(T, id, [m.member_id]);
    // 会員側
    const U1 = (p, o = {}) => call(`/t/${tok}${p}`, { token: 'line:U1', ...o });
    assert.deepEqual((await U1('/coupons')).json.coupons.map((x) => [x.coupon.title, x.state]), [['来店感謝', 'available']]);
    assert.equal((await U1(`/coupon/${id}`)).json.coupon.benefit, 'コーヒー無料');
    assert.equal((await call(`/t/${tok}/coupon/${id}`, { token: 'line:U2' })).status, 400);       // 配布されていない会員
    assert.equal((await call(`/t/${tok}/coupons`)).status, 401);
    const code = (await U1(`/coupon/${id}/code`, { method: 'POST' })).json.code;
    // スタッフが読み取って使用済みに
    const used = await call('/api/admin/coupons/redeem', { method: 'POST', token: S, body: { code } });
    assert.equal(used.status, 200); assert.equal(used.json.title, '来店感謝');
    assert.equal((await call('/api/admin/coupons/redeem', { method: 'POST', token: S, body: { code } })).status, 400);
    assert.equal((await U1(`/coupon/${id}`)).json.state, 'used');
    const list = (await call('/api/admin/coupons', { token: A })).json.coupons[0]; assert.deepEqual([list.granted, list.redeemed], [1, 1]);
    assert.equal((await call(`/api/admin/coupons/${id}/archive`, { method: 'POST', token: A })).status, 200);
  } finally { srv.closeAllConnections(); srv.close(); }
});
