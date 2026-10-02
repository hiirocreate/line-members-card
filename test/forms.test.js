import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';
import { renderForm } from '../src/render.js';

const T = 'SHOP001';

test('テンプレート適用・マスタ追加・並び替え・バージョン', () => {
  const { app } = setup();
  const added = app.forms.applyTemplate(ADMIN_A, T, 'standard');
  assert.deepEqual(added.map((f) => f.master_key), ['name', 'phone', 'email', 'address', 'birthday']);
  const [name, phone, email] = app.forms.fields(T);
  app.forms.reorder(ADMIN_A, T, [phone.field_id, name.field_id, phone.field_id]); // 重複は自動整理
  assert.deepEqual(app.forms.fields(T).map((f) => f.display_order), [1, 2, 3, 4, 5]);
  assert.equal(app.forms.fields(T)[0].field_id, phone.field_id);
  assert.ok(app.forms.versions(T).length >= 6);
  assert.equal(email.required, false);
});

test('ラベル変更は field_id 不変、バリデーション', () => {
  const { app } = setup();
  const [name] = app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const u = app.forms.updateField(ADMIN_A, T, name.field_id, { field_name: 'お名前', placeholder: '山田 太郎' });
  assert.equal(u.field_id, name.field_id); assert.equal(u.field_name, 'お名前');
  assert.throws(() => app.forms.updateField(ADMIN_A, T, name.field_id, { field_type: 'NUMBER' }), /変更できない/);
  assert.throws(() => app.forms.updateField(ADMIN_A, T, name.field_id, { field_name: '<script>alert(1)</script>' }), /HTML/);
  assert.throws(() => app.forms.addCustomField(ADMIN_A, T, { field_name: '職', field_type: 'SELECT' }), /選択肢/);
  assert.throws(() => app.forms.addCustomField(ADMIN_A, T, { field_name: '重複', field_type: 'SELECT', options: ['a', 'a'] }), /重複/);
});

test('高リスク項目は店舗が追加できない / 運営は設定可', () => {
  const { app } = setup();
  assert.throws(() => app.forms.addCustomField(ADMIN_A, T, { field_name: '病歴', field_type: 'TEXT' }), /追加できません/);
  assert.throws(() => app.forms.addCustomField(ADMIN_A, T, { field_name: '備考2', field_type: 'TEXT', placeholder: '宗教を入力' }), /追加できません/);
  assert.throws(() => app.forms.addCustomField(STAFF_A, T, { field_name: 'x', field_type: 'TEXT' }), /権限/);
});

test('削除=無効化、データ保持、再有効化。完全削除は運営のみ', () => {
  const { app } = setup();
  const f = app.forms.addCustomField(ADMIN_A, T, { field_name: '好きなブランド', field_type: 'TEXT' });
  app.forms.removeField(ADMIN_A, T, f.field_id);
  assert.equal(app.forms.fields(T).length, 0);
  assert.equal(app.forms.fields(T, { includeDisabled: true }).length, 1);
  assert.throws(() => app.forms.hardDeleteField(ADMIN_A, T, f.field_id), /権限/);
  app.forms.hardDeleteField(OP, T, f.field_id);
  assert.equal(app.forms.fields(T, { includeDisabled: true }).length, 0);
});

test('選択肢: 追加/並び替え/削除しても既存値の選択肢は保持', () => {
  const { app } = setup();
  const f = app.forms.addFromMaster(ADMIN_A, T, 'occupation');
  app.forms.updateField(ADMIN_A, T, f.field_id, { options: [...f.options, 'フリーランス'] });
  app.forms.reorderOptions(ADMIN_A, T, f.field_id, ['フリーランス']);
  let cur = app.forms.fields(T)[0];
  assert.equal(cur.options[0].value, 'フリーランス');
  app.forms.updateField(ADMIN_A, T, f.field_id, { options: cur.options.filter((o) => o.value !== '学生') });
  cur = app.forms.fields(T)[0];
  assert.ok(cur.options.find((o) => o.value === '学生').hidden);
});

test('監査ログ・キャッシュ無効化・他店舗分離', () => {
  const { app } = setup();
  const [name] = app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const v1 = app.forms.getUserForm(T);
  assert.equal(app.forms.getUserForm(T), v1); // キャッシュ
  app.forms.updateField(ADMIN_A, T, name.field_id, { field_name: 'お名前', required: false, purpose_text: '用途' });
  assert.notEqual(app.forms.getUserForm(T), v1);
  const actions = app.store.select('audit_logs', (l) => l.tenant_id === T).map((l) => l.action);
  for (const a of ['FIELD_ADD', 'FIELD_RENAME', 'FIELD_REQUIRED_CHANGE', 'FIELD_PURPOSE_CHANGE']) assert.ok(actions.includes(a), a);
  assert.throws(() => app.forms.updateField(ADMIN_B, T, name.field_id, { field_name: 'x' }), /他店舗/);
  assert.deepEqual(app.forms.fields('SHOP002'), []);
});

test('登録URL: tokenはサーバ側で検証', () => {
  const { app, tokenA } = setup();
  assert.equal(app.forms.resolveTenant(tokenA), T);
  assert.throws(() => app.forms.resolveTenant('nope'), /無効/);
});

test('HTMLレンダリングはエスケープされる', () => {
  const html = renderForm({ shopName: '<b>x</b>', fields: [{ field_id: 'F001', field_name: 'a"><img src=x>', field_type: 'TEXT', placeholder: '"><script>', required: true, options: [] }] });
  assert.ok(!html.includes('<img src=x>') && !html.includes('<script>') && !html.includes('<b>x</b>'));
});
