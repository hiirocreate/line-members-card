import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setLine } from '../src/settings.js';
import { OP, ADMIN_A } from './helpers.js';

const T = 'SHOP001', TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function env() {
  const calls = [];
  const app = createApp(null, { secret: 'c'.repeat(40), fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: 200 }); } });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id), consent = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id;
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (u) => app.members.register(T, u, { [n]: `氏名${u}`, [p]: '09011112222', [consent]: true }, { confirmed: true });
  return { app, reg, calls };
}

test('受け取る内容の設定: お知らせ/クーポンを断った会員には送らない・値の検証', async () => {
  const { app, reg, calls } = env();
  reg('U1'); reg('U2'); reg('U3');
  assert.deepEqual(app.members.setPrefsByUser(T, 'U2', { news: false }), { news: false, coupon: true, birthday: true });
  assert.deepEqual(app.members.setPrefsByUser(T, 'U3', { coupon: false }), { news: true, coupon: false, birthday: true });
  assert.throws(() => app.members.setPrefsByUser(T, 'U1', { news: 'no' }), /不正/); assert.throws(() => app.members.setPrefsByUser(T, 'none', {}), /存在しません/);
  assert.equal(app.messaging.preview(ADMIN_A, T, undefined).audience, 2); // U2 は断っている
  assert.equal(app.messaging.preview(ADMIN_A, T, undefined, 'x').audience, 2); // クーポン付きは U3 が除外
  const r = await app.messaging.send(ADMIN_A, T, { text: 'hi', expectedCount: 2 });
  assert.equal(r.sent, 2); assert.ok(!calls.some((c) => c.to === 'U2') && JSON.stringify(calls).includes('U3'));
});

test('会員証の氏名: 氏名の列が空でも「名前」項目の値を使う', () => {
  const { app, reg } = env();
  const f = app.forms.addCustomField(ADMIN_A, T, { field_name: 'お名前(ニックネーム可)', field_type: 'TEXT', required: false });
  reg('U9');
  app.store.insert('member_custom_values', { member_id: app.members.findByUser(T, 'U9').member_id, tenant_id: T, field_id: f.field_id, value: 'たろう', updated_at: '' });
  app.store.update('members', (m) => m.user_id === 'U9', { name: '' });
  assert.equal(app.members.cardName(T, app.members.findByUser(T, 'U9')), 'たろう');
  assert.equal(app.members.cardName(T, { ...app.members.findByUser(T, 'U9'), name: '山田' }), '山田');
});
