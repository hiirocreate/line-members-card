import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setLine } from '../src/settings.js';
import { setFeatures } from '../src/features.js';
import { frequency } from '../src/revisit.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', DAY = 86400_000, NOW = Date.parse('2026-09-01T03:00:00Z');
function env() {
  const calls = [];
  const app = createApp(null, { secret: 'c'.repeat(40), fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: 200 }); } });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id), consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (u, c = true) => app.members.register(T, u, { [n]: `氏名${u}`, [p]: '09011112222', [consent]: c }, { confirmed: true });
  // 来店履歴を直接作る: gaps = 来店の何日前か(新しい順でなくてよい)
  const visits = (m, daysAgo) => { for (const d of daysAgo) app.store.insert('visits', { visit_id: `${m.member_id}${d}`, tenant_id: T, member_id: m.member_id, visited_at: new Date(NOW - d * DAY).toISOString(), method: 'MANUAL', recorded_by: 'x' });
    app.store.update('members', (r) => r.member_id === m.member_id, { last_visit_at: new Date(NOW - Math.min(...daysAgo) * DAY).toISOString(), visit_count: daysAgo.length }); };
  return { app, reg, visits, calls };
}

test('来店間隔: 窓内の平均', () => {
  assert.equal(frequency([], 90).avg, null);
  assert.equal(frequency([0, 7 * DAY, 14 * DAY, 21 * DAY], 90).avg, 7);
  assert.equal(frequency([0, 200 * DAY, 207 * DAY, 214 * DAY], 30).n, 3); // 最終来店から30日より前は使わない
});

test('再来店のお知らせ: 会員ごとの頻度で判定(週1で3週間空き=対象、月1で2週間・週2で1週間=対象外)', async () => {
  const { app, reg, visits, calls } = env();
  const A = reg('UA'), B = reg('UB'), C = reg('UC'), D = reg('UD', false);
  visits(A, [21, 28, 35, 42, 49]); visits(B, [14, 44, 74]); visits(C, [7, 10, 14, 17, 21]); visits(D, [21, 28, 35, 42]);
  const r = app.revisit;
  assert.throws(() => r.save(ADMIN_A, T, { enabled: true, multiplier: 1, min_days: 14, stop_days: 180, window_days: 90, min_visits: 3, message_text: 'x' }), (e) => e.details.some((x) => /何倍/.test(x)));
  assert.throws(() => r.save(STAFF_A, T, {}), /権限/); assert.throws(() => r.get(ADMIN_B, T), /他店舗/);
  r.save(ADMIN_A, T, { enabled: true, multiplier: 2.5, min_days: 14, stop_days: 180, window_days: 90, min_visits: 3, message_text: '{名前}さん {日数}日ぶり' });
  const pv = r.preview(ADMIN_A, T, NOW);
  assert.equal(pv.willSend, 1); assert.equal(pv.counts.ok, 2); assert.equal(pv.counts.off, 1);
  const res = await r.run(ADMIN_A, T, { nowMs: NOW });
  assert.equal(res.sent, 1); assert.match(calls[0].messages[0].text, /氏名UA さん 21日ぶり|氏名UAさん 21日ぶり/);
  assert.equal((await r.run(ADMIN_A, T, { nowMs: NOW + 3600_000 })).sent, 0); // 同じ空き期間には1回だけ
  app.members.recordVisit(STAFF_A, T, A.member_id); // 来店するとリセット (last_visit_at が変わる)
  assert.equal(app.store.find('members', (m) => m.member_id === A.member_id).visit_count, 6);
});

test('再来店のお知らせ: 会員が断る/管理者が止める/空きすぎ/機能オフ', async () => {
  const { app, reg, visits } = env(); const r = app.revisit;
  const A = reg('UA'), B = reg('UB'); visits(A, [21, 28, 35, 42]); visits(B, [200, 207, 214, 221]);
  r.save(ADMIN_A, T, { enabled: true, multiplier: 2.5, min_days: 14, stop_days: 180, window_days: 90, min_visits: 3, message_text: 'x' });
  assert.equal(r.preview(ADMIN_A, T, NOW).counts.long, 1);
  app.members.setPrefsByUser(T, 'UA', { revisit: false });
  assert.equal(r.preview(ADMIN_A, T, NOW).willSend, 0);
  assert.equal(r.setMemberEnabled(ADMIN_A, T, A.member_id, true).enabled, true); assert.equal(r.preview(ADMIN_A, T, NOW).willSend, 1);
  assert.throws(() => r.setMemberEnabled(ADMIN_B, T, A.member_id, false), /他店舗/);
  assert.equal(r.memberStat(ADMIN_A, T, A.member_id, NOW).avg_days, 7);
  setFeatures(app.store, OP, T, { revisit: false });
  assert.deepEqual(await r.runAll(NOW + 7 * 3600_000), [{ tenant_id: T, error: 'この機能はご利用できません' }]);
});

test('ランクアップ演出: 上がったときだけ1回。初回・ランクダウン・無効では出さない', () => {
  const { app, reg } = env(); const m = reg('UA'), get = () => app.store.find('members', (x) => x.member_id === m.member_id);
  const ranks = [{ title: 'レギュラー', min_visits: 0, star_color: '#cd7f32' }, { title: 'ゴールド', min_visits: 5, star_color: '#f5b301', effect_kind: 'grand' }, { title: 'プラチナ', min_visits: 10, star_color: '#7fd3e6' }];
  assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: true, kind: 'bad', seconds: 4 } }), (e) => e.details.some((x) => /演出の種類/.test(x)));
  assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: true, kind: 'badge', seconds: 99 } }), (e) => e.details.some((x) => /2〜10秒/.test(x)));
  assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks: ranks.map((x) => ({ ...x, effect_kind: 'zzz' })) }), (e) => e.details.some((x) => /演出の種類/.test(x)));
  const cfg = app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: true, kind: 'confetti', seconds: 5 } });
  assert.equal(cfg.effect.kind, 'confetti');
  const rk = (n, last) => app.ranks.forVisits(T, n, last);
  assert.equal(app.ranks.checkUp(T, get(), rk(0)), null); assert.equal(get().rank_seen, 1); // 初めて見る: 記録だけ
  assert.equal(app.ranks.checkUp(T, get(), rk(0)), null);
  const up = app.ranks.checkUp(T, get(), rk(5)); assert.equal(up.kind, 'grand'); assert.equal(up.title, 'ゴールド'); assert.equal(up.from, 'レギュラー'); assert.equal(up.seconds, 5); // ランク別の指定が優先
  assert.equal(app.ranks.checkUp(T, get(), rk(5)), null); // 1回だけ
  assert.equal(app.ranks.checkUp(T, get(), rk(10)).kind, 'confetti');
  assert.equal(app.ranks.checkUp(T, get(), rk(5)), null); assert.equal(get().rank_seen, 2); // 下がった: 記録だけ
  app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: false, kind: 'confetti', seconds: 5 } });
  assert.equal(app.ranks.checkUp(T, get(), rk(10)), null); // 演出オフ
});

test('アップデートのお知らせ: 一覧・未読・既読', async () => {
  const { UPDATES } = await import('../src/updates.js');
  assert.ok(UPDATES.length > 0 && new Set(UPDATES.map((u) => u.id)).size === UPDATES.length);
  assert.ok(UPDATES.every((u) => u.id && u.title && u.body && /^\d{4}-\d{2}-\d{2}$/.test(u.date)));
});

test('運営からのお知らせ: 運営のみ作成・対象店舗/期間/停止で表示を制御', () => {
  const { app } = env(); const a = app.announcements;
  const bad = (i, re) => assert.throws(() => a.create(OP, i), (e) => e.details.some((x) => re.test(x)));
  bad({ title: '', body: 'x' }, /タイトル/); bad({ title: 't', body: '' }, /本文/); bad({ title: 't', body: 'x', tenant_ids: ['NOPE'] }, /店舗が存在/); bad({ title: 't', body: 'x', visible_from: '2026-05-02', visible_until: '2026-05-01' }, /終了日/);
  assert.throws(() => a.create(ADMIN_A, { title: 't', body: 'x' }), /権限/); assert.throws(() => a.list(ADMIN_A), /権限/);
  const all = a.create(OP, { title: '全店', body: 'メンテナンス' }), one = a.create(OP, { title: 'A店だけ', body: 'x', tenant_ids: [T] });
  const old = a.create(OP, { title: '期限切れ', body: 'x', visible_until: '2020-01-01' });
  assert.deepEqual(a.visible(T, NOW).map((x) => x.title).sort(), ['A店だけ', '全店']); assert.deepEqual(a.visible('SHOP002', NOW).map((x) => x.title), ['全店']);
  assert.equal(a.visible(null, NOW).length, 2);
  a.update(OP, all.announcement_id, { enabled: false }); assert.deepEqual(a.visible('SHOP002', NOW), []);
  a.remove(OP, one.announcement_id); assert.equal(a.list(OP).length, 2); assert.ok(old);
});

test('お知らせAPI: 未読→既読、運営の手動お知らせが店舗に届く', async () => {
  const { createServer } = await import('../src/server.js'), { createAdmin } = await import('../src/auth.js');
  const { app } = env(), PW = 'correct-horse-battery', SECRET = 'c'.repeat(40);
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW }); createAdmin(app.store, OP, { role: 'OPERATOR', tenantId: null, email: 'o@x.jp', password: PW });
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine: async () => 'x', liffId: '1-abcde', lineChannelId: '1' }).listen(0), base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const login = async (email) => (await call('/api/admin/login', { method: 'POST', body: { email, password: PW } })).json.token, A = await login('a@x.jp'), O = await login('o@x.jp');
    let u = (await call('/api/admin/updates', { token: A })).json; const n0 = u.unread; assert.ok(n0 > 0);
    assert.equal((await call('/api/admin/updates', { method: 'POST', token: A })).status, 200);
    assert.equal((await call('/api/admin/updates', { token: A })).json.unread, 0);
    assert.equal((await call('/api/admin/announcements', { method: 'POST', token: A, body: { title: 't', body: 'x' } })).status, 404); // 運営専用(店舗には存在しない扱い)
    assert.equal((await call('/api/admin/announcements', { method: 'POST', token: O, body: { title: '重要', body: 'メンテ', tenant_ids: [T] } })).status, 201);
    u = (await call('/api/admin/updates', { token: A })).json; assert.equal(u.unread, 1); assert.equal(u.items.find((x) => x.unread).title, '重要'); assert.equal(u.items.find((x) => x.unread).from, '運営');
    assert.equal((await call('/api/admin/announcements', { token: O })).json.items.length, 1);
  } finally { srv.close(); }
});

test('ランクアップ演出: バッジの編集(見出し・記号・形・色・ランク別の記号)', () => {
  const { app, reg } = env(); const m = reg('UA'), get = () => app.store.find('members', (x) => x.member_id === m.member_id);
  const ranks = [{ title: 'レギュラー', min_visits: 0, star_color: '#cd7f32' }, { title: 'ゴールド', min_visits: 5, star_color: '#f5b301', badge_icon: '👑' }];
  const bad = (badge, re) => assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: true, kind: 'badge', seconds: 4, badge } }), (e) => e.details.some((x) => re.test(x)));
  bad({ label: 'x'.repeat(17) }, /見出し/); bad({ icon: '' }, /記号/); bad({ icon: 'abcd' }, /記号/); bad({ shape: 'zz' }, /形/); bad({ color: 'red' }, /色/);
  assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks: ranks.map((x) => ({ ...x, badge_icon: 'abcdef' })) }), (e) => e.details.some((x) => /記号/.test(x)));
  assert.equal(app.ranks.get(ADMIN_A, T).effect.badge.label, 'RANK UP!'); // 既定
  app.ranks.save(ADMIN_A, T, { enabled: true, ranks, effect: { enabled: true, kind: 'badge', seconds: 4, badge: { label: 'おめでとう', icon: '💎', shape: 'ribbon', color: '#AA00FF', show_title: false, show_stars: true } } });
  app.ranks.checkUp(T, get(), app.ranks.forVisits(T, 0));
  const up = app.ranks.checkUp(T, get(), app.ranks.forVisits(T, 5));
  assert.deepEqual(up.badge, { label: 'おめでとう', icon: '👑', shape: 'ribbon', color: '#aa00ff', showTitle: false, showStars: true }); // ランク別の記号が優先
});
