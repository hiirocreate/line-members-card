import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';
import { createServer } from '../src/server.js';
import { createAdmin } from '../src/auth.js';
import { AuthError } from '../src/sanitize.js';

const T = 'SHOP001', PW = 'correct-horse-battery', SECRET = 'q'.repeat(40);

test('配信の同意: マスタから追加でき、必須にできず、チェックした会員だけ同意になる / 後からオン・オフできる', () => {
  const { app } = setup();
  const f = app.forms;
  const ids = (k) => f.fields(T, { includeDisabled: true }).find((x) => x.consent_target === k);
  assert.ok(app.store.find('field_master', (m) => m.key === 'consent_line'));
  const [n, p] = f.applyTemplate(ADMIN_A, T, 'basic').map((x) => x.field_id);
  const line = f.addFromMaster(ADMIN_A, T, 'consent_line');
  assert.deepEqual([line.field_type, line.consent_target, line.required, line.user_editable], ['CHECKBOX', 'LINE', false, true]);
  assert.match(line.purpose_text, /LINE/);
  assert.throws(() => f.updateField(ADMIN_A, T, line.field_id, { required: true }), /必須にできません/);
  assert.throws(() => f.addCustomField(ADMIN_A, T, { field_name: '同意', field_type: 'CHECKBOX', consent_target: 'EMAIL', required: true }), /必須にできません/);
  // 文言は編集できる / 非表示にしても再表示できる(同じ項目が戻る)
  f.updateField(ADMIN_A, T, line.field_id, { field_name: 'LINEで特典情報を受け取る' });
  f.setEnabled(ADMIN_A, T, line.field_id, false); assert.equal(ids('LINE').enabled, false);
  assert.equal(f.addFromMaster(ADMIN_A, T, 'consent_line').field_id, line.field_id); assert.equal(ids('LINE').enabled, true);
  // チェックなし=同意なし、あり=同意。他の同意(メール)は別管理
  f.addFromMaster(ADMIN_A, T, 'consent_email');
  const reg = (uid, v) => app.members.register(T, uid, { [n]: uid, [p]: '09011112222', [line.field_id]: v }, { confirmed: true });
  const m1 = reg('U1', true), m2 = reg('U2', false);
  assert.deepEqual(app.members.consents(T, m1.member_id), { LINE: true, EMAIL: false, MARKETING: false });
  assert.deepEqual(app.members.consents(T, m2.member_id), { LINE: false, EMAIL: false, MARKETING: false });
  assert.equal(app.messaging.preview(ADMIN_A, T).audience, 1);
  // 会員が後から変更 (登録時に同意していなくてもよい)
  app.members.updateByUser(T, 'U2', { [line.field_id]: true });
  assert.equal(app.members.consents(T, m2.member_id).LINE, true); assert.equal(app.messaging.preview(ADMIN_A, T).audience, 2);
  app.members.updateByUser(T, 'U1', { [line.field_id]: false });
  assert.equal(app.members.consents(T, m1.member_id).LINE, false);
  // テンプレート(店舗マーケティング)には同意項目が含まれる
  const { app: app2 } = setup();
  const added = app2.forms.applyTemplate(ADMIN_A, T, 'marketing');
  assert.ok(added.some((x) => x.consent_target === 'LINE'));
});

async function boot() {
  const { app, tokenA } = setup();
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP002', email: 'b@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STAFF', tenantId: T, email: 's@x.jp', password: PW });
  const verifyLine = async (t) => { if (!t?.startsWith('line:')) throw new AuthError('x'); return t.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const login = async (e) => (await call('/api/admin/login', { method: 'POST', body: { email: e, password: PW } })).json.token;
  return { app, tokenA, srv, call, login };
}

test('会員一覧API: ページ送り・上限・表示項目(columns)・並び替え・権限', async () => {
  const { app, tokenA, srv, call, login } = await boot();
  try {
    app.forms.applyTemplate(ADMIN_A, T, 'standard');
    const fs = app.forms.fields(T), [nameF, phoneF, mailF] = fs;
    const internal = app.forms.addCustomField(ADMIN_A, T, { field_name: '担当スタッフ', field_type: 'TEXT', visibility: 'ADMIN', user_editable: false }).field_id;
    for (let i = 1; i <= 45; i++) app.members.register(T, `U${i}`, { [nameF.field_id]: `会員${String(i).padStart(2, '0')}`, [phoneF.field_id]: `090000000${String(i % 10)}${String(i % 10)}`.slice(0, 11).padEnd(11, '0') }, { confirmed: true });
    app.members.updateByStaff(ADMIN_A, T, 'M001', { [mailF.field_id]: 'first@example.com', [internal]: '佐藤' });
    const A = await login('a@x.jp'), S = await login('s@x.jp'), B = await login('b@x.jp');
    const search = (token, body) => call('/api/admin/members/search', { method: 'POST', token, body });
    // 20件ずつ: 45件 → 20 / 20 / 5
    const p1 = (await search(A, { limit: 20, offset: 0, sort: { field: 'member_number', dir: 'asc' } })).json;
    assert.deepEqual([p1.total, p1.members.length, p1.limit, p1.offset], [45, 20, 20, 0]); assert.equal(p1.members[0].member_number, '000001');
    const p3 = (await search(A, { limit: 20, offset: 40, sort: { field: 'member_number', dir: 'asc' } })).json;
    assert.deepEqual([p3.members.length, p3.members[0].member_number, p3.members.at(-1).member_number], [5, '000041', '000045']);
    assert.equal((await search(A, { limit: 20, offset: 100 })).json.members.length, 0);
    // 既定は20件、上限は200件(それ以上を要求しても200)、不正な値は既定値
    assert.equal((await search(A, {})).json.members.length, 20);
    assert.equal((await search(A, { limit: 9999 })).json.limit, 200); assert.equal((await search(A, { limit: -5, offset: -9 })).json.limit, 20);
    // 表示項目: 指定した項目だけ values に入る。メールは未登録なら空
    const c = (await search(A, { limit: 3, sort: { field: 'member_number', dir: 'asc' }, columns: [nameF.field_id, mailF.field_id, internal, 'bogus'] })).json;
    assert.deepEqual(Object.keys(c.members[0].values).sort(), [nameF.field_id, mailF.field_id, internal].sort());
    assert.deepEqual([c.members[0].values[nameF.field_id], c.members[0].values[mailF.field_id], c.members[0].values[internal]], ['会員01', 'first@example.com', '佐藤']);
    assert.equal(c.members[1].values[mailF.field_id], '');
    // 権限のない項目(店舗管理者以上のみ)は、スタッフには含まれない
    const sc = (await search(S, { limit: 1, sort: { field: 'member_number', dir: 'asc' }, columns: [nameF.field_id, internal] })).json;
    assert.deepEqual(Object.keys(sc.members[0].values), [nameF.field_id]);
    // columns を付けなければ values は付かない / 他店舗には0件
    assert.equal((await search(A, { limit: 1 })).json.members[0].values, undefined);
    assert.equal((await search(B, { limit: 20 })).json.total, 0);
    // 並び替えは全体に対して効く (降順の先頭ページ = 最後の会員)
    const d = (await search(A, { limit: 20, sort: { field: nameF.field_id, dir: 'desc' } })).json;
    assert.equal(d.members[0].name, '会員45');
    void tokenA;
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('会員証からのお知らせ設定: 登録フォームに同意項目が無くても、会員本人がオン/オフでき、配信対象に反映される', async () => {
  const { app, tokenA } = setup();
  app.forms.applyTemplate(ADMIN_A, T, 'basic'); // 同意のチェックボックスは無い
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  const verifyLine = async (t) => { if (!t?.startsWith('line:')) throw new AuthError('x'); return t.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '1-abcde', lineChannelId: '1' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const [n, p] = (await call(`/t/${tokenA}/form`)).json.fields.map((f) => f.field_id);
    await call(`/t/${tokenA}/register`, { method: 'POST', token: 'line:U1', body: { confirmed: true, values: { [n]: '山田', [p]: '09011112222' } } });
    const me = () => call(`/t/${tokenA}/me`, { token: 'line:U1' });
    assert.equal((await me()).json.consents.LINE, false);
    assert.equal((await me()).json.card.page.showNotice, true); // 既定で、会員証に設定欄を表示する
    const set = (granted, channel = 'LINE') => call(`/t/${tokenA}/consent`, { method: 'POST', token: 'line:U1', body: { channel, granted } });
    assert.equal((await call(`/t/${tokenA}/consent`, { method: 'POST', body: { channel: 'LINE', granted: true } })).status, 401); // LINE認証が必要
    assert.equal((await set(true, 'EMAIL')).status, 400);                  // LINE以外は、ここでは変更できない
    assert.equal((await set('yes')).status, 400);                          // 真偽値のみ
    assert.equal((await set(true)).status, 200);
    assert.equal((await me()).json.consents.LINE, true);
    assert.equal(app.messaging.preview(ADMIN_A, T).audience, 1);          // 配信の対象に入る
    assert.equal((await set(false)).status, 200);
    assert.equal(app.messaging.preview(ADMIN_A, T).audience, 0);
    // 登録フォームに同意項目があるときは、その値も同じ状態にそろう
    const line = app.forms.addFromMaster(ADMIN_A, T, 'consent_line');
    await set(true);
    const items = (await me()).json.items; assert.equal(items.find((i) => i.field_id === line.field_id).value, 'はい');
    await set(false); assert.equal((await me()).json.items.find((i) => i.field_id === line.field_id).value, 'いいえ');
    assert.ok(app.store.select('audit_logs').some((l) => l.action === 'MEMBER_CONSENT_CHANGE'));
    // 退会済みは変更できない
    app.members.withdrawByUser(T, 'U1'); assert.equal((await set(true)).status, 400);
  } finally { srv.closeAllConnections(); srv.close(); }
});
