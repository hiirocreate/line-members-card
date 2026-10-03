import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setLine } from '../src/settings.js';
import { addDaysJst } from '../src/dates.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
function env() {
  const calls = [];
  const app = createApp(null, { secret: 'c'.repeat(40), fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: 200 }); } });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id), consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  app.visitRules.couponUrl = (a, t, id) => `https://liff.line.me/1-abcde?t=tok&coupon=${id}`;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (u, c = true) => app.members.register(T, u, { [n]: `氏名${u}`, [p]: '09011112222', [consent]: c }, { confirmed: true });
  const visit = async (m) => { const r = app.members.recordVisit(STAFF_A, T, m.member_id); return app.visitRules.onVisit(T, m.member_id); };
  return { app, reg, calls, visit };
}

test('来店回数ルール: 検証・権限・店舗分離', () => {
  const { app } = env(); const v = app.visitRules;
  const bad = (i, re) => assert.throws(() => v.create(ADMIN_A, T, i), (e) => e.details.some((x) => re.test(x)));
  bad({ name: '', visits: 5, message_text: 'x' }, /ルール名/); bad({ name: 'a', visits: 0, message_text: 'x' }, /来店回数/); bad({ name: 'a', visits: 5 }, /どちらか/);
  bad({ name: 'a', visits: 5, message_text: 'x', valid_from: '2026-05-02', valid_until: '2026-05-01' }, /終了日/); bad({ name: 'a', visits: 5, coupon_id: 'f'.repeat(32) }, /存在しません/);
  assert.throws(() => v.create(STAFF_A, T, { name: 'a', visits: 5, message_text: 'x' }), /権限/);
  const r = v.create(ADMIN_A, T, { name: '5回', visits: 5, message_text: 'x' });
  assert.throws(() => v.list(ADMIN_B, T), /他店舗/); assert.throws(() => v.update(ADMIN_B, T, r.rule_id, { name: 'z' }), /他店舗/);
  assert.equal(v.update(ADMIN_A, T, r.rule_id, { enabled: false }).enabled, false); assert.equal(v.list(ADMIN_A, T)[0].enabled, false);
  v.remove(ADMIN_A, T, r.rule_id); assert.equal(v.list(ADMIN_A, T).length, 0);
});

test('来店回数ルール: N回目にだけ送り、クーポンも付与。重複・未同意・期間外は送らない', async () => {
  const { app, reg, calls, visit } = env();
  const m = reg('U1'), nm = reg('U2', false);
  const cp = app.coupons.create(ADMIN_A, T, { title: '5回特典', benefit: '1杯無料' });
  app.visitRules.create(ADMIN_A, T, { name: '3回目', visits: 3, message_text: '{名前}さん {回数}回目ありがとう', coupon_id: cp.coupon_id, coupon_days: 30 });
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await visit(m));
  assert.deepEqual(outs.map((o) => o.length), [0, 0, 1, 0]); assert.equal(outs[2][0].status, 'SENT');
  assert.equal(calls.length, 1); assert.equal(calls[0].to, 'U1'); assert.equal(calls[0].messages[0].text, '氏名U1さん 3回目ありがとう'); assert.ok(JSON.stringify(calls[0].messages[1]).includes('30日間'));
  assert.equal(app.coupons.state(cp, m.member_id), 'available'); assert.equal(app.store.select('coupon_grants')[0].expires_at, addDaysJst(Date.now(), 30));
  assert.equal((await app.visitRules.onVisit(T, m.member_id))[0]?.status, undefined); // 同じ来店回数への二重発火なし
  for (let i = 0; i < 3; i++) await visit(nm); assert.equal(calls.length, 1); assert.equal(app.visitRules.list(ADMIN_A, T)[0].sent, 1); // 未同意の会員は未送信
  // 期間外 / 停止中
  const r2 = app.visitRules.create(ADMIN_A, T, { name: '期間外', visits: 4, message_text: 'x', valid_from: addDaysJst(Date.now(), 5) });
  const m3 = reg('U3'); for (let i = 0; i < 4; i++) await visit(m3); assert.ok(!calls.some((c) => c.messages[0].text === 'x'));
  app.visitRules.update(ADMIN_A, T, r2.rule_id, { valid_from: '' }); // 期間を外せば有効だが、すでに4回目は過ぎている
});

test('来店回数ルール: N回ごと / 送信失敗は記録され再送しない', async () => {
  let fail = false;
  const { app, reg, calls, visit } = env();
  app.visitRules.fetchImpl = async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: fail ? 400 : 200 }); };
  const m = reg('U1');
  app.visitRules.create(ADMIN_A, T, { name: '2回ごと', visits: 2, repeat: true, message_text: 'ok' });
  for (let i = 0; i < 6; i++) await visit(m);
  assert.equal(calls.length, 3); // 2,4,6回目
  fail = true; await visit(m); const o = await visit(m); assert.equal(o[0].status, 'FAILED'); assert.equal(app.visitRules.list(ADMIN_A, T)[0].failed, 1);
});
