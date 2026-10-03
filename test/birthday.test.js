import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { setLine } from '../src/settings.js';
import { daysUntilBirthday, addDaysJst } from '../src/dates.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', SECRET = 'c'.repeat(40), TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const bornIn = (offset, year = 1990) => `${year}${addDaysJst(Date.now(), offset).slice(4)}`; // 今日から offset 日後が誕生日

function env() {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const app = createApp(null, { secret: SECRET, fetchImpl });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗');
  app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id);
  const consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  const bd = app.forms.addFromMaster(ADMIN_A, T, 'birthday').field_id;
  app.messaging.couponUrl = app.birthday.couponUrl = (a, t, id) => `https://liff.line.me/1-abcde?t=tok&coupon=${id}`;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (uid, birthday, c = true) => app.members.register(T, uid, { [n]: `名前${uid}`, [p]: '09011112222', [consent]: c, ...(birthday ? { [bd]: birthday } : {}) }, { confirmed: true });
  return { app, reg, calls };
}

test('daysUntilBirthday: 当日・年またぎ・うるう日', () => {
  const at = (s) => Date.parse(`${s}T12:00:00+09:00`);
  assert.deepEqual(daysUntilBirthday('1990-05-10', at('2026-05-10')), { days: 0, year: 2026 });
  assert.deepEqual(daysUntilBirthday('1990-05-10', at('2026-05-11')), { days: 364, year: 2027 });
  assert.deepEqual(daysUntilBirthday('1990-01-03', at('2026-12-30')), { days: 4, year: 2027 });
  assert.deepEqual(daysUntilBirthday('2000-02-29', at('2026-02-25')), { days: 3, year: 2026 }); // 非うるう年は2/28扱い
  assert.equal(daysUntilBirthday('', at('2026-01-01')), null); assert.equal(daysUntilBirthday('1990-02-31', at('2026-01-01')), null);
});

test('誕生日の絞り込み条件 days_until_birthday (手動セグメント配信にも使える)', () => {
  const { app, reg } = env();
  reg('U1', bornIn(3)); reg('U2', bornIn(20)); reg('U3', null);
  const hit = (v) => app.members.search(ADMIN_A, T, { where: { logic: 'AND', conditions: [{ field: 'days_until_birthday', op: 'lte', value: v }] } }).members.map((m) => m.user_id).sort();
  assert.deepEqual(hit(7), ['U1']); assert.deepEqual(hit(30), ['U1', 'U2']);
  assert.equal(app.members.search(ADMIN_A, T, { sort: { field: 'days_until_birthday', dir: 'asc' } }).members[0].user_id, 'U1');
});

test('誕生日配信: 設定の検証・権限・店舗分離', () => {
  const { app } = env(); const b = app.birthday;
  assert.throws(() => b.save(ADMIN_A, T, { enabled: true, days_before: 99, message_text: 'x' }), (e) => e.details.some((x) => /0〜60/.test(x)));
  assert.throws(() => b.save(ADMIN_A, T, { enabled: true, days_before: 7, message_text: '' }), (e) => e.details.some((x) => /どちらか/.test(x)));
  assert.throws(() => b.save(ADMIN_A, T, { enabled: false, days_before: 7, message_text: 'x', coupon_id: 'f'.repeat(32) }), (e) => e.details.some((x) => /存在しません/.test(x)));
  assert.throws(() => b.save(STAFF_A, T, { enabled: false, days_before: 7, message_text: 'x' }), /権限/); assert.throws(() => b.get(ADMIN_B, T), /他店舗/);
  assert.equal(b.save(ADMIN_A, T, { enabled: true, days_before: 5, message_text: 'おめでとう' }).days_before, 5);
});

test('誕生日配信: 対象は期間内・同意済み・今年未送信。クーポンは届いた会員にだけ付与し、2回目は送らない', async () => {
  const { app, reg, calls } = env(); const b = app.birthday;
  const m1 = reg('U1', bornIn(3)), m2 = reg('U2', bornIn(3), false), m3 = reg('U3', bornIn(40)); reg('U4', null);
  const cp = app.coupons.create(ADMIN_A, T, { title: '誕生日10%OFF', benefit: '10%OFF', valid_days: 30 });
  b.save(ADMIN_A, T, { enabled: true, days_before: 7, message_text: '{名前}さん、おめでとう🎂', coupon_id: cp.coupon_id });
  assert.deepEqual(b.preview(ADMIN_A, T), { matched: 2, willSend: 1, skipped: { notConsented: 1, alreadySent: 0 } });
  const r = await b.run(ADMIN_A, T);
  assert.deepEqual([r.sent, r.failed, r.granted], [1, 0, 1]);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.to, 'U1'); assert.equal(calls[0].body.messages[0].text, '名前U1さん、おめでとう🎂');
  const flex = JSON.stringify(calls[0].body.messages[1]); assert.ok(flex.includes('受け取りから30日間'));
  assert.equal(app.coupons.state(cp, m1.member_id), 'available'); assert.equal(app.coupons.state(cp, m2.member_id), 'not_granted'); assert.equal(app.coupons.state(cp, m3.member_id), 'not_granted');
  const g = app.store.select('coupon_grants')[0]; assert.equal(g.expires_at, addDaysJst(Date.now(), 30));
  // 同じ年に2回目は送らない
  const r2 = await b.run(ADMIN_A, T); assert.equal(r2.sent, 0); assert.equal(r2.skipped.alreadySent, 1); assert.equal(calls.length, 1);
  // 自動実行(全店舗)も同様。無効化した店舗は動かない
  assert.equal((await b.runAll())[0].sent, 0);
  b.save(ADMIN_A, T, { enabled: false, days_before: 7, message_text: 'x' }); assert.deepEqual(await b.runAll(), []);
  assert.ok(app.store.select('audit_logs').some((a) => a.action === 'BIRTHDAY_RUN'));
});

test('誕生日配信: 送信失敗した会員は「送信済み」にならず、次回再試行される / 上限は持ち越し', async () => {
  let fail = true;
  const app = createApp(null, { secret: SECRET, fetchImpl: async () => (fail ? new Response('{}', { status: 400 }) : new Response('{}', { status: 200 })) });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id), consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id, bd = app.forms.addFromMaster(ADMIN_A, T, 'birthday').field_id;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  app.members.register(T, 'U1', { [n]: 'a', [p]: '09011112222', [consent]: true, [bd]: bornIn(1) }, { confirmed: true });
  app.birthday.save(ADMIN_A, T, { enabled: true, days_before: 3, message_text: 'おめでとう' });
  const r = await app.birthday.run(ADMIN_A, T); assert.deepEqual([r.sent, r.failed], [0, 1]); assert.equal(app.store.select('birthday_sends').length, 0);
  fail = false; assert.equal((await app.birthday.run(ADMIN_A, T)).sent, 1);
  // 生年月日の項目が無い店舗はエラーとして記録される
  app.forms.createTenant(OP, 'SHOP002', '別'); setLine(app.store, app.vault, { ...ADMIN_B }, 'SHOP002', { messagingToken: TOKEN, requireFriend: false });
  app.birthday.save(ADMIN_B, 'SHOP002', { enabled: true, days_before: 3, message_text: 'x' });
  await assert.rejects(app.birthday.run(ADMIN_B, 'SHOP002'), /生年月日/);
  assert.match(app.birthday.get(ADMIN_B, 'SHOP002').last_result.error, /生年月日/);
});

test('付与からN日のクーポン: 有効期限は早い方・使用後や期限切れ後は再付与できる。期限なしは1人1回のまま', () => {
  const { app, reg } = env(); const c = app.coupons;
  const m = reg('U1', bornIn(1));
  const plain = c.create(ADMIN_A, T, { title: '通常' }), lim = c.create(ADMIN_A, T, { title: '期間限定', valid_days: 10, valid_until: addDaysJst(Date.now(), 5) });
  assert.equal(c.grant(T, plain.coupon_id, [m.member_id]), 1); assert.equal(c.grant(T, plain.coupon_id, [m.member_id]), 0);
  assert.equal(c.grant(T, lim.coupon_id, [m.member_id]), 1); assert.equal(c.grant(T, lim.coupon_id, [m.member_id]), 0); // 未使用・有効中は重複しない
  assert.equal(c.memberCoupon(T, m.member_id, lim.coupon_id).coupon.valid_until, addDaysJst(Date.now(), 5)); // 早い方
  const staff = { ...ADMIN_A };
  const code = c.issueRedeemCode(T, m.member_id, lim.coupon_id).code;
  c.redeemByCode(staff, T, code); assert.equal(c.state(lim, m.member_id), 'used');
  assert.equal(c.grant(T, lim.coupon_id, [m.member_id]), 1); assert.equal(c.state(lim, m.member_id), 'available'); // 使用済みなら新しい分を付与
  // 付与ごとに期限切れになる
  const row = app.store.select('coupon_grants').filter((g) => g.coupon_id === lim.coupon_id).at(-1);
  app.store.update('coupon_grants', (g) => g.grant_id === row.grant_id, { expires_at: addDaysJst(Date.now(), -1) });
  assert.equal(c.state(lim, m.member_id), 'expired');
  assert.throws(() => c.create(ADMIN_A, T, { title: 'x', valid_days: 400 }), (e) => e.details.some((x) => /1〜365/.test(x)));
});

test('cron エンドポイント: CRON_SECRET が必要', async () => {
  const { app } = env();
  const srv = createServer(app, { cronSecret: 'secret-1', sessionSecret: SECRET }).listen(0);
  const port = srv.address().port, post = (h) => fetch(`http://127.0.0.1:${port}/api/cron/birthday`, { method: 'POST', headers: h });
  assert.equal((await post({})).status, 401); assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
  const ok = await post({ authorization: 'Bearer secret-1' }); assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).results, []);
  srv.close();
  const none = createServer(app, { cronSecret: '', sessionSecret: SECRET }).listen(0);
  assert.equal((await fetch(`http://127.0.0.1:${none.address().port}/api/cron/birthday`, { method: 'POST', headers: { authorization: 'Bearer ' } })).status, 401); none.close();
});

test('配信ごとのクーポン有効日数: 誕生日配信・通常配信で上書きできる', async () => {
  const { app, reg, calls } = env();
  const m = reg('U1', bornIn(2));
  const cp = app.coupons.create(ADMIN_A, T, { title: 'c', valid_days: 90 });
  assert.throws(() => app.birthday.save(ADMIN_A, T, { enabled: false, days_before: 7, message_text: 'x', coupon_id: cp.coupon_id, coupon_days: 999 }), (e) => e.details.some((x) => /1〜365/.test(x)));
  app.birthday.save(ADMIN_A, T, { enabled: true, days_before: 7, message_text: 'x', coupon_id: cp.coupon_id, coupon_days: 14 });
  assert.equal(app.birthday.get(ADMIN_A, T).coupon_days, 14);
  await app.birthday.run(ADMIN_A, T);
  assert.equal(app.store.select('coupon_grants')[0].expires_at, addDaysJst(Date.now(), 14)); assert.ok(JSON.stringify(calls[0].body).includes('14日間'));
  const cp2 = app.coupons.create(ADMIN_A, T, { title: 'd' });
  await app.messaging.send(ADMIN_A, T, { text: 'hi', expectedCount: 1, couponId: cp2.coupon_id, couponDays: 7 });
  assert.equal(app.store.select('coupon_grants').find((g) => g.coupon_id === cp2.coupon_id).expires_at, addDaysJst(Date.now(), 7));
  app.birthday.save(ADMIN_A, T, { enabled: true, days_before: 7, message_text: 'x', coupon_id: cp.coupon_id, coupon_days: '' });
  assert.equal(app.birthday.get(ADMIN_A, T).coupon_days, '');
});
