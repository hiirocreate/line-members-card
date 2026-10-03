// 管理者認証(パスワード+署名付きセッション)と LINE ID トークン検証
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash, randomUUID } from 'node:crypto';
import { ValidationError, AuthError } from './sanitize.js';
import { require_, ROLES, Forbidden } from './permissions.js';
import { audit } from './audit.js';
import { newSecret, verifyTotp, otpauthUri, newRecoveryCodes, hashRecovery } from './totp.js';

const SESSION_TTL_MS = 8 * 3600_000;
const hash = (pw, salt) => scryptSync(pw, salt, 64);

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${hash(pw, salt).toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, salt, h] = stored.split('$');
  const a = hash(pw, Buffer.from(salt, 'base64')), b = Buffer.from(h, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}
const DUMMY = hashPassword('dummy-password-for-timing');

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new ValidationError('パスワードは10文字以上にしてください');
}

// 運営管理者のみ: 店舗管理者/スタッフ/運営者アカウントを作成
export function createAdmin(store, actor, { tenantId, email, password, role, grants = [] }) {
  require_(actor, 'MASTER_EDIT', actor.tenantId);
  if (!Object.values(ROLES).includes(role)) throw new ValidationError('ロールが不正です');
  if (role !== ROLES.OPERATOR && !store.find('tenants', (t) => t.tenant_id === tenantId)) throw new ValidationError('店舗が存在しません');
  const e = normEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError('メールアドレスが不正です');
  if (store.find('admins', (a) => a.email === e)) throw new ValidationError('このメールアドレスは登録済みです');
  checkNewPassword(password);
  const row = { admin_id: randomUUID(), tenant_id: role === ROLES.OPERATOR ? null : tenantId, email: e, password_hash: hashPassword(password),
    role, grants, enabled: true, created_at: new Date().toISOString(),
    totp_secret: '', totp_pending: '', totp_enabled: false, recovery_codes: [], token_epoch: 0 };
  store.insert('admins', row);
  audit(store, { tenant_id: row.tenant_id, actor, action: 'ADMIN_CREATE', target: row.admin_id, detail: { email: e, role, grants } });
  return { admin_id: row.admin_id, email: e, role, tenant_id: row.tenant_id };
}
export function setAdminEnabled(store, actor, adminId, enabled) {
  require_(actor, 'MASTER_EDIT', actor.tenantId);
  store.update('admins', (a) => a.admin_id === adminId, { enabled });
  audit(store, { tenant_id: null, actor, action: enabled ? 'ADMIN_ENABLE' : 'ADMIN_DISABLE', target: adminId });
}
// 起動時: 運営管理者が1人もいなければ環境変数から作る
export function bootstrapOperator(store, email, password) {
  if (!email || !password || store.find('admins', (a) => a.role === ROLES.OPERATOR)) return false;
  createAdmin(store, { id: 'bootstrap', role: ROLES.OPERATOR, tenantId: null }, { email, password, role: ROLES.OPERATOR });
  return true;
}

export class LoginLimiter { // メール+IP単位で15分に5回まで失敗可
  constructor(max = 5, windowMs = 15 * 60_000) { Object.assign(this, { max, windowMs, m: new Map() }); }
  check(key) { const e = this.m.get(key); if (e && e.until > Date.now() && e.n >= this.max) throw new ValidationError('試行回数が上限に達しました。しばらくしてからお試しください'); }
  fail(key) { const e = this.m.get(key); const live = e && e.until > Date.now(); this.m.set(key, { n: live ? e.n + 1 : 1, until: live ? e.until : Date.now() + this.windowMs }); }
  ok(key) { this.m.delete(key); }
}

const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
const issueSession = (a, secret) => {
  const payload = Buffer.from(JSON.stringify({ sub: a.admin_id, ep: epochOf(a), exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
};
const epochOf = (a) => Number(a.token_epoch) || 0; // 空欄(旧データ)は0
const bumpEpoch = (store, a) => store.update('admins', (x) => x.admin_id === a.admin_id, { token_epoch: epochOf(a) + 1 });
const getAdmin = (store, id) => store.find('admins', (x) => x.admin_id === id);

// 二段階認証: 6桁コード または 回復コード(1回限り)
function checkSecondFactor(store, vault, a, code) {
  const c = String(code ?? '').trim();
  if (verifyTotp(vault.decrypt(a.totp_secret), c)) return true;
  const h = hashRecovery(c);
  if ((a.recovery_codes ?? []).includes(h)) {
    store.update('admins', (x) => x.admin_id === a.admin_id, { recovery_codes: a.recovery_codes.filter((x) => x !== h) });
    return true;
  }
  return false;
}

// 戻り値: { token } | { requires2fa: true }
export function login(store, { email, password, code, secret, limiter, ip = '', vault }) {
  const e = normEmail(email), key = `${e}|${ip}`;
  limiter?.check(key);
  const a = store.find('admins', (x) => x.email === e);
  const good = checkPassword(String(password ?? ''), a?.password_hash ?? DUMMY) && a?.enabled;
  if (!good) { limiter?.fail(key); throw new ValidationError('メールアドレスまたはパスワードが違います'); }
  if (a.totp_enabled) {
    if (!code) return { requires2fa: true };
    if (!checkSecondFactor(store, vault, a, code)) { limiter?.fail(key); throw new ValidationError('認証コードが正しくありません'); }
  }
  limiter?.ok(key);
  audit(store, { tenant_id: a.tenant_id, actor: { id: a.admin_id }, action: 'ADMIN_LOGIN', target: a.admin_id, detail: { mfa: !!a.totp_enabled } });
  return { token: issueSession(a, secret) };
}
// 毎回 admins を引く: 無効化・ロール変更・パスワード変更/リセットが即時に反映される。tenantId は必ず DB の値を使う。
export function verifySession(store, token, secret) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload, secret)), given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  let s; try { s = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!(s.exp > Date.now())) return null;
  const a = store.find('admins', (x) => x.admin_id === s.sub);
  if (!a?.enabled || (s.ep ?? 0) !== epochOf(a)) return null;
  return { id: a.admin_id, role: a.role, tenantId: a.tenant_id, grants: a.grants ?? [], email: a.email, totp: !!a.totp_enabled };
}

// ---- 自分のアカウント: パスワード変更 / 二段階認証 ----
export function changePassword(store, actor, { current, next, secret }) {
  const a = getAdmin(store, actor.id);
  if (!checkPassword(String(current ?? ''), a.password_hash)) throw new ValidationError('現在のパスワードが違います');
  checkNewPassword(next);
  store.update('admins', (x) => x.admin_id === a.admin_id, { password_hash: hashPassword(next) });
  bumpEpoch(store, a); // 他の端末のセッションは無効化
  audit(store, { tenant_id: a.tenant_id, actor, action: 'ADMIN_PASSWORD_CHANGE', target: a.admin_id });
  return issueSession(getAdmin(store, a.admin_id), secret);
}
export function setup2fa(store, vault, actor, { password }) {
  const a = getAdmin(store, actor.id);
  if (!checkPassword(String(password ?? ''), a.password_hash)) throw new ValidationError('パスワードが違います');
  if (a.totp_enabled) throw new ValidationError('二段階認証は既に有効です');
  const secret = newSecret();
  store.update('admins', (x) => x.admin_id === a.admin_id, { totp_pending: vault.encrypt(secret) });
  return { secret, uri: otpauthUri(secret, a.email) };
}
export function enable2fa(store, vault, actor, { code }) {
  const a = getAdmin(store, actor.id);
  if (!a.totp_pending) throw new ValidationError('先に二段階認証の設定を開始してください');
  const secret = vault.decrypt(a.totp_pending);
  if (!verifyTotp(secret, code)) throw new ValidationError('認証コードが正しくありません');
  const codes = newRecoveryCodes();
  store.update('admins', (x) => x.admin_id === a.admin_id, { totp_secret: vault.encrypt(secret), totp_pending: '', totp_enabled: true, recovery_codes: codes.map(hashRecovery) });
  audit(store, { tenant_id: a.tenant_id, actor, action: 'ADMIN_2FA_ENABLE', target: a.admin_id });
  return { recoveryCodes: codes }; // 平文は一度だけ表示
}
export function disable2fa(store, vault, actor, { password, code }) {
  const a = getAdmin(store, actor.id);
  if (!a.totp_enabled) throw new ValidationError('二段階認証は無効です');
  if (!checkPassword(String(password ?? ''), a.password_hash)) throw new ValidationError('パスワードが違います');
  if (!checkSecondFactor(store, vault, a, code)) throw new ValidationError('認証コードが正しくありません');
  store.update('admins', (x) => x.admin_id === a.admin_id, { totp_secret: '', totp_pending: '', totp_enabled: false, recovery_codes: [] });
  audit(store, { tenant_id: a.tenant_id, actor, action: 'ADMIN_2FA_DISABLE', target: a.admin_id });
}

// ---- 他の管理者の操作 (運営=全員 / 店舗管理者=自店舗のスタッフ) ----
function manageable(store, actor, targetId) {
  const t = getAdmin(store, targetId);
  if (!t) throw new ValidationError('管理者が存在しません');
  const ok = actor.role === ROLES.OPERATOR || (actor.role === ROLES.STORE_ADMIN && t.role === ROLES.STAFF && t.tenant_id === actor.tenantId);
  if (!ok) throw new Forbidden('この管理者は操作できません');
  return t;
}
export function listAdmins(store, actor) {
  if (actor.role === ROLES.STAFF) throw new Forbidden('権限がありません');
  return store.select('admins', (a) => actor.role === ROLES.OPERATOR || a.tenant_id === actor.tenantId)
    .map(({ admin_id, tenant_id, email, role, enabled, totp_enabled }) => ({ admin_id, tenant_id, email, role, enabled, totp_enabled: !!totp_enabled }));
}
export function resetTwoFactor(store, actor, targetId) {
  const t = manageable(store, actor, targetId);
  store.update('admins', (x) => x.admin_id === t.admin_id, { totp_secret: '', totp_pending: '', totp_enabled: false, recovery_codes: [] });
  bumpEpoch(store, t);
  audit(store, { tenant_id: t.tenant_id, actor, action: 'ADMIN_2FA_RESET', target: t.admin_id });
}
// メール送信基盤が無いため、パスワード再設定は「発行者が本人へ安全な方法で URL を渡す」方式 (1時間・1回限り)
export function issueResetToken(store, actor, targetId) {
  const t = manageable(store, actor, targetId);
  store.update('password_resets', (r) => r.admin_id === t.admin_id && !r.used, { used: true });
  const token = randomBytes(32).toString('base64url');
  store.insert('password_resets', { token_hash: createHash('sha256').update(token).digest('hex'), admin_id: t.admin_id, expires_at: Date.now() + 3600_000, used: false, created_by: actor.id, created_at: new Date().toISOString() });
  audit(store, { tenant_id: t.tenant_id, actor, action: 'ADMIN_RESET_ISSUE', target: t.admin_id });
  return { token, expiresInMinutes: 60 };
}
export function consumeResetToken(store, { token, password }) {
  const h = createHash('sha256').update(String(token ?? '')).digest('hex');
  const r = store.find('password_resets', (x) => x.token_hash === h && !x.used && x.expires_at > Date.now());
  if (!r) throw new ValidationError('再設定リンクが無効か、期限切れです');
  checkNewPassword(password);
  const a = getAdmin(store, r.admin_id);
  store.update('admins', (x) => x.admin_id === a.admin_id, { password_hash: hashPassword(password) });
  bumpEpoch(store, a);
  store.update('password_resets', (x) => x.token_hash === h, { used: true });
  audit(store, { tenant_id: a.tenant_id, actor: { id: a.admin_id }, action: 'ADMIN_PASSWORD_RESET', target: a.admin_id });
}

// LINE ID トークン検証: aud(channel id) と有効期限は LINE 側で検証される。sub = LINE userId。
export async function verifyLineIdToken(idToken, channelId, fetchImpl = fetch) {
  if (!idToken) throw new AuthError('LINEの認証が必要です');
  if (!channelId) throw new ValidationError('この店舗のLINEログインチャネルIDが未設定です');
  const r = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: idToken, client_id: channelId }) });
  if (!r.ok) throw new AuthError('LINEの認証に失敗しました。もう一度ログインしてください');
  const j = await r.json();
  if (!j.sub || String(j.aud) !== String(channelId)) throw new AuthError('LINEの認証に失敗しました');
  return j.sub;
}
