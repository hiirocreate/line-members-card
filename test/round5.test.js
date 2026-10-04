import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createAdmin, login, verifySession, changePassword, issueTempPassword, setUserPassword } from '../src/auth.js';
import { normalizeDesign } from '../src/card.js';
import { validateValue } from '../src/fieldTypes.js';
import { setLine } from '../src/settings.js';
import { OP, ADMIN_A, ADMIN_B, STAFF_A } from './helpers.js';

const T = 'SHOP001', SECRET = 'c'.repeat(40), PW = 'correct-horse-battery', TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const day = (o = 0) => new Date(Date.now() + 9 * 3600_000 + o * 86400_000).toISOString().slice(0, 10);

function env() {
  const calls = [];
  const app = createApp(null, { secret: SECRET, fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('{}', { status: 200 }); } });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗'); app.forms.applyTemplate(ADMIN_A, T, 'basic');
  const [n, p] = app.forms.fields(T).map((f) => f.field_id);
  setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, requireFriend: false });
  const reg = (u) => app.members.register(T, u, { [n]: `氏名${u}`, [p]: '09011112222' }, { confirmed: true });
  return { app, reg, calls };
}

test('仮パスワード: 発行→ログイン可・変更するまで要変更→変更で解除。権限・店舗分離・設定による変更', () => {
  const { app } = env();
  const st = createAdmin(app.store, OP, { role: 'STAFF', tenantId: T, email: 's@x.jp', password: PW });
  const other = createAdmin(app.store, OP, { role: 'STAFF', tenantId: 'SHOP002', email: 'o@x.jp', password: PW });
  const sid = app.store.find('admins', (a) => a.email === 's@x.jp').admin_id, oid = app.store.find('admins', (a) => a.email === 'o@x.jp').admin_id;
  const oldTok = login(app.store, { email: 's@x.jp', password: PW, secret: SECRET }).token;
  assert.throws(() => issueTempPassword(app.store, STAFF_A, sid), /権限|管理/); assert.throws(() => issueTempPassword(app.store, ADMIN_A, oid), /権限|管理|他店舗/); // 他店舗のスタッフには発行できない
  const { password } = issueTempPassword(app.store, ADMIN_A, sid);
  assert.ok(password.length >= 12); assert.equal(verifySession(app.store, oldTok, SECRET), null); // 以前のログインは無効
  assert.throws(() => login(app.store, { email: 's@x.jp', password: PW, secret: SECRET }), /違います/); // 古いパスワードは使えない
  const r = login(app.store, { email: 's@x.jp', password, secret: SECRET });
  assert.equal(r.mustChange, true); const actor = verifySession(app.store, r.token, SECRET); assert.equal(actor.mustChange, true);
  const nt = changePassword(app.store, actor, { current: password, next: 'brand-new-password', secret: SECRET });
  assert.equal(verifySession(app.store, nt, SECRET).mustChange, false);
  assert.equal(login(app.store, { email: 's@x.jp', password: 'brand-new-password', secret: SECRET }).mustChange, false);
  // 管理者が指定のパスワードを設定 (本人は最初のログインで変更が必要)
  assert.throws(() => setUserPassword(app.store, ADMIN_A, sid, { password: 'short' }), /10文字/);
  setUserPassword(app.store, OP, sid, { password: 'operator-set-pass' });
  assert.equal(login(app.store, { email: 's@x.jp', password: 'operator-set-pass', secret: SECRET }).mustChange, true);
  assert.ok(app.store.select('audit_logs').some((a) => a.action === 'ADMIN_TEMP_PASSWORD') && app.store.select('audit_logs').some((a) => a.action === 'ADMIN_SET_PASSWORD'));
});

test('期間中は何度でも使えるクーポン(+1日1回まで)', () => {
  const { app, reg } = env(); const c = app.coupons;
  const m = reg('U1');
  const once = c.create(ADMIN_A, T, { title: '通常', valid_until: day(5) }), multi = c.create(ADMIN_A, T, { title: '何度でも', valid_until: day(5), multi_use: true }), daily = c.create(ADMIN_A, T, { title: '1日1回', valid_until: day(5), multi_use: true, once_per_day: true });
  for (const x of [once, multi, daily]) c.grant(T, x.coupon_id, [m.member_id]);
  const use = (x) => c.redeemByCode(ADMIN_A, T, c.issueRedeemCode(T, m.member_id, x.coupon_id).code);
  use(once); assert.equal(c.state(once, m.member_id), 'used');
  use(multi); use(multi); use(multi); assert.equal(c.state(multi, m.member_id), 'available');
  assert.equal(c.memberCoupon(T, m.member_id, multi.coupon_id).redeemed_count, 3); assert.equal(c.memberCoupon(T, m.member_id, multi.coupon_id).coupon.multi_use, true);
  use(daily); assert.throws(() => use(daily), /本日すでに使用済み/);
  const list = c.list(ADMIN_A, T); assert.equal(list.find((x) => x.title === '何度でも').redeemed, 3); assert.equal(list.find((x) => x.title === '何度でも').multi_use, true);
  // 期限が過ぎれば使えない
  app.store.update('coupons', (x) => x.coupon_id === multi.coupon_id, { valid_until: day(-1) });
  assert.throws(() => use(multi), /期限|使え/);
  c.update(ADMIN_A, T, daily.coupon_id, { multi_use: false }); assert.equal(c.get(T, daily.coupon_id).multi_use, false);
});

test('来店の方式: 店舗のQRを会員が読み取る(STORE_QR)。60秒の期限・他店舗・クールダウン・方式の切り替え', async () => {
  const { app, reg } = env(); const mm = app.members;
  reg('U1'); reg('U2');
  assert.equal(mm.scanMode(T), 'MEMBER_QR');
  assert.throws(() => mm.setScanMode(STAFF_A, T, 'STORE_QR'), /権限/); assert.throws(() => mm.setScanMode(ADMIN_A, T, 'x'), /不正/); assert.throws(() => mm.setScanMode(ADMIN_B, T, 'STORE_QR'), /他店舗/);
  const { code, expiresAt } = mm.issueStoreVisitCode(STAFF_A, T);
  assert.throws(() => mm.visitByStoreCode(T, 'U1', code), /方式/); // 方式を切り替える前は使えない
  mm.setScanMode(ADMIN_A, T, 'STORE_QR'); assert.equal(mm.scanMode(T), 'STORE_QR');
  assert.ok(expiresAt - Date.now() <= 60_000);
  const r = mm.visitByStoreCode(T, 'U1', code); assert.equal(r.visit_count, 1);
  assert.throws(() => mm.visitByStoreCode(T, 'U1', code), /30分以内/); // 続けて記録しない
  assert.equal(mm.visitByStoreCode(T, 'U2', code).visit_count, 1); // 同じQRを別の会員も読み取れる(60秒の間)
  assert.throws(() => mm.visitByStoreCode(T, 'U2', code.slice(0, -3) + 'abc'), /期限|QR/); assert.throws(() => mm.visitByStoreCode(T, 'U3', code), /会員登録/);
  assert.throws(() => mm.visitByStoreCode('SHOP002', 'U1', code), /他店舗/);
  assert.throws(() => mm.visitByStoreCode(T, 'U1', mm.issueStoreVisitCode(ADMIN_A, T, -1000).code), /期限/);
  assert.equal(app.store.select('visits').filter((v) => v.method === 'STORE_QR').length, 2);
});

test('カード: メタリック・帯の設定の検証と既定値', () => {
  const d0 = normalizeDesign({});
  assert.equal(d0.background.metal, 'gold'); assert.deepEqual(d0.bands.map((b) => b.show), [false, false, false]);
  const d = normalizeDesign({ template: 'metal_silver', background: { type: 'metal', metal: 'silver' }, bands: [{ show: true, color: '#112233', size: 'L' }, { show: false }, { show: true, color: '#ffffff' }] });
  assert.deepEqual([d.background.type, d.background.metal, d.bands[0].size, d.bands[0].color, d.bands[2].show, d.bands[1].show], ['metal', 'silver', 'L', '#112233', true, false]);
  const bad = (x, re) => assert.throws(() => normalizeDesign(x), (e) => e.details.some((m) => re.test(m)));
  bad({ background: { metal: 'plastic' } }, /メタリック/); bad({ bands: [{ color: 'red' }] }, /帯1の色/); bad({ bands: [{ size: 'XL' }] }, /帯1の太さ/); bad({ template: 'metal_x' }, /テンプレート/);
  assert.equal(normalizeDesign({ bands: [{ show: true }, {}, {}, { show: true }] }).bands.length, 3); // 4つ目以降は無視
});

test('ランクごとのメタリック', () => {
  const { app } = env();
  const rk = (m) => [{ title: 'a', min_visits: 0, star_color: '#ffffff', card_metal: m }];
  assert.throws(() => app.ranks.save(ADMIN_A, T, { enabled: true, ranks: rk('wood') }), (e) => e.details.some((x) => /メタリック/.test(x)));
  app.ranks.save(ADMIN_A, T, { enabled: true, ranks: rk('gold') }); assert.equal(app.ranks.forVisits(T, 1).metal, 'gold');
});

test('読み仮名: ひらがな/カタカナ/アルファベットの指定と自動変換。氏名の判定には使われない', () => {
  const f = (input_script, extra = {}) => ({ field_name: '読み', field_type: 'TEXT', required: false, input_script, ...extra });
  assert.equal(validateValue(f('hiragana'), 'ヤマダ　タロウ'), 'やまだ たろう'); assert.equal(validateValue(f('katakana'), 'やまだ たろう'), 'ヤマダ タロウ');
  assert.equal(validateValue(f('alphabet'), 'Ｙａｍａｄａ Taro'), 'Yamada Taro');
  assert.throws(() => validateValue(f('hiragana'), '山田'), /ひらがな/); assert.throws(() => validateValue(f('katakana'), 'abc'), /カタカナ/); assert.throws(() => validateValue(f('alphabet'), 'やまだ'), /アルファベット/);
  assert.equal(validateValue(f(''), '山田 太郎'), '山田 太郎');
  const { app, reg } = env(); const ADM = ADMIN_A;
  const rd = app.forms.addFromMaster(ADM, T, 'name_reading'); assert.equal(rd.input_script, 'katakana'); assert.equal(rd.field_name, '氏名(読み仮名)');
  app.forms.updateField(ADM, T, rd.field_id, { input_script: 'hiragana' }); assert.equal(app.forms.fields(T).find((x) => x.field_id === rd.field_id).input_script, 'hiragana');
  assert.throws(() => app.forms.updateField(ADM, T, rd.field_id, { input_script: 'klingon' }), /入力する文字/);
  const [n, p] = app.forms.fields(T).map((x) => x.field_id);
  const m = app.members.register(T, 'U9', { [n]: '山田太郎', [p]: '09011112222', [rd.field_id]: 'ヤマダタロウ' }, { confirmed: true });
  assert.equal(app.members.profile(null, T, m.member_id).items.find((i) => i.field_id === rd.field_id).value, 'やまだたろう');
  assert.throws(() => app.members.register(T, 'U8', { [n]: 'a', [p]: '09011112222', [rd.field_id]: '山田' }, { confirmed: true }), (e) => e.details.some((x) => /ひらがな/.test(x)));
  // 読み仮名の項目を、氏名として拾わない
  app.store.update('members', (x) => x.user_id === 'U9', { name: '' });
  assert.notEqual(app.members.cardName(T, app.members.findByUser(T, 'U9')), 'やまだたろう');
});

test('カードの読み仮名と裏面QR: 設定・読み仮名の取得・運営による機能のON/OFF', async () => {
  const { normalizeDesign } = await import('../src/card.js');
  const { setFeatures, featureOn } = await import('../src/features.js');
  assert.equal(normalizeDesign({}).fields.reading, false); assert.equal(normalizeDesign({ fields: { reading: true }, qr: 'flip' }).fields.reading, true); assert.equal(normalizeDesign({ qr: 'flip' }).qr, 'flip');
  const { app } = env();
  // 読み仮名: 氏名の読み仮名が1項目 / 姓・名が別項目
  const rd = app.forms.addFromMaster(ADMIN_A, T, 'name_reading'), [n, p] = app.forms.fields(T).map((x) => x.field_id);
  app.members.register(T, 'U1', { [n]: '山田太郎', [p]: '09011112222', [rd.field_id]: 'ヤマダ タロウ' }, { confirmed: true });
  assert.deepEqual(app.members.cardReading(T, app.members.findByUser(T, 'U1')), { text: 'ヤマダ タロウ' });
  const app2 = createApp(null, { secret: SECRET }); app2.forms.createTenant(OP, T, 'x');
  const lr = app2.forms.addFromMaster(OP, T, 'last_name_reading').field_id, fr = app2.forms.addFromMaster(OP, T, 'first_name_reading').field_id;
  app2.members.register(T, 'U2', { [lr]: 'ヤマダ', [fr]: 'タロウ' }, { confirmed: true });
  assert.deepEqual(app2.members.cardReading(T, app2.members.findByUser(T, 'U2')), { parts: { family: 'ヤマダ', given: 'タロウ' } });
  assert.equal(app.members.cardReading(T, { ...app.members.findByUser(T, 'U1'), member_id: 'none' }), null);
  // 裏面QRの機能: 運営がオフにすると保存できず、会員には「カードの下」で出る
  assert.equal(featureOn(app.store, T, 'qrflip'), true);
  app.card.save(ADMIN_A, T, { qr: 'flip' });
  setFeatures(app.store, OP, T, { qrflip: false }); assert.equal(featureOn(app.store, T, 'qrflip'), false);
  assert.equal(app.card.get(T).design.qr, 'flip'); // 保存済みの値はそのまま(再度オンにすれば戻る)
});

test('裏面QRの位置調整: 範囲・大きさの検証と既定値', async () => {
  const { normalizeDesign } = await import('../src/card.js');
  assert.deepEqual(normalizeDesign({}).qrBack, { x: 0, y: 0, size: 'M', label: true });
  assert.deepEqual(normalizeDesign({ qrBack: { x: 25, y: -10, size: 'L', label: false } }).qrBack, { x: 25, y: -10, size: 'L', label: false });
  const bad = (qb, re) => assert.throws(() => normalizeDesign({ qrBack: qb }), (e) => e.details.some((m) => re.test(m)));
  bad({ x: 99 }, /横の位置/); bad({ y: -99 }, /縦の位置/); bad({ size: 'XL' }, /大きさ/);
});

test('運営向けの説明: 運営だけがAPIで取得でき、画面のJSには含まれない', async () => {
  const { createServer } = await import('../src/server.js');
  const { readFile } = await import('node:fs/promises');
  const { app } = env();
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW }); createAdmin(app.store, OP, { role: 'OPERATOR', tenantId: null, email: 'o@x.jp', password: PW });
  const srv = createServer(app, { sessionSecret: SECRET }).listen(0), base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, o = {}) => { const r = await fetch(base + path, { method: o.method, headers: o.token ? { authorization: `Bearer ${o.token}` } : {}, body: o.body && JSON.stringify(o.body) }); return { status: r.status, text: await r.text() }; };
  try {
    const tok = async (email) => JSON.parse((await call('/api/admin/login', { method: 'POST', body: { email, password: PW } })).text).token;
    const A = await tok('a@x.jp'), O = await tok('o@x.jp');
    const op = await call('/api/admin/ops-help', { token: O }); assert.equal(op.status, 200); assert.match(op.text, /Cloud Scheduler/);
    const st = await call('/api/admin/ops-help', { token: A }); assert.notEqual(st.status, 200); assert.ok(!/Scheduler|CRON/.test(st.text));
    for (const f of ['admin.js', 'app.js']) assert.ok(!/Cloud Scheduler|CRON_SECRET|gcloud/.test(await readFile(new URL(`../public/${f}`, import.meta.url), 'utf8')), f);
  } finally { srv.close(); }
});
