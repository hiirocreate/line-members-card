// 管理者認証(パスワード+署名付きセッション)と LINE ID トークン検証
import { scryptSync, randomBytes, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { ValidationError } from './sanitize.js';
import { require_, ROLES } from './permissions.js';
import { audit } from './audit.js';

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
    role, grants, enabled: true, created_at: new Date().toISOString() };
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
export function login(store, { email, password, secret, limiter, ip = '' }) {
  const e = normEmail(email), key = `${e}|${ip}`;
  limiter?.check(key);
  const a = store.find('admins', (x) => x.email === e);
  const good = checkPassword(String(password ?? ''), a?.password_hash ?? DUMMY) && a?.enabled;
  if (!good) { limiter?.fail(key); throw new ValidationError('メールアドレスまたはパスワードが違います'); }
  limiter?.ok(key);
  const payload = Buffer.from(JSON.stringify({ sub: a.admin_id, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  audit(store, { tenant_id: a.tenant_id, actor: { id: a.admin_id }, action: 'ADMIN_LOGIN', target: a.admin_id });
  return `${payload}.${sign(payload, secret)}`;
}
// 毎回 admins を引く: 無効化・ロール変更が即時に反映される。tenantId は必ず DB の値を使う。
export function verifySession(store, token, secret) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload, secret)), given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  let s; try { s = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!(s.exp > Date.now())) return null;
  const a = store.find('admins', (x) => x.admin_id === s.sub);
  if (!a?.enabled) return null;
  return { id: a.admin_id, role: a.role, tenantId: a.tenant_id, grants: a.grants ?? [] };
}

// LINE ID トークン検証: aud(channel id) と有効期限は LINE 側で検証される。sub = LINE userId。
export async function verifyLineIdToken(idToken, channelId, fetchImpl = fetch) {
  if (!idToken || !channelId) throw new ValidationError('LINEの認証が必要です');
  const r = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: idToken, client_id: channelId }) });
  if (!r.ok) throw new ValidationError('LINEの認証に失敗しました');
  const j = await r.json();
  if (!j.sub || String(j.aud) !== String(channelId)) throw new ValidationError('LINEの認証に失敗しました');
  return j.sub;
}
