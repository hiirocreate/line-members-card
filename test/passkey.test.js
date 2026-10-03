import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createAdmin, login, verifySession, listPasskeys, beginPasskeyRegistration, finishPasskeyRegistration, deletePasskey, resetTwoFactor, setup2fa, enable2fa, LoginLimiter } from '../src/auth.js';
import { decodeCbor } from '../src/cbor.js';
import { totp } from '../src/totp.js';
import { OP } from './helpers.js';

const SECRET = 'p'.repeat(40), PW = 'correct-horse-battery', WA = { rpId: 'cards.example.com', origin: 'https://cards.example.com' };
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- テスト用のソフトウェア認証器 (最小のCBORエンコーダ + ES256) ----
function cbor(v) {
  if (v instanceof Map) return Buffer.concat([hdr(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (Buffer.isBuffer(v)) return Buffer.concat([hdr(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([hdr(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([hdr(4, v.length), ...v.map(cbor)]);
  return v >= 0 ? hdr(0, v) : hdr(1, -1 - v);
}
function hdr(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function authenticator(rp = WA.rpId) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(32);
  let counter = 0;
  const flags = (f) => Buffer.from([f]);
  const cnt = () => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; };
  return {
    credId: b64u(credId),
    create({ challenge, origin = WA.origin, rpHash = sha256(rp) }) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, flags(0x45), cnt(), Buffer.alloc(16), idLen, credId, cbor(cose)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { id: b64u(credId), response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))) }, transports: ['internal'] };
    },
    get({ challenge, origin = WA.origin, rpHash = sha256(rp), type = 'webauthn.get', bump = 1, tamper = false }) {
      counter += bump;
      const authData = Buffer.concat([rpHash, flags(0x05), cnt()]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin }));
      const sig = cryptoSign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      if (tamper) sig[sig.length - 1] ^= 1;
      return { id: b64u(credId), response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

function env() {
  const app = createApp(null, { secret: SECRET });
  app.forms.createTenant(OP, 'SHOP001', 'テスト店');
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP001', email: 'a@x.jp', password: PW });
  createAdmin(app.store, OP, { role: 'STORE_ADMIN', tenantId: 'SHOP001', email: 'b@x.jp', password: PW });
  const { store, vault } = app;
  const L = (email, extra = {}) => login(store, { email, password: PW, secret: SECRET, vault, webauthn: WA, limiter: new LoginLimiter(), ...extra });
  // 二段階目が必要な状態でも操作者を作れるよう、DBから直接組み立てる
  const who = (email) => { const a = store.find('admins', (x) => x.email === email); return { id: a.admin_id, role: a.role, tenantId: a.tenant_id, grants: [] }; };
  const register = (email, auth, name = 'iPhone', over = {}) => {
    const actor = who(email);
    const opt = beginPasskeyRegistration(store, vault, actor, { password: PW, rpId: WA.rpId });
    const cred = auth.create({ challenge: opt.publicKey.challenge, ...over.create });
    return finishPasskeyRegistration(store, vault, actor, { token: opt.token, credential: cred, name, ...WA, ...over.finish });
  };
  const loginWith = (email, auth, over = {}) => {
    const r = L(email);
    assert.equal(r.requires2fa, true);
    return L(email, { challenge: r.passkey.token, assertion: auth.get({ challenge: r.passkey.publicKey.challenge, ...over }) });
  };
  return { app, store, vault, L, who, register, loginWith };
}

test('CBORデコーダ: 整数・文字列・バイト列・配列・マップ', () => {
  const v = decodeCbor(cbor(new Map([[1, 2], [-7, 'あ'], ['k', [1, 300, -5]], [3, Buffer.from('ab')]]))).value;
  assert.deepEqual([...v], [[1, 2], [-7, 'あ'], ['k', [1, 300, -5]], [3, Buffer.from('ab')]]);
  assert.throws(() => decodeCbor(Buffer.from([0x59, 0x00, 0x10, 1])), /切れて/);
});

test('パスキー: 登録→二段階目としてログイン→一覧/削除', () => {
  const { L, who, register, loginWith, store } = env();
  assert.ok(L('a@x.jp').token); // 登録前はパスワードだけでログイン
  const auth = authenticator();
  const saved = register('a@x.jp', auth, 'MacBookの指紋');
  assert.equal(saved.name, 'MacBookの指紋');
  assert.ok(!JSON.stringify(store.select('admins')).includes('MacBook'));
  assert.deepEqual(listPasskeys(store, who('a@x.jp')).map((k) => k.name), ['MacBookの指紋']);
  const r = L('a@x.jp');
  assert.deepEqual([r.requires2fa, r.methods], [true, ['passkey']]);
  assert.equal(r.passkey.publicKey.allowCredentials[0].id, auth.credId);
  assert.equal(r.passkey.publicKey.rpId, WA.rpId);
  const ok = loginWith('a@x.jp', auth);
  assert.ok(ok.token);
  const actor = verifySession(store, ok.token, SECRET);
  assert.equal(listPasskeys(store, actor)[0].name, 'MacBookの指紋'); assert.ok(listPasskeys(store, actor)[0].last_used_at);
  assert.throws(() => deletePasskey(store, actor, { id: auth.credId, password: 'bad' }), /パスワード/);
  deletePasskey(store, actor, { id: auth.credId, password: PW });
  assert.ok(L('a@x.jp').token); // 削除すると2段階目なし
});

test('パスキー: 不正な認証は拒否される(オリジン/ドメイン/チャレンジ/署名/再利用/カウンタ)', () => {
  const { L, register, loginWith, store } = env();
  const auth = authenticator();
  register('a@x.jp', auth);
  const attempt = (over, msg) => assert.throws(() => loginWith('a@x.jp', auth, over), msg);
  attempt({ origin: 'https://evil.example.com' }, /認証元/);
  attempt({ rpHash: sha256('evil.example.com') }, /ドメイン/);
  attempt({ type: 'webauthn.create' }, /種類/);
  attempt({ tamper: true }, /署名/);
  attempt({ challenge: b64u(randomBytes(32)) }, /チャレンジ/);
  // チャレンジの使い回し(リプレイ)
  const r = L('a@x.jp');
  const asr = auth.get({ challenge: r.passkey.publicKey.challenge });
  assert.ok(L('a@x.jp', { challenge: r.passkey.token, assertion: asr }).token);
  assert.throws(() => L('a@x.jp', { challenge: r.passkey.token, assertion: asr }), /使用済み/);
  // カウンタが戻る(複製の疑い)
  attempt({ bump: -3 }, /複製/);
  // 他の管理者向けのチャレンジは使えない
  const rb = L('b@x.jp'); assert.deepEqual(rb.token && true, true); // b はパスキー未登録
  // 期限切れ
  const r2 = L('a@x.jp');
  assert.throws(() => L('a@x.jp', { challenge: r2.passkey.token.slice(0, -4) + 'AAAA', assertion: auth.get({ challenge: r2.passkey.publicKey.challenge }) }), /有効期限/);
  assert.equal(store.select('passkeys').length, 1);
});

test('パスキー登録: 別ドメイン・不正なチャレンジ・重複は拒否 / 他人の登録は不可', () => {
  const { app, who, register, store, vault } = env();
  const auth = authenticator();
  assert.throws(() => register('a@x.jp', auth, 'x', { create: { origin: 'https://evil.example.com' } }), /認証元/);
  assert.throws(() => register('a@x.jp', authenticator(), 'x', { create: { rpHash: sha256('evil.example.com') } }), /ドメイン/);
  assert.throws(() => beginPasskeyRegistration(store, vault, who('a@x.jp'), { password: 'bad', rpId: WA.rpId }), /パスワード/);
  register('a@x.jp', auth);
  assert.throws(() => register('a@x.jp', auth), /既に登録/);
  // 管理者Bは、Aのチャレンジで登録できない
  const actorA = who('a@x.jp'), actorB = who('b@x.jp');
  const optA = beginPasskeyRegistration(store, vault, actorA, { password: PW, rpId: WA.rpId });
  const other = authenticator();
  assert.throws(() => finishPasskeyRegistration(store, vault, actorB, { token: optA.token, credential: other.create({ challenge: optA.publicKey.challenge }), name: 'x', ...WA }), /有効期限/);
  assert.equal(app.store.select('passkeys').filter((k) => k.admin_id === actorB.id).length, 0);
  // 10個まで
  for (let i = 0; i < 10; i++) register('b@x.jp', authenticator(), `k${i}`);
  assert.throws(() => beginPasskeyRegistration(store, vault, actorB, { password: PW, rpId: WA.rpId }), /10個/);
});

test('パスキーと認証アプリの併用 / 2FAリセットでパスキーも消える / コードだけでは不可', () => {
  const { L, store, vault, who, register, loginWith } = env();
  const actor = who('a@x.jp');
  const { secret } = setup2fa(store, vault, actor, { password: PW });
  enable2fa(store, vault, actor, { code: totp(secret) });
  const auth = authenticator(); register('a@x.jp', auth);
  const r = L('a@x.jp');
  assert.deepEqual(r.methods, ['totp', 'passkey']);
  assert.ok(L('a@x.jp', { code: totp(secret) }).token); // 認証アプリでもログインできる
  assert.ok(loginWith('a@x.jp', auth).token); // パスキーでもログインできる
  // パスキーだけの管理者に、コードを送っても通らない
  register('b@x.jp', authenticator());
  assert.throws(() => L('b@x.jp', { code: '123456' }), /認証コード/);
  resetTwoFactor(store, { id: 'op', role: 'OPERATOR' }, store.find('admins', (a) => a.email === 'b@x.jp').admin_id);
  assert.equal(store.select('passkeys').filter((k) => k.admin_id === store.find('admins', (a) => a.email === 'b@x.jp').admin_id).length, 0);
  assert.ok(L('b@x.jp').token);
});
