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

test('カードの氏名の並び順: 設定の検証と既定値', async () => {
  const { DEFAULT_DESIGN } = await import('../src/card.js');
  const { app } = env();
  assert.equal(DEFAULT_DESIGN.fields.nameOrder, 'asis');
  assert.equal(app.card.save(ADMIN_A, T, { fields: { name: true, nameOrder: 'swap' } }).design.fields.nameOrder, 'swap');
  assert.throws(() => app.card.save(ADMIN_A, T, { fields: { nameOrder: 'x' } }), (e) => e.details.some((m) => /並び順/.test(m)));
});

test('姓・名が別項目でもカードに出せる(parts)・誕生日配信の名前にも使われる', () => {
  const app = createApp(null, { secret: 'c'.repeat(40) });
  app.forms.createTenant(OP, T, 'テスト店');
  const ln = app.forms.addFromMaster(ADMIN_A, T, 'last_name').field_id, fn = app.forms.addFromMaster(ADMIN_A, T, 'first_name').field_id;
  app.members.register(T, 'U1', { [ln]: '山田', [fn]: '太郎' }, { confirmed: true });
  const m = app.members.findByUser(T, 'U1');
  assert.deepEqual(app.members.cardNameParts(T, m), { family: '山田', given: '太郎' });
  assert.equal(app.members.cardName(T, m), '山田 太郎');
  assert.equal(app.members.cardNameParts(T, { ...m, member_id: 'none' }), null);
});

test('姓・名の項目名の判定: 「姓(漢字)」は対象、読み仮名や「氏名」は対象外', () => {
  const app = createApp(null, { secret: 'c'.repeat(40) });
  app.forms.createTenant(OP, T, 'テスト店');
  const mk = (field_name) => app.forms.addCustomField(ADMIN_A, T, { field_name, field_type: 'TEXT', required: false }).field_id;
  const a = mk('姓(漢字)'), b = mk('名(漢字)'), c = mk('姓(カナ)'), d = mk('名(カナ)');
  app.members.register(T, 'U1', { [a]: '山田', [b]: '太郎', [c]: 'ヤマダ', [d]: 'タロウ' }, { confirmed: true });
  assert.deepEqual(app.members.cardNameParts(T, app.members.findByUser(T, 'U1')), { family: '山田', given: '太郎' });
});

test('「キャンペーン情報」の同意は、お知らせ設定(news)と同じ状態: 未登録にならず、どちらを変えても揃う', () => {
  const app = createApp(null, { secret: 'c'.repeat(40) });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id);
  const line = app.forms.addFromMaster(ADMIN_A, T, 'consent_line').field_id, mk = app.forms.addFromMaster(ADMIN_A, T, 'consent_marketing').field_id;
  const row = (u) => { const m = app.members.findByUser(T, u); return Object.fromEntries(app.members.profile(null, T, m.member_id).items.map((i) => [i.label, i.value])); };
  app.members.register(T, 'U1', { [n]: 'a', [p]: '09011112222', [line]: true }, { confirmed: true }); // キャンペーンは未チェック
  assert.equal(app.members.prefsOf(app.members.findByUser(T, 'U1')).news, false);
  assert.deepEqual([row('U1')['LINEでお知らせやクーポンを受け取る'], row('U1')['キャンペーン情報などの案内を受け取る']], ['はい', 'いいえ']);
  app.members.setPrefsByUser(T, 'U1', { news: true }); // 会員画面の「お知らせ」で変えると、登録情報の欄も同じになる
  assert.equal(row('U1')['キャンペーン情報などの案内を受け取る'], 'はい'); assert.equal(app.members.consents(T, app.members.findByUser(T, 'U1').member_id).MARKETING, true);
  app.members.register(T, 'U2', { [n]: 'b', [p]: '09011112222', [line]: true, [mk]: true }, { confirmed: true });
  assert.equal(app.members.prefsOf(app.members.findByUser(T, 'U2')).news, true); assert.equal(row('U2')['キャンペーン情報などの案内を受け取る'], 'はい');
});
