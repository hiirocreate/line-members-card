import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';
import { setLine } from '../src/settings.js';
import { setFeatures, featureOn, featureForPath } from '../src/features.js';
import { AuthError } from '../src/sanitize.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', SECRET = 'c'.repeat(40), PW = 'correct-horse-battery';
const at = (s) => Date.parse(`${s}+09:00`); // 日本時間
function env() {
  const calls = [];
  const app = createApp(null, { secret: SECRET, fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: 200 }); } });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id), consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  app.messaging.couponUrl = () => 'https://liff.line.me/1-abcde?t=tok&coupon=x';
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (u, c = true) => app.members.register(T, u, { [n]: `氏名${u}`, [p]: '09011112222', [consent]: c }, { confirmed: true });
  return { app, reg, calls };
}

test('会員ランク: 検証・権限・来店回数による判定(称号/☆/色/次のランク)', () => {
  const { app } = env(); const r = app.ranks;
  const ranks = [{ title: 'ブロンズ', min_visits: 0, star_color: '#cd7f32' }, { title: 'ゴールド', min_visits: 10, star_color: '#f5b301', card_color1: '#222222' }, { title: 'プラチナ', min_visits: 30, star_color: '#7fd3e6', card_color1: '#000000', card_color2: '#444444' }];
  const bad = (i, re) => assert.throws(() => r.save(ADMIN_A, T, i), (e) => e.details.some((x) => re.test(x)));
  bad({ ranks: [] }, /1〜10/); bad({ ranks: [{ title: 'a', min_visits: 1, star_color: '#ffffff' }] }, /最初.*0/); bad({ ranks: [{ title: '', min_visits: 0, star_color: '#fff' }] }, /称号|☆の色/);
  bad({ ranks: [{ title: 'a', min_visits: 0, star_color: '#ffffff' }, { title: 'b', min_visits: 0, star_color: '#ffffff' }] }, /大きく/); bad({ ranks: [{ title: 'a', min_visits: 0, star_color: '#ffffff', card_color1: 'red' }] }, /カードの色1/);
  assert.throws(() => r.save(STAFF_A, T, { enabled: true, ranks }), /権限/); assert.throws(() => r.get(ADMIN_B, T), /他店舗/);
  assert.equal(r.forVisits(T, 50), null); // 無効のあいだは出さない
  r.save(ADMIN_A, T, { enabled: true, ranks });
  assert.deepEqual([0, 9, 10, 29, 30, 99].map((n) => r.forVisits(T, n).stars), [1, 1, 2, 2, 3, 3]);
  const g = r.forVisits(T, 12); assert.deepEqual([g.title, g.starColor, g.color1, g.color2, g.next], ['ゴールド', '#f5b301', '#222222', '#222222', { title: 'プラチナ', remaining: 18 }]);
  assert.equal(r.forVisits(T, 40).next, null); assert.equal(r.forVisits('SHOP002', 5), null);
});

test('予約メッセージ: 毎日/毎週/毎月/1回の判定・同じ日に二重送信しない・配信先の絞り込み', async () => {
  const { app, reg, calls } = env(); const s = app.schedules;
  reg('U1'); reg('U2');
  const mk = (i) => s.create(ADMIN_A, T, { name: 't', message_text: 'hi', time: '10:00', ...i });
  const bad = (i, re) => assert.throws(() => s.create(ADMIN_A, T, { name: 't', message_text: 'x', time: '10:00', kind: 'DAILY', ...i }), (e) => e.details.some((x) => re.test(x)));
  bad({ time: '25:00' }, /HH:MM/); bad({ kind: 'X' }, /種類/); bad({ kind: 'WEEKLY', weekday: 9 }, /曜日/); bad({ kind: 'MONTHLY', day_of_month: 31 }, /日にち/); bad({ kind: 'ONCE' }, /送信日/); bad({ message_text: '' }, /どちらか/);
  bad({ where: { logic: 'AND', conditions: [{ field: 'nope', op: 'eq', value: 1 }] } }, /条件/);
  assert.throws(() => s.create(STAFF_A, T, { name: 't', message_text: 'x', time: '10:00', kind: 'DAILY' }), /権限/);
  mk({ kind: 'DAILY' });                                // 2026-10-03 は土曜 (dow=6)
  mk({ kind: 'WEEKLY', weekday: 6, message_text: 'weekly' }); mk({ kind: 'WEEKLY', weekday: 1, message_text: 'mon' });
  mk({ kind: 'MONTHLY', day_of_month: 3, message_text: 'monthly' }); mk({ kind: 'MONTHLY', day_of_month: 0, message_text: 'eom' });
  mk({ kind: 'ONCE', run_date: '2026-10-03', message_text: 'once' });
  assert.equal((await s.runDue(at('2026-10-03T09:59:00'))).length, 0); // 時刻前
  const r1 = await s.runDue(at('2026-10-03T10:05:00'));
  assert.deepEqual(calls.map((c) => c.messages[0].text).sort(), ['hi', 'monthly', 'once', 'weekly']); assert.ok(calls.every((c) => c.to.length === 2)); // 4件 × 2人まとめて
  assert.equal(r1.length, 4); // 毎日・毎週(土)・毎月3日・1回 (月末と月曜は対象外)
  assert.equal((await s.runDue(at('2026-10-03T11:00:00'))).length, 0); // 同じ日は二重に送らない
  assert.equal(s.list(ADMIN_A, T).find((x) => x.kind === 'ONCE').enabled, false); // 1回の予約は終わると停止
  assert.equal((await s.runDue(at('2026-10-31T10:00:00'))).filter((x) => !x.error).length, 3); // 毎日 + 毎週(10/31も土曜) + 月末
  // 配信先の絞り込み・機能オフ
  calls.length = 0;
  const seg = mk({ kind: 'DAILY', message_text: 'seg', where: { logic: 'AND', conditions: [{ field: 'member_number', op: 'eq', value: '000001' }] } });
  await s.runDue(at('2026-11-05T10:00:00')); assert.deepEqual(calls.find((c) => c.messages[0].text === 'seg').to, ['U1']);
  setFeatures(app.store, OP, T, { schedule: false }); calls.length = 0;
  assert.equal((await s.runDue(at('2026-11-06T10:00:00'))).length, 0); assert.equal(calls.length, 0);
});

test('機能の制限: 運営だけが設定でき、オフの店舗では管理者・スタッフのAPIが403', async () => {
  const { app } = env();
  assert.throws(() => setFeatures(app.store, ADMIN_A, T, { rank: false }), /権限/); assert.throws(() => setFeatures(app.store, OP, T, { nope: false }), /不明/);
  assert.equal(featureOn(app.store, T, 'rank'), true);
  assert.equal(featureForPath('/visit-rules'), 'visitrules'); assert.equal(featureForPath('/coupons/active'), 'coupons'); assert.equal(featureForPath('/members/search'), null);
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'OPERATOR', tenantId: null, email: 'o@x.jp', password: PW });
  const verifyLine = async (t) => { if (!t?.startsWith('line:')) throw new AuthError('x'); return t.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  try {
    const login = async (email) => (await call('/api/admin/login', { method: 'POST', body: { email, password: PW } })).json.token;
    const A = await login('a@x.jp'), O = await login('o@x.jp');
    assert.equal((await call('/api/admin/ranks', { token: A })).status, 200);
    assert.notEqual((await call(`/api/admin/tenants/${T}/features`, { method: 'PUT', token: A, body: { rank: false } })).status, 200);
    assert.equal((await call(`/api/admin/tenants/${T}/features`, { method: 'PUT', token: O, body: { rank: false, visitrules: false } })).status, 200);
    assert.equal((await call('/api/admin/ranks', { token: A })).status, 403); assert.equal((await call('/api/admin/visit-rules', { token: A })).status, 403);
    assert.equal((await call('/api/admin/schedules', { token: A })).status, 200); // オフにしていない機能は使える
    const me = (await call('/api/admin/me', { token: A })).json; assert.deepEqual([me.features.rank, me.features.visitrules, me.features.coupons], [false, false, true]);
    assert.equal((await call(`/api/admin/ranks?tenant=${T}`, { token: O })).status, 200); // 運営は常に使える
  } finally { srv.close(); }
});

test('ランクで絞り込んだ配信(予約メッセージ・メッセージ配信): 該当ランクの会員だけに届く', async () => {
  const { app, reg, calls } = env();
  const ranks = [{ title: 'ブロンズ', min_visits: 0, star_color: '#cd7f32' }, { title: 'ゴールド', min_visits: 10, star_color: '#f5b301' }];
  reg('U1'); reg('U2'); reg('U3');
  app.store.update('members', (m) => m.user_id === 'U1', { visit_count: 3 }); app.store.update('members', (m) => m.user_id === 'U2', { visit_count: 12 }); app.store.update('members', (m) => m.user_id === 'U3', { visit_count: 40 });
  const where = { logic: 'AND', conditions: [{ field: 'rank', op: 'eq', value: 'ゴールド' }] };
  assert.equal(app.messaging.preview(ADMIN_A, T, where).matched, 0); // ランクが無効のあいだは誰も該当しない
  assert.deepEqual(app.ranks.titles(ADMIN_A, T), []);
  app.ranks.save(ADMIN_A, T, { enabled: true, ranks });
  assert.deepEqual(app.ranks.titles(ADMIN_A, T), ['ブロンズ', 'ゴールド']);
  assert.equal(app.messaging.preview(ADMIN_A, T, where).audience, 2); // U2, U3
  app.schedules.create(ADMIN_A, T, { name: 'ゴールド限定', kind: 'DAILY', time: '10:00', message_text: 'gold', where });
  await app.schedules.runDue(at('2026-11-05T10:00:00'));
  assert.deepEqual(calls.find((c) => c.messages[0].text === 'gold').to.sort(), ['U2', 'U3']);
  assert.deepEqual(app.members.search(ADMIN_A, T, { where: { logic: 'AND', conditions: [{ field: 'rank', op: 'eq', value: 'ブロンズ' }] } }).members.map((m) => m.user_id), ['U1']);
});
