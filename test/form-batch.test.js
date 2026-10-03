import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';

const T = 'SHOP001';

test('一括保存: 追加・更新・非表示・並び替えを1回で反映し、バージョンは1つだけ上がる', () => {
  const { app } = setup(); const f = app.forms;
  const [name, phone] = f.applyTemplate(ADMIN_A, T, 'basic');
  const v0 = f.version(T), versionsBefore = f.versions(T).length;
  const r = f.applyBatch(ADMIN_A, T, { baseVersion: v0, ops: [
    { op: 'add', tempId: 'tmp1', masterKey: 'email', overrides: { required: true, field_name: 'ご連絡用メール' } },
    { op: 'add', tempId: 'tmp2', field: { field_name: '好きなブランド', field_type: 'TEXT' } },
    { op: 'update', id: name.field_id, patch: { field_name: 'お名前', placeholder: '山田 太郎' } },
    { op: 'update', id: 'tmp2', patch: { purpose_text: '商品のご案内に使います' } },     // 同じ保存の中で作る項目も指定できる
    { op: 'enable', id: phone.field_id, enabled: false },
    { op: 'order', ids: ['tmp2', 'tmp1', name.field_id, phone.field_id] },
  ] });
  assert.equal(r.version, v0 + 1); assert.equal(f.versions(T).length, versionsBefore + 1); // 履歴は1つだけ追加
  const byName = Object.fromEntries(r.fields.map((x) => [x.field_name, x]));
  assert.deepEqual(r.fields.map((x) => x.field_name), ['好きなブランド', 'ご連絡用メール', 'お名前', '電話番号']);
  assert.equal(byName['ご連絡用メール'].required, true); assert.equal(byName['好きなブランド'].purpose_text, '商品のご案内に使います');
  assert.equal(byName['電話番号'].enabled, false); assert.equal(byName['お名前'].placeholder, '山田 太郎');
  assert.deepEqual(f.getUserForm(T).fields.map((x) => x.field_name), ['好きなブランド', 'ご連絡用メール', 'お名前']);   // 会員のフォームにも反映(キャッシュ更新)
  assert.equal(app.store.select('form_versions', (x) => x.tenant_id === T && x.version === v0 + 1).length, 1);
  assert.ok(app.store.select('audit_logs').some((l) => l.action === 'FORM_BATCH_SAVE' && l.detail.operations === 6));
});

test('一括保存: 途中で失敗したら、全部取り消される(一部だけ反映されない)', () => {
  const { app } = setup(); const f = app.forms;
  const [name] = f.applyTemplate(ADMIN_A, T, 'basic');
  const v0 = f.version(T), before = JSON.stringify(f.fields(T, { includeDisabled: true })), audits = app.store.select('audit_logs').length;
  const fail = (ops, re) => { assert.throws(() => f.applyBatch(ADMIN_A, T, { baseVersion: v0, ops }), re);
    assert.equal(f.version(T), v0); assert.equal(JSON.stringify(f.fields(T, { includeDisabled: true })), before); assert.equal(app.store.select('audit_logs').length, audits); assert.equal(f.versions(T).length, v0); };
  fail([{ op: 'add', tempId: 'a', field: { field_name: '追加OK', field_type: 'TEXT' } }, { op: 'add', tempId: 'b', field: { field_name: '病歴', field_type: 'TEXT' } }], /追加できません.*2件目/);   // 2件目が禁止語 → 1件目も取り消し
  fail([{ op: 'update', id: name.field_id, patch: { field_name: '変更' } }, { op: 'update', id: name.field_id, patch: { field_type: 'NUMBER' } }], /変更できない/);
  fail([{ op: 'add', field: { field_name: '<script>', field_type: 'TEXT' } }], /HTML/);
  fail([{ op: 'add', field: { field_name: '選択', field_type: 'SELECT' } }], /選択肢/);
  fail([{ op: 'enable', id: 'nope', enabled: false }], /存在しません/);
  fail([{ op: 'order', ids: ['nope'] }], /存在しない/);
  fail([{ op: 'bogus' }], /未対応/);
  assert.equal(f.getUserForm(T).fields.length, 2);   // 会員のフォームは変わっていない
});

test('一括保存: 他の管理者が先に保存していたら拒否(上書きしない) / 権限 / 空・多すぎる変更', () => {
  const { app } = setup(); const f = app.forms;
  f.applyTemplate(ADMIN_A, T, 'basic');
  const v0 = f.version(T);
  f.addCustomField(ADMIN_A, T, { field_name: '先に追加された項目', field_type: 'TEXT' }); // 他の人が保存した
  assert.throws(() => f.applyBatch(ADMIN_A, T, { baseVersion: v0, ops: [{ op: 'add', field: { field_name: '私の項目', field_type: 'TEXT' } }] }), (e) => e.code === 'conflict' && /他の管理者/.test(e.message));
  assert.equal(f.fields(T).some((x) => x.field_name === '私の項目'), false);
  const v1 = f.version(T), ok = [{ op: 'add', field: { field_name: 'X', field_type: 'TEXT' } }];
  assert.throws(() => f.applyBatch(STAFF_A, T, { baseVersion: v1, ops: ok }), /権限/); assert.throws(() => f.applyBatch(ADMIN_B, T, { baseVersion: v1, ops: ok }), /他店舗/);
  assert.throws(() => f.applyBatch(ADMIN_A, T, { baseVersion: v1, ops: [] }), /変更がありません/);
  assert.throws(() => f.applyBatch(ADMIN_A, T, { baseVersion: v1, ops: Array(301).fill({ op: 'enable', id: 'x', enabled: true }) }), /多すぎ/);
  assert.equal(f.applyBatch(ADMIN_A, T, { baseVersion: v1, ops: ok }).version, v1 + 1);
});

test('API: PUT /form で一括保存、GET /form はバージョンとテンプレートを返す', async () => {
  const { app } = setup();
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: 'correct-horse-battery' });
  const srv = createServer(app, { sessionSecret: 'f'.repeat(40), liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const A = (await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: 'correct-horse-battery' } })).json.token;
    const g = (await call('/api/admin/form', { token: A })).json;
    assert.equal(g.version, 0); assert.ok(g.templates.standard.fields.length >= 5); assert.equal(g.interest.field_name, '興味・関心');
    const put = await call('/api/admin/form', { method: 'PUT', token: A, body: { baseVersion: 0, ops: [{ op: 'add', tempId: 't', masterKey: 'name', overrides: { required: true } }, { op: 'add', masterKey: 'phone', overrides: { required: true } }] } });
    assert.equal(put.status, 200); assert.equal(put.json.version, 1); assert.equal(put.json.fields.length, 2);
    const stale = await call('/api/admin/form', { method: 'PUT', token: A, body: { baseVersion: 0, ops: [{ op: 'enable', id: put.json.fields[0].field_id, enabled: false }] } });
    assert.equal(stale.status, 400); assert.equal(stale.json.code, 'conflict');
    const bad = await call('/api/admin/form', { method: 'PUT', token: A, body: { baseVersion: 1, ops: [{ op: 'add', masterKey: 'email' }, { op: 'add', field: { field_name: '宗教', field_type: 'TEXT' } }] } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /2件目/);
    assert.equal((await call('/api/admin/form', { token: A })).json.fields.length, 2);   // 1件目(メール)も取り消されている
  } finally { srv.closeAllConnections(); srv.close(); }
});
