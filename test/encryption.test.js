import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Store, ENCRYPTED_COLS } from '../src/store.js';
import { createVault } from '../src/vault.js';
import { OP, ADMIN_A } from './helpers.js';

const KEY = 'k'.repeat(40), T = 'SHOP001';
function env() {
  const app = createApp(null, { secret: KEY });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.applyTemplate(ADMIN_A, T, 'standard');
  const f = app.forms.fields(T);
  const m = app.members.register(T, 'Uabc123', { [f[0].field_id]: '山田 太郎', [f[1].field_id]: '09011112222', [f[2].field_id]: 'taro@example.com' }, { confirmed: true });
  app.store.insert('member_custom_values', { member_id: m.member_id, tenant_id: T, field_id: 'zz', value: { 区: '渋谷区', n: [1, 2] }, updated_at: '' });
  return { app, f, m };
}

test('保存データの暗号化: 個人情報の列は暗号文、それ以外は平文。メモリ上・画面は平文のまま', () => {
  const { app, m } = env();
  const sheets = app.store.exportSheets();
  const cell = (table, col, pred = () => true) => { const [h, ...rows] = sheets[table]; const i = h.indexOf(col); return rows.filter(pred).map((r) => r[i]); };
  for (const [table, cols] of Object.entries(ENCRYPTED_COLS)) for (const col of cols) for (const v of cell(table, col)) assert.ok(v === '' || String(v).startsWith('enc1:'), `${table}.${col} が暗号化されていない: ${v}`);
  const all = JSON.stringify(sheets);
  for (const secret of ['山田', '09011112222', 'taro@example.com', 'Uabc123']) assert.ok(!all.includes(secret), `保存データに平文が残っている: ${secret}`);
  assert.equal(cell('members', 'name')[0].startsWith('enc1:'), true); assert.equal(cell('members', 'member_number')[0], '000001'); // 暗号化しない列は読める
  assert.notEqual(cell('members', 'phone')[0], cell('members', 'phone')[0] + 'x'); // 形式の確認
  // メモリ上・画面(プロフィール)は平文
  assert.equal(app.store.find('members', (x) => x.user_id === 'Uabc123').phone, '09011112222');
  assert.equal(app.members.profile(ADMIN_A, T, m.member_id).items.find((i) => i.label === 'メールアドレス').value, 'taro@example.com');
  // 同じ値でも、保存のたびに暗号文は変わる(同じ内容かどうかが、暗号文から分からない)
  assert.notEqual(cell('members', 'name')[0], app.store.exportSheets().members[1][app.store.exportSheets().members[0].indexOf('name')]);
});

test('暗号化した保存データを、同じ鍵で読み込める / 違う鍵・鍵なしでは読み込まず、わかる説明で止まる', () => {
  const { app, m } = env();
  const sheets = JSON.parse(JSON.stringify(app.store.exportSheets()));
  const ok = new Store().setCipher(createVault(KEY)); const plain = ok.importSheets(JSON.parse(JSON.stringify(sheets)));
  assert.equal(plain.size, 0); assert.equal(ok.find('members', (x) => x.member_id === m.member_id).email, 'taro@example.com');
  assert.deepEqual(ok.find('member_custom_values', (x) => x.field_id === 'zz').value, { 区: '渋谷区', n: [1, 2] }); // JSON の列も復元
  assert.throws(() => new Store().setCipher(createVault('z'.repeat(40))).importSheets(JSON.parse(JSON.stringify(sheets))), /復号できません.*DATA_ENCRYPTION_KEY/);
  assert.throws(() => new Store().importSheets(JSON.parse(JSON.stringify(sheets))), /暗号鍵が設定されていません/);
  // DATA_ENCRYPTION_KEY を別に設定した場合は、その鍵で暗号化される(SESSION_SECRET を変えても読める)
  const a2 = createApp(null, { secret: KEY, dataKey: 'd'.repeat(40) }); a2.forms.createTenant(OP, 'S2', 'x');
  const s2 = a2.store.exportSheets(); a2.store.insert('members', { member_id: 'M1', tenant_id: 'S2', user_id: 'U9', member_number: '1', name: 'A', phone: '', email: '', status: 'ACTIVE' });
  const reread = new Store().setCipher(createVault('other-session-secret-'.repeat(3), 'd'.repeat(40))); reread.importSheets(JSON.parse(JSON.stringify(a2.store.exportSheets())));
  assert.equal(reread.find('members', (x) => x.member_id === 'M1').name, 'A');
});

test('暗号化されていない旧データは読み込めて、「保存し直す対象」として知らせる(自動で暗号化に移行)', () => {
  const { app } = env();
  const sheets = JSON.parse(JSON.stringify(app.store.exportSheets()));
  const [h, ...rows] = sheets.members; const ni = h.indexOf('name'); rows.forEach((r) => { r[ni] = '旧データ 花子'; });
  const s = new Store().setCipher(createVault(KEY)); const plain = s.importSheets({ ...sheets, members: [h, ...rows] });
  assert.ok(plain.has('members')); assert.equal(s.t.members[0].name, '旧データ 花子');
  assert.ok(!JSON.stringify(s.exportSheets().members).includes('旧データ')); // 次に書き出すときは暗号化される
});

test('ファイル出力(CSV・Excel)は、暗号化されず、読みやすい形式で出力される', () => {
  const { app, f } = env();
  const cols = f.map((x) => x.field_id);
  const csv = app.members.exportCsv(ADMIN_A, T, { columns: cols });
  assert.match(csv, /山田 太郎/); assert.match(csv, /09011112222/); assert.match(csv, /taro@example\.com/); assert.doesNotMatch(csv, /enc1:|v1\./);
  const xlsx = app.members.exportXlsx(ADMIN_A, T, { columns: cols });
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK'); assert.ok(!xlsx.toString('latin1').includes('enc1:'));
});
