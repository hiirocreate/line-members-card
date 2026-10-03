// WebAuthn (パスキー) のサーバ側検証。attestation は 'none' のみ扱い、ES256 / RS256 に対応する。
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeCbor } from './cbor.js';
import { ValidationError, AuthError } from './sanitize.js';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
const CHALLENGE_TTL_MS = 5 * 60_000;
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

// チャレンジは署名付きトークン(用途 'webauthn')。使い捨てにするため、検証済みの nonce を記憶する。
const used = new Map();
export function issueChallenge(vault, { type, adminId }) {
  const c = b64u(randomBytes(32));
  return { challenge: c, token: vault.sign('webauthn', { c, a: adminId, t: type, e: Date.now() + CHALLENGE_TTL_MS }) };
}
function consumeChallenge(vault, token, { type, adminId }) {
  const p = vault.verify('webauthn', token);
  if (!p || p.t !== type || p.a !== adminId || !(p.e > Date.now())) throw new AuthError('認証の有効期限が切れました。もう一度やり直してください');
  for (const [k, e] of used) if (e < Date.now()) used.delete(k);
  if (used.has(p.c)) throw new AuthError('この認証は使用済みです。もう一度やり直してください');
  used.set(p.c, p.e);
  return p.c;
}

function parseClientData(json, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')); } catch { throw new ValidationError('認証データが不正です'); }
  if (cd.type !== type) throw new ValidationError('認証の種類が一致しません');
  if (cd.challenge !== challenge) throw new ValidationError('認証のチャレンジが一致しません');
  if (cd.origin !== origin) throw new ValidationError('認証元のURLが一致しません。登録したときと同じURLで操作してください');
  return cd;
}
function parseAuthData(ad, rpId, { needUv = false } = {}) {
  if (ad.length < 37) throw new ValidationError('認証データが不正です');
  const rpIdHash = ad.subarray(0, 32), flags = ad[32], signCount = ad.readUInt32BE(33);
  if (!timingSafeEqual(rpIdHash, sha256(rpId))) throw new ValidationError('認証先のドメインが一致しません');
  if (!(flags & FLAG_UP)) throw new ValidationError('端末での確認(タッチ・生体認証)が行われていません');
  if (needUv && !(flags & FLAG_UV)) throw new ValidationError('本人確認(指紋・顔・画面ロック)が必要です');
  return { flags, signCount };
}

// ---- 登録 ----
export function creationOptions(vault, { admin, rpId, rpName = '会員管理', existing = [] }) {
  const { challenge, token } = issueChallenge(vault, { type: 'create', adminId: admin.admin_id });
  return {
    token,
    publicKey: {
      challenge, rp: { id: rpId, name: rpName },
      user: { id: b64u(Buffer.from(admin.admin_id)), name: admin.email, displayName: admin.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none', timeout: 60_000,
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports ?? [] })),
    },
  };
}
export function verifyRegistration(vault, { admin, token, credential, origin, rpId }) {
  const challenge = consumeChallenge(vault, token, { type: 'create', adminId: admin.admin_id });
  const r = credential?.response ?? {};
  parseClientData(r.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  let att;
  try { att = decodeCbor(Buffer.from(r.attestationObject, 'base64url')).value; } catch { throw new ValidationError('登録データが不正です'); }
  const authData = att.get?.('authData');
  if (!Buffer.isBuffer(authData)) throw new ValidationError('登録データが不正です');
  const { flags, signCount } = parseAuthData(authData, rpId);
  if (!(flags & FLAG_AT) || authData.length < 55) throw new ValidationError('公開鍵が含まれていません');
  const idLen = authData.readUInt16BE(53);
  const credId = authData.subarray(55, 55 + idLen);
  if (!idLen || credId.length !== idLen) throw new ValidationError('登録データが不正です');
  if (b64u(credId) !== credential.id) throw new ValidationError('認証器のIDが一致しません');
  let cose;
  try { cose = decodeCbor(authData, 55 + idLen).value; } catch { throw new ValidationError('公開鍵が不正です'); }
  const jwk = coseToJwk(cose);
  createPublicKey({ key: jwk, format: 'jwk' }); // 鍵として有効か検証 (不正なら例外)
  return { credential_id: credential.id, public_key: jwk, alg: cose.get(3), sign_count: signCount, transports: Array.isArray(credential.transports) ? credential.transports.filter((t) => typeof t === 'string').slice(0, 6) : [] };
}
function coseToJwk(c) {
  if (!(c instanceof Map)) throw new ValidationError('公開鍵が不正です');
  const kty = c.get(1), alg = c.get(3);
  if (kty === 2 && alg === -7 && c.get(-1) === 1 && Buffer.isBuffer(c.get(-2)) && Buffer.isBuffer(c.get(-3))) {
    return { kty: 'EC', crv: 'P-256', x: b64u(c.get(-2)), y: b64u(c.get(-3)) };
  }
  if (kty === 3 && alg === -257 && Buffer.isBuffer(c.get(-1)) && Buffer.isBuffer(c.get(-2))) {
    return { kty: 'RSA', n: b64u(c.get(-1)), e: b64u(c.get(-2)) };
  }
  throw new ValidationError('未対応の鍵の種類です(ES256 / RS256 のみ)');
}

// ---- ログイン(アサーション) ----
export function requestOptions(vault, { admin, rpId, credentials }) {
  const { challenge, token } = issueChallenge(vault, { type: 'get', adminId: admin.admin_id });
  return { token, publicKey: { challenge, rpId, timeout: 60_000, userVerification: 'preferred',
    allowCredentials: credentials.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports ?? [] })) } };
}
// 戻り値: { credential_id, sign_count } (呼び出し側で保存する)
export function verifyAssertion(vault, { admin, token, assertion, credentials, origin, rpId }) {
  const challenge = consumeChallenge(vault, token, { type: 'get', adminId: admin.admin_id });
  const stored = credentials.find((c) => c.credential_id === assertion?.id);
  if (!stored) throw new ValidationError('このパスキーは登録されていません');
  const r = assertion.response ?? {};
  parseClientData(r.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authData = Buffer.from(r.authenticatorData ?? '', 'base64url');
  const { signCount } = parseAuthData(authData, rpId);
  const data = Buffer.concat([authData, sha256(Buffer.from(r.clientDataJSON, 'base64url'))]);
  const key = createPublicKey({ key: stored.public_key, format: 'jwk' });
  const sig = Buffer.from(r.signature ?? '', 'base64url');
  const ok = stored.alg === -7 ? cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig) : cryptoVerify('sha256', data, key, sig);
  if (!ok) throw new ValidationError('パスキーの署名が正しくありません');
  // カウンタが戻っていたら複製の疑い (どちらも0の認証器はカウンタ非対応なので許可)
  if ((signCount || stored.sign_count) && signCount <= stored.sign_count) throw new ValidationError('パスキーの使用回数が不正です(複製の可能性)');
  return { credential_id: stored.credential_id, sign_count: signCount };
}
