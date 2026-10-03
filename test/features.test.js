import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdmin, login, verifySession, setup2fa, enable2fa, disable2fa, resetTwoFactor, issueResetToken, consumeResetToken, changePassword, LoginLimiter } from '../src/auth.js';
import { setLine, publicLine, resolveLine, testMessaging } from '../src/settings.js';
import { assertLineUrl } from '../src/line.js';
import { totp } from '../src/totp.js';

const T = 'SHOP001', SECRET = 'y'.repeat(40), PW = 'correct-horse-battery';

function shop(opts = {}) {
  const app = createApp(null, { secret: SECRET, ...opts });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗');
  app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const name = app.forms.fields(T)[0].field_id, phone = app.forms.fields(T)[1].field_id;
  const line = app.forms.addCustomField(ADMIN_A, T, { field_name: 'LINE配信を受け取る', field_type: 'CHECKBOX', consent_target: 'LINE' }).field_id;
  const reg = (uid, consent = false, n = '山田') => app.members.register(T, uid, { [name]: n, [phone]: '09011112222', [line]: consent }, { confirmed: true });
  return { app, name, phone, line, reg };
}

// ---------- 退会 ----------
test('退会: 削除せずWITHDRAWNに。データ保持・同意取消・検索除外・再入会', () => {
  const { app, name, reg, line } = shop();
  const m = reg('U1', true); reg('U2');
  assert.equal(app.members.consents(T, m.member_id).LINE, true);
  app.members.withdrawByUser(T, 'U1', '引っ越し');
  const w = app.store.find('members', (x) => x.member_id === m.member_id);
  assert.equal(w.status, 'WITHDRAWN'); assert.equal(w.withdraw_reason, '引っ越し'); assert.ok(w.withdrawn_at);
  assert.equal(w.phone, '09011112222'); assert.equal(w.name, '山田'); // データは残る
  assert.equal(app.members.consents(T, m.member_id).LINE, false);
  assert.deepEqual(app.members.search(STAFF_A, T).members.map((x) => x.user_id), ['U2']);
  assert.deepEqual(app.members.search(STAFF_A, T, { status: 'WITHDRAWN' }).members.map((x) => x.user_id), ['U1']);
  assert.equal(app.members.search(STAFF_A, T, { status: 'ALL' }).total, 2);
  assert.throws(() => app.members.updateByUser(T, 'U1', { [name]: 'x' }), /存在しません/);
  assert.throws(() => app.members.recordVisit(STAFF_A, T, m.member_id), /退会済み/);
  assert.throws(() => app.members.withdrawByUser(T, 'U1'), /既に退会/);
  assert.ok(app.store.select('audit_logs').some((l) => l.action === 'MEMBER_WITHDRAW'));
  // 再入会: 同じ会員番号で有効化
  const again = reg('U1', false, '山田 改');
  assert.equal(again.member_id, m.member_id); assert.equal(again.member_number, m.member_number); assert.equal(again.status, 'ACTIVE'); assert.equal(again.name, '山田 改');
  assert.equal(app.store.select('members').length, 2);
  assert.equal(app.members.consents(T, m.member_id).LINE, false); // 再同意が必要
  assert.throws(() => reg('U1'), /既に登録/);
});

test('管理者の退会/復帰は MEMBER_STATUS 権限(スタッフ不可)・他店舗不可', () => {
  const { app, reg } = shop();
  const m = reg('U1');
  assert.throws(() => app.members.withdrawByAdmin(STAFF_A, T, m.member_id), /権限/);
  assert.throws(() => app.members.withdrawByAdmin(ADMIN_B, T, m.member_id), /他店舗/);
  app.members.withdrawByAdmin(ADMIN_A, T, m.member_id, '依頼');
  assert.throws(() => app.members.restore(STAFF_A, T, m.member_id), /権限/);
  app.members.restore(ADMIN_A, T, m.member_id);
  assert.equal(app.store.find('members', (x) => x.member_id === m.member_id).status, 'ACTIVE');
  assert.throws(() => app.members.restore(ADMIN_A, T, m.member_id), /退会済みの会員ではありません/);
});

// ---------- 来店QR ----------
test('来店QR: 署名・期限・使い捨て・他店舗拒否・連続記録の抑止', () => {
  const { app, reg } = shop();
  const m = reg('U1');
  const { code } = app.members.issueVisitCode(T, 'U1');
  assert.throws(() => app.members.scanVisit(STAFF_A, T, code.slice(0, -3) + 'abc'), /無効/); // 改ざん
  assert.throws(() => app.members.scanVisit(ADMIN_B, 'SHOP002', code), /他店舗/);
  const r = app.members.scanVisit(STAFF_A, T, code);
  assert.equal(r.visit_count, 1);
  assert.equal(app.members.visits(STAFF_A, T)[0].method, 'QR');
  assert.throws(() => app.members.scanVisit(STAFF_A, T, code), /使用済み/);
  const second = app.members.issueVisitCode(T, 'U1').code;
  assert.throws(() => app.members.scanVisit(STAFF_A, T, second), /30分以内/);
  assert.equal(app.members.scanVisit(STAFF_A, T, app.members.issueVisitCode(T, 'U1').code, { cooldownMin: 0 }).visit_count, 2);
  assert.throws(() => app.members.scanVisit(STAFF_A, T, app.members.issueVisitCode(T, 'U1', -1).code, { cooldownMin: 0 }), /期限切れ/);
  app.members.withdrawByUser(T, 'U1');
  assert.throws(() => app.members.issueVisitCode(T, 'U1'), /存在しません/);
  assert.equal(app.store.find('members', (x) => x.member_id === m.member_id).visit_count, 2);
});

// ---------- 二段階認証 / パスワード ----------
test('二段階認証: 設定→ログインに必須→回復コードは1回限り→無効化', () => {
  const { app } = shop();
  const { vault, store } = app;
  createAdmin(store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  const L = (code) => login(store, { email: 'a@x.jp', password: PW, code, secret: SECRET, vault, limiter: new LoginLimiter() });
  const a = verifySession(store, L().token, SECRET);
  assert.throws(() => setup2fa(store, vault, a, { password: 'wrong' }), /パスワード/);
  const { secret, uri } = setup2fa(store, vault, a, { password: PW });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(!JSON.stringify(store.select('admins')).includes(secret), '秘密は暗号化して保存'); // 平文で保存されない
  assert.throws(() => enable2fa(store, vault, a, { code: '000000' }), /認証コード/);
  const { recoveryCodes } = enable2fa(store, vault, a, { code: totp(secret) });
  assert.equal(recoveryCodes.length, 8);
  const need = L(); assert.equal(need.requires2fa, true); assert.deepEqual(need.methods, ['totp']); assert.equal(need.token, undefined);
  assert.throws(() => L('123456'), /認証コード/);
  assert.ok(L(totp(secret)).token);
  assert.ok(L(recoveryCodes[0]).token);
  assert.throws(() => L(recoveryCodes[0]), /認証コード/); // 使用済み
  const a2 = verifySession(store, L(totp(secret)).token, SECRET);
  assert.throws(() => disable2fa(store, vault, a2, { password: PW, code: '000000' }), /認証コード/);
  disable2fa(store, vault, a2, { password: PW, code: totp(secret) });
  assert.ok(L().token);
});

test('2FAのリセット権限: 運営=全員 / 店舗管理者=自店舗スタッフのみ', () => {
  const { app } = shop(); const { vault, store } = app;
  const mk = (role, tenantId, email) => createAdmin(store, OP, { role, tenantId, email, password: PW });
  const adminA = mk('STORE_ADMIN', T, 'a@x.jp'), staffA = mk('STAFF', T, 'sa@x.jp'), adminB = mk('STORE_ADMIN', 'SHOP002', 'b@x.jp');
  const who = (e) => verifySession(store, login(store, { email: e, password: PW, secret: SECRET, vault }).token, SECRET);
  const act = who('a@x.jp');
  assert.throws(() => resetTwoFactor(store, act, adminB.admin_id), /操作できません/);
  assert.throws(() => resetTwoFactor(store, who('sa@x.jp'), adminA.admin_id), /操作できません/);
  resetTwoFactor(store, act, staffA.admin_id);
  resetTwoFactor(store, { id: 'op', role: 'OPERATOR' }, adminB.admin_id);
});

test('パスワード再設定リンク: 1回限り・期限・旧セッション失効 / 変更でも他端末失効', () => {
  const { app } = shop(); const { vault, store } = app;
  const staff = createAdmin(store, OP, { role: 'STAFF', tenantId: T, email: 's@x.jp', password: PW });
  createAdmin(store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP002', email: 'b@x.jp', password: PW });
  const old = login(store, { email: 's@x.jp', password: PW, secret: SECRET, vault }).token;
  const adminB = verifySession(store, login(store, { email: 'b@x.jp', password: PW, secret: SECRET, vault }).token, SECRET);
  assert.throws(() => issueResetToken(store, adminB, staff.admin_id), /操作できません/);
  const { token } = issueResetToken(store, { id: 'op', role: 'OPERATOR' }, staff.admin_id);
  assert.ok(!JSON.stringify(store.select('password_resets')).includes(token), 'tokenはハッシュで保存');
  assert.throws(() => consumeResetToken(store, { token, password: 'short' }), /10文字/);
  consumeResetToken(store, { token, password: 'brand-new-password' });
  assert.equal(verifySession(store, old, SECRET), null); // 旧セッションは無効
  assert.throws(() => login(store, { email: 's@x.jp', password: PW, secret: SECRET, vault }), /違います/);
  assert.ok(login(store, { email: 's@x.jp', password: 'brand-new-password', secret: SECRET, vault }).token);
  assert.throws(() => consumeResetToken(store, { token, password: 'another-password-1' }), /無効/); // 使用済み
  const t2 = issueResetToken(store, { id: 'op', role: 'OPERATOR' }, staff.admin_id).token;
  store.update('password_resets', () => true, { expires_at: Date.now() - 1 });
  assert.throws(() => consumeResetToken(store, { token: t2, password: 'another-password-1' }), /期限切れ/);
  // 自分での変更: 現在のパスワード必須、他端末のセッションは失効、新しいセッションは有効
  const cur = verifySession(store, login(store, { email: 's@x.jp', password: 'brand-new-password', secret: SECRET, vault }).token, SECRET);
  assert.throws(() => changePassword(store, cur, { current: 'bad', next: 'yet-another-pass', secret: SECRET }), /現在のパスワード/);
  const fresh = changePassword(store, cur, { current: 'brand-new-password', next: 'yet-another-pass', secret: SECRET });
  assert.ok(verifySession(store, fresh, SECRET));
});

// ---------- LINE設定 ----------
test('LINE設定: 形式検証・ショップカードURLはLINEドメインのみ・トークンは暗号化', async () => {
  const { app } = shop(); const { store, vault } = app;
  assert.throws(() => assertLineUrl('https://evil.example/card'), /LINEのURL/);
  assert.throws(() => assertLineUrl('http://line.me/x'), /LINEのURL/);
  assert.throws(() => assertLineUrl('https://line.me.evil.example/x'), /LINEのURL/);
  assert.throws(() => assertLineUrl('javascript:alert(1)'), /形式|LINEのURL/);
  assert.throws(() => assertLineUrl('https://user:pw@line.me/x'), /LINEのURL/);
  assert.ok(assertLineUrl('https://lin.ee/abc123') && assertLineUrl('https://page.line.me/xyz'));
  assert.throws(() => setLine(store, vault, STAFF_A, T, { liffId: '1234567890-AbcdEfgh' }), /権限/);
  assert.throws(() => setLine(store, vault, ADMIN_B, T, { liffId: '1234567890-AbcdEfgh' }), /他店舗/);
  assert.throws(() => setLine(store, vault, ADMIN_A, T, { liffId: 'bad' }), /liffId/);
  assert.throws(() => setLine(store, vault, ADMIN_A, T, { shopcardUrl: 'https://evil.example/' }), /LINEのURL/);
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  setLine(store, vault, ADMIN_A, T, { liffId: '1234567890-AbcdEfgh', loginChannelId: '1234567890', messagingToken: TOKEN, shopcardUrl: 'https://lin.ee/abc123' });
  assert.ok(!JSON.stringify(store.select('tenants')).includes(TOKEN), 'トークンは平文で保存されない');
  assert.ok(!JSON.stringify(store.select('audit_logs')).includes(TOKEN), '監査ログにも秘密を残さない');
  const pub = publicLine(store, vault, T, {});
  assert.deepEqual([pub.liffId, pub.loginChannelId, pub.hasMessagingToken, pub.shopcardUrl], ['1234567890-AbcdEfgh', '1234567890', true, 'https://lin.ee/abc123']);
  assert.ok(!('messagingToken' in pub));
  assert.equal(resolveLine(store, vault, T).messagingToken, TOKEN);
  // 既定値へのフォールバック
  assert.equal(resolveLine(store, vault, 'SHOP002', { liffId: '999-ZZZZ', loginChannelId: '777' }).liffId, '999-ZZZZ');
  let seen;
  const info = await testMessaging(store, vault, ADMIN_A, T, async (url, init) => { seen = [url, init.headers.authorization]; return new Response(JSON.stringify({ displayName: '店A', basicId: '@abc', userId: 'Ubot' }), { status: 200 }); });
  assert.equal(info.displayName, '店A'); assert.deepEqual(seen, ['https://api.line.me/v2/bot/info', `Bearer ${TOKEN}`]);
  setLine(store, vault, ADMIN_A, T, { shopcardUrl: '' }); // 空で解除
  assert.equal(publicLine(store, vault, T, {}).shopcardUrl, '');
});

// ---------- 配信 ----------
test('メッセージ配信: 同意した有効会員のみ / 500人ずつ / 人数確認 / 部分失敗の記録', async () => {
  const calls = [];
  let failNext = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, key: init.headers['x-line-retry-key'], auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (failNext && calls.length === 2) return new Response(JSON.stringify({ message: 'invalid user' }), { status: 400 });
    return new Response('{}', { status: 200 });
  };
  const { app, reg } = shop({ fetchImpl });
  const { store, vault } = app;
  reg('U1', true); reg('U2', false); reg('U3', true);
  app.members.withdrawByUser(T, 'U3'); // 退会者は除外
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: 'hi', expectedCount: 1 }), /LINE設定/);
  setLine(store, vault, ADMIN_A, T, { messagingToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' });
  assert.deepEqual(app.messaging.preview(ADMIN_A, T), { matched: 2, audience: 1 });
  await assert.rejects(app.messaging.send(STAFF_A, T, { text: 'hi', expectedCount: 1 }), /権限/);
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: '  ', expectedCount: 1 }), /入力/);
  await assert.rejects(app.messaging.send(ADMIN_A, T, { text: 'hi', expectedCount: 5 }), /対象が変わりました/);
  const r = await app.messaging.send(ADMIN_A, T, { text: 'セールのお知らせ', expectedCount: 1 });
  assert.deepEqual([r.audience, r.sent, r.failed, r.status], [1, 1, 0, 'SENT']);
  assert.deepEqual(calls[0].body.to, ['U1']);
  assert.match(calls[0].url, /\/v2\/bot\/message\/multicast$/);
  assert.ok(calls[0].key && calls[0].auth.startsWith('Bearer abcdefgh'));
  assert.deepEqual(calls[0].body.messages, [{ type: 'text', text: 'セールのお知らせ' }]);
  // 1200人 → 500/500/200 に分割、2通目だけ失敗
  for (let i = 0; i < 1199; i++) {
    const id = `X${i}`;
    store.insert('members', { member_id: id, tenant_id: T, user_id: id, member_number: id, name: '', phone: '', email: '', registered_at: '', last_visit_at: '', visit_count: 0, status: 'ACTIVE', form_version: 1 });
    store.insert('member_consents', { member_id: id, tenant_id: T, channel: 'LINE', granted: true, updated_at: '' });
  }
  calls.length = 0; failNext = true;
  const big = await app.messaging.send(ADMIN_A, T, { text: 'x', expectedCount: 1200 });
  assert.deepEqual(calls.map((c) => c.body.to.length), [500, 500, 200]);
  assert.equal(new Set(calls.map((c) => c.key)).size, 3);
  assert.deepEqual([big.sent, big.failed, big.status], [700, 500, 'PARTIAL']);
  assert.match(big.errors[0], /400/);
  assert.equal(app.messaging.history(ADMIN_A, T)[0].status, 'PARTIAL');
  // 他店舗のスタッフ/管理者は履歴も見られない
  assert.throws(() => app.messaging.history(ADMIN_B, T), /他店舗/);
});

test('配信セグメント: 検索条件(OR)で絞り込める', async () => {
  const sent = [];
  const { app, reg, name } = shop({ fetchImpl: async (u, i) => { sent.push(JSON.parse(i.body).to); return new Response('{}', { status: 200 }); } });
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' });
  reg('U1', true, '山田'); reg('U2', true, '佐藤'); reg('U3', true, '鈴木');
  const where = { logic: 'OR', conditions: [{ field: name, op: 'contains', value: '山' }, { field: name, op: 'contains', value: '鈴' }] };
  assert.equal(app.messaging.preview(ADMIN_A, T, where).audience, 2);
  await app.messaging.send(ADMIN_A, T, { text: 'x', where, expectedCount: 2 });
  assert.deepEqual(sent[0].sort(), ['U1', 'U3']);
});

// ---------- vault ----------
test('vault: 暗号化の往復・改ざん検知・用途別署名', async () => {
  const { createVault } = await import('../src/vault.js');
  const v = createVault(SECRET), v2 = createVault('z'.repeat(40));
  const c = v.encrypt('秘密');
  assert.equal(v.decrypt(c), '秘密'); assert.notEqual(c, v.encrypt('秘密'));
  assert.throws(() => v2.decrypt(c)); assert.throws(() => v.decrypt(c.slice(0, -2) + 'AA'));
  const t = v.sign('visit', { a: 1 });
  assert.deepEqual(v.verify('visit', t), { a: 1 });
  assert.equal(v.verify('other', t), null); assert.equal(v2.verify('visit', t), null);
});
