import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADMIN_A, STAFF_A } from './helpers.js';

const T = 'SHOP001';
function shop() {
  const ctx = setup();
  const { forms } = ctx.app;
  forms.applyTemplate(ADMIN_A, T, 'basic');
  const f = Object.fromEntries(forms.fields(T).map((x) => [x.master_key, x.field_id]));
  f.occ = forms.addFromMaster(ADMIN_A, T, 'occupation').field_id;
  f.mail = forms.addFromMaster(ADMIN_A, T, 'email').field_id;
  f.news = forms.addCustomField(ADMIN_A, T, { field_name: 'メール配信を受け取る', field_type: 'CHECKBOX', consent_target: 'EMAIL' }).field_id;
  f.rank = forms.addCustomField(ADMIN_A, T, { field_name: '顧客ランク', field_type: 'NUMBER', visibility: 'STAFF', user_editable: false }).field_id;
  f.bd = forms.addFromMaster(ADMIN_A, T, 'birthday').field_id;
  return { ...ctx, f };
}
const reg = (app, f, u, extra = {}) => app.members.register(T, u, { [f.name]: '山田 太郎', [f.phone]: '090-1234-5678', ...extra }, { confirmed: true });

test('登録: 確認必須・検証・内部項目は注入不可', () => {
  const { app, f } = shop();
  assert.throws(() => app.members.register(T, 'U1', {}, {}), /確認/);
  assert.throws(() => app.members.confirmRegistration(T, { [f.name]: '' , [f.phone]: '123' }), (e) => e.details.length >= 2);
  assert.throws(() => reg(app, f, 'U1', { [f.rank]: 5 }), (e) => /入力できない/.test(e.details[0]));
  const c = app.members.confirmRegistration(T, { [f.name]: '山田', [f.phone]: '09012345678', [f.occ]: '会社員' });
  assert.ok(c.items.find((i) => i.label === '職業').value === '会社員');
  const m = reg(app, f, 'U1', { [f.occ]: '会社員', [f.mail]: 'a@b.co' });
  assert.equal(m.phone, '09012345678'); assert.equal(m.email, 'a@b.co');
  assert.throws(() => reg(app, f, 'U1'), /既に/);
});

test('メール登録だけでは配信同意なし。同意項目でのみ付与', () => {
  const { app, f } = shop();
  const m = reg(app, f, 'U1', { [f.mail]: 'a@b.co' });
  assert.deepEqual(app.members.consents(T, m.member_id), { LINE: false, EMAIL: false, MARKETING: false });
  const m2 = reg(app, f, 'U2', { [f.news]: true });
  assert.equal(app.members.consents(T, m2.member_id).EMAIL, true);
});

test('フォーム変更後も既存会員データは保持 / 未登録表示 / 更新案内', () => {
  const { app, f } = shop();
  const m = reg(app, f, 'U1', { [f.occ]: '会社員' });
  const occ = app.forms.fields(T).find((x) => x.field_id === f.occ);
  app.forms.removeField(ADMIN_A, T, f.occ); // 無効化
  let p = app.members.profile(STAFF_A, T, m.member_id);
  assert.equal(p.items.find((i) => i.field_id === f.occ).value, '会社員'); // データ保持
  app.forms.setEnabled(ADMIN_A, T, f.occ, true);
  const newReq = app.forms.addCustomField(ADMIN_A, T, { field_name: '来店きっかけ', field_type: 'TEXT', required: true });
  p = app.members.profile(STAFF_A, T, m.member_id);
  assert.equal(p.items.find((i) => i.field_id === newReq.field_id).value, '未登録');
  assert.equal(p.needsUpdate, true); assert.equal(p.notice, '会員情報を更新してください');
  assert.equal(occ.field_name, '職業');
  assert.equal(app.members.profile(null, T, m.member_id).items.some((i) => i.field_id === f.rank), false); // 内部項目は本人に非表示
});

test('ユーザー編集可否', () => {
  const { app, f } = shop();
  reg(app, f, 'U1');
  app.members.updateByUser(T, 'U1', { [f.occ]: '学生' });
  assert.throws(() => app.members.updateByUser(T, 'U1', { [f.rank]: 9 }), (e) => /入力できない/.test(e.details[0]));
  app.forms.updateField(ADMIN_A, T, f.occ, { user_editable: false });
  assert.throws(() => app.members.updateByUser(T, 'U1', { [f.occ]: '会社員' }), (e) => /入力できない/.test(e.details[0]));
  const id = app.store.select('members')[0].member_id;
  app.members.updateByStaff(STAFF_A, T, id, { [f.occ]: '会社員', [f.rank]: 3 });
  assert.equal(app.members.profile(STAFF_A, T, id).items.find((i) => i.field_id === f.rank).value, '3');
});

test('検索(AND/OR)・ソート', () => {
  const { app, f } = shop();
  reg(app, f, 'U1', { [f.occ]: '会社員', [f.bd]: '1990-05-01' });
  reg(app, f, 'U2', { [f.occ]: '学生', [f.bd]: '2001-01-01' });
  reg(app, f, 'U3', { [f.occ]: '会社員' });
  const ids = (r) => r.members.map((m) => m.user_id);
  assert.deepEqual(ids(app.members.search(STAFF_A, T, { where: { logic: 'AND', conditions: [{ field: f.occ, op: 'eq', value: '会社員' }, { field: 'days_since_last_visit', op: 'gte', value: 90 }] } })), ['U1', 'U3']);
  app.members.recordVisit(STAFF_A, T, 'M001');
  assert.deepEqual(ids(app.members.search(STAFF_A, T, { where: { logic: 'AND', conditions: [{ field: f.occ, op: 'eq', value: '会社員' }, { field: 'days_since_last_visit', op: 'gte', value: 90 }] } })), ['U3']);
  assert.deepEqual(ids(app.members.search(STAFF_A, T, { where: { logic: 'OR', conditions: [{ field: f.occ, op: 'eq', value: '学生' }, { field: f.bd, op: 'empty' }] } })), ['U2', 'U3']);
  assert.deepEqual(ids(app.members.search(STAFF_A, T, { sort: { field: f.bd, dir: 'desc' } })), ['U2', 'U1', 'U3']); // 空は末尾
  assert.throws(() => app.members.search(STAFF_A, T, { where: { field: 'nope', op: 'eq', value: 1 } }), /検索できない/);
});

test('CSV出力: 独立権限・個人情報権限・インジェクション対策', () => {
  const { app, f } = shop();
  reg(app, f, 'U1', { [f.occ]: '会社員' });
  app.members.updateByStaff(STAFF_A, T, 'M001', { [f.name]: '=cmd|x' });
  assert.throws(() => app.members.exportCsv(STAFF_A, T, { columns: ['member_number'] }), /権限/);
  const exporter = { id: 'e', role: 'STAFF', tenantId: T, grants: ['EXPORT_MEMBERS'] };
  assert.throws(() => app.members.exportCsv(exporter, T, { columns: [f.name] }), /個人情報/);
  assert.throws(() => app.members.exportCsv(exporter, T, { columns: ['user_id'] }), /権限/);
  const personal = { ...exporter, grants: ['EXPORT_MEMBERS', 'EXPORT_PERSONAL_DATA'] };
  const csv = app.members.exportCsv(personal, T, { columns: ['member_number', f.name, f.occ] });
  assert.ok(csv.startsWith('\uFEFF会員番号,氏名,職業'));
  assert.ok(csv.includes("'=cmd|x"));
  assert.ok(app.store.select('audit_logs').some((l) => l.action === 'MEMBERS_EXPORT'));
});

test('Sheets形式のエクスポート/インポートで往復できる', async () => {
  const { app, f } = shop();
  reg(app, f, 'U1', { [f.occ]: '会社員' });
  const sheets = app.store.exportSheets();
  assert.deepEqual(Object.keys(sheets).slice(0, 3), ['tenants', 'tenant_urls', 'members']);
  const { Store } = await import('../src/store.js');
  const s2 = new Store(); s2.importSheets(JSON.parse(JSON.stringify(sheets)));
  assert.equal(s2.select('custom_fields').length, app.store.select('custom_fields').length);
  assert.deepEqual(s2.select('member_custom_values')[0].value, '会社員');
});
