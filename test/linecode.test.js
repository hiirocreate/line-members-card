import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createAdmin, login, sendLineCode, startLineLink, completeLineLink, readLineLink, unlinkLine, resetTwoFactor, LoginLimiter } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { setLine } from '../src/settings.js';
import { AuthError } from '../src/sanitize.js';
import { OP, ADMIN_A } from './helpers.js';

const SECRET = 'l'.repeat(40), PW = 'correct-horse-battery', T = 'SHOP001';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function env() {
  const app = createApp(null, { secret: SECRET });
  app.forms.createTenant(OP, T, 'テスト店'); app.forms.createTenant(OP, 'SHOP002', '別店舗');
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'c@x.jp', password: PW });
  const { store, vault } = app, sent = [];
  const send = async (a, text) => { sent.push({ to: a.line_user_id, text }); };
  const code = () => /(\d{6})/.exec(sent.at(-1).text)[1];
  const admin = (email) => store.find('admins', (x) => x.email === email);
  const actor = (email) => ({ id: admin(email).admin_id, role: 'STORE_ADMIN', tenantId: T });
  const link = async (email, userId) => {
    const l = startLineLink(vault, actor(email));
    return completeLineLink(store, vault, { link: l.token, idToken: userId, verifyLine: async (t) => t, channelIdFor: () => '1', send });
  };
  const L = (extra = {}, email = 'a@x.jp') => login(store, { email, password: PW, secret: SECRET, vault, lineAvailable: () => true, limiter: new LoginLimiter(), ...extra });
  const S = (email = 'a@x.jp', extra = {}) => sendLineCode(store, { email, password: PW, send, lineAvailable: () => true, ...extra });
  return { app, store, vault, sent, send, code, admin, actor, link, L, S };
}

test('連携: リンク発行 → LINE本人確認 → 連携。期限・改ざん・使い回し・重複を拒否', async () => {
  const { store, vault, sent, admin, actor, link, send } = env();
  assert.equal((await link('a@x.jp', 'Uaaa')).linked, true);
  assert.equal(admin('a@x.jp').line_user_id, 'Uaaa');
  assert.equal(sent[0].to, 'Uaaa'); assert.match(sent[0].text, /連携が完了/);   // 連携直後に確認メッセージが届く
  // 別の管理者が同じLINEアカウントを連携しようとすると拒否
  await assert.rejects(link('c@x.jp', 'Uaaa'), /別の管理者/);
  // 使い回し / 改ざん / 期限切れ
  const l = startLineLink(vault, actor('c@x.jp'));
  const deps = { verifyLine: async (t) => t, channelIdFor: () => '1', send };
  await completeLineLink(store, vault, { link: l.token, idToken: 'Uccc', ...deps });
  await assert.rejects(completeLineLink(store, vault, { link: l.token, idToken: 'Uzzz', ...deps }), /使用済み/);
  assert.throws(() => readLineLink(vault, store, `${l.token}x`), /無効/);
  const expired = vault.sign('line-link', { a: admin('a@x.jp').admin_id, e: Date.now() - 1, n: 'n1' });
  assert.throws(() => readLineLink(vault, store, expired), /期限切れ/);
  // 確認メッセージが送れなくても、連携自体は完了し、notified=false で知らせる
  unlinkLine(store, actor('c@x.jp'), { password: PW });
  const l2 = startLineLink(vault, actor('c@x.jp'));
  const r = await completeLineLink(store, vault, { link: l2.token, idToken: 'Uccc2', ...deps, send: async () => { throw new Error('blocked'); } });
  assert.deepEqual([r.linked, r.notified], [true, false]);
  assert.throws(() => unlinkLine(store, actor('c@x.jp'), { password: 'bad' }), /パスワード/);
});

test('LINEコード: パスワード確認→送信→ログイン。1回限り・誤り5回で無効・期限・再送制限', async () => {
  const { sent, code, link, L, S, admin, store } = env();
  await link('a@x.jp', 'Uaaa'); sent.length = 0;
  const need = L(); assert.deepEqual([need.requires2fa, need.methods], [true, ['line']]); assert.equal(need.lineAvailable, true);
  await assert.rejects(S('a@x.jp', { password: 'bad' }), /違います/);       // パスワードが正しい人にだけ送る
  assert.equal(sent.length, 0);
  await assert.rejects(S('c@x.jp'), /設定されていません/);                   // 未連携のアカウントには送らない
  await S();
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'Uaaa'); assert.match(sent[0].text, /^【会員管理】ログイン認証コード: \d{6}/);
  const c = code();
  assert.throws(() => L({ lineCode: '000000' === c ? '000001' : '000000' }), /LINEのコード/);
  assert.ok(L({ lineCode: c }).token);                                       // 正しいコードでログイン
  assert.throws(() => L({ lineCode: c }), /LINEのコード/);                    // 1回限り
  await assert.rejects(S(), /30秒/);                                          // 連続送信の抑止
  // 誤りが5回を超えると、そのコードは無効
  const fresh = (await (async () => { const e = env(); await e.link('a@x.jp', 'Uaaa'); return e; })());
  await fresh.S(); const good = fresh.code(); const wrong = good === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.throws(() => fresh.L({ lineCode: wrong }), /LINEのコード/);
  assert.throws(() => fresh.L({ lineCode: good }), /LINEのコード/);
  // 他の管理者のコードでは入れない
  const two = env(); await two.link('a@x.jp', 'Uaaa'); await two.link('c@x.jp', 'Uccc'); await two.S('a@x.jp');
  assert.throws(() => two.L({ lineCode: two.code() }, 'c@x.jp'), /LINEのコード/);
  // 連携済みなら、送信設定が一時的に無くなっても、パスワードだけで入れる状態には戻らない
  const nosend = login(store, { email: 'a@x.jp', password: PW, secret: SECRET, vault: fresh.vault, lineAvailable: () => false });
  assert.deepEqual(nosend.methods, ['line']); assert.equal(nosend.lineAvailable, false); assert.equal(nosend.token, undefined);
  void admin;
});

test('LINEコード: 1時間に5回まで・期限切れ・2FAリセットで連携も解除', async () => {
  const { link, S, L, code, store, admin } = env();
  await link('a@x.jp', 'Uaaa');
  const realNow = Date.now; let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 5; i++) { await S(); t += 31_000; }
    await assert.rejects(S(), /上限/);
    t += 3600_000; await S(); const c = code();
    t += 5 * 60_000 + 1; assert.throws(() => L({ lineCode: c }), /LINEのコード/);   // 5分たつと失効
  } finally { Date.now = realNow; }
  resetTwoFactor(store, { id: 'op', role: 'OPERATOR' }, admin('a@x.jp').admin_id);
  assert.equal(admin('a@x.jp').line_user_id, ''); assert.ok(L().token);
});

// ---- HTTP ----
test('API: 管理画面からLINE連携 → ログイン時にLINEでコード → ログイン (店舗のトークンで送信)', async () => {
  const pushes = [];
  const fetchImpl = async (url, init) => { pushes.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const app = createApp(null, { secret: SECRET, fetchImpl });
  app.forms.createTenant(OP, T, 'テスト店');
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: T, email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'OPERATOR', email: 'op@x.jp', password: PW });
  const verifyLine = async (tok, ch) => { if (!tok?.startsWith('line:')) throw new AuthError('x'); return tok.slice(5); };
  const srv = createServer(app, { sessionSecret: SECRET, verifyLine, liffId: '9999999999-Default', lineChannelId: '9999999999' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => { const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const A = (await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW } })).json.token;
    // 送信設定が無いうちは連携を始められない
    assert.equal((await call('/api/admin/security/line/start', { method: 'POST', token: A })).status, 400);
    assert.equal((await call('/api/admin/security', { token: A })).json.line.available, false);
    setLine(app.store, app.vault, ADMIN_A, T, { messagingToken: TOKEN, liffId: '1111111111-AaAaAaAa', loginChannelId: '1111111111' });
    assert.equal((await call('/api/admin/security', { token: A })).json.line.available, true);
    const st = (await call('/api/admin/security/line/start', { method: 'POST', token: A })).json;
    assert.match(st.url, /^https:\/\/liff\.line\.me\/1111111111-AaAaAaAa\?link=/);
    const link = new URL(st.url).searchParams.get('link');
    // ミニアプリ画面が使うLIFF IDは、その管理者の店舗の設定
    assert.equal((await call(`/app/config.json?link=${encodeURIComponent(link)}`)).json.liffId, '1111111111-AaAaAaAa');
    // スマホ側: LINEのIDトークンで完了 (不正なトークンは401)
    assert.equal((await call('/api/admin/line-link/complete', { method: 'POST', body: { link, idToken: 'bad' } })).status, 401);
    const done = await call('/api/admin/line-link/complete', { method: 'POST', body: { link, idToken: 'line:Uadmin1' } });
    assert.deepEqual(done.json, { linked: true, notified: true });
    assert.equal(pushes.at(-1).auth, `Bearer ${TOKEN}`); assert.equal(pushes.at(-1).body.to, 'Uadmin1');       // 店舗のトークンで送られる
    assert.equal((await call('/api/admin/security', { token: A })).json.line.linked, true);
    // ログイン: パスワードだけでは入れず、LINEにコードが届く
    const r1 = await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW } });
    assert.deepEqual([r1.json.requires2fa, r1.json.methods, r1.json.token], [true, ['line'], undefined]);
    assert.equal((await call('/api/admin/login/line-code', { method: 'POST', body: { email: 'a@x.jp', password: 'bad' } })).status, 400);
    assert.equal((await call('/api/admin/login/line-code', { method: 'POST', body: { email: 'a@x.jp', password: PW } })).status, 200);
    const code = /(\d{6})/.exec(pushes.at(-1).body.messages[0].text)[1];
    assert.equal(pushes.at(-1).body.to, 'Uadmin1');
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW, lineCode: code === '111111' ? '222222' : '111111' } })).status, 400);
    const ok = await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW, lineCode: code } });
    assert.equal(ok.status, 200); assert.ok(ok.json.token);
    // 運営者: システムの送信設定が無いので連携できない
    const O = (await call('/api/admin/login', { method: 'POST', body: { email: 'op@x.jp', password: PW } })).json.token;
    assert.equal((await call('/api/admin/security/line/start', { method: 'POST', token: O })).status, 400);
    // 解除
    assert.equal((await call('/api/admin/security/line/unlink', { method: 'POST', token: ok.json.token, body: { password: PW } })).status, 200);
    assert.ok((await call('/api/admin/login', { method: 'POST', body: { email: 'a@x.jp', password: PW } })).json.token);
  } finally { srv.closeAllConnections(); srv.close(); }
});
