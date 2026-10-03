// クーポン: 店舗管理者が作成し、メッセージ配信に添付して「届いた会員」に付与する。
// 会員は5分有効のQRを提示し、スタッフが読み取って使用済みにする(1人1回)。使用はテナント・会員・期限・付与を毎回検証する。
import { randomUUID, randomBytes } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const startOf = (d) => Date.parse(`${d}T00:00:00+09:00`), endOf = (d) => Date.parse(`${d}T23:59:59.999+09:00`); // 日付は日本時間で扱う
const validDay = (d) => DAY.test(d) && !Number.isNaN(startOf(d)) && new Date(startOf(d) + 9 * 3600_000).toISOString().slice(0, 10) === d;
export const fmtDay = (d) => (d ? d.replaceAll('-', '/') : null);
const CODE_TTL = 5 * 60_000;

function clean(input, { partial = false } = {}) {
  const out = {}, errors = [];
  const text = (k, label, max, required) => {
    if (input[k] === undefined) { if (!partial && required) errors.push(`${label}は必須です`); return; }
    const v = typeof input[k] === 'string' ? input[k].trim() : null;
    if (v === null || v.length > max || (required && !v)) { errors.push(`${label}は${required ? '1〜' : ''}${max}文字以内で入力してください`); return; }
    try { assertSafeText(v, label); } catch (e) { errors.push(e.message); return; }
    out[k] = v;
  };
  const day = (k, label) => {
    if (input[k] === undefined) return;
    if (input[k] === '' || input[k] === null) { out[k] = ''; return; }
    if (typeof input[k] !== 'string' || !validDay(input[k])) { errors.push(`${label}は YYYY-MM-DD の日付で指定してください`); return; }
    out[k] = input[k];
  };
  text('title', 'クーポン名', 40, true); text('benefit', '特典の内容', 60, false); text('description', '利用条件・説明', 300, false);
  day('valid_from', '利用開始日'); day('valid_until', '有効期限');
  if (out.valid_from && out.valid_until && out.valid_until < out.valid_from) errors.push('有効期限は、利用開始日以降にしてください');
  if (errors.length) throw new ValidationError('クーポンの入力内容に誤りがあります', errors);
  return out;
}

export class CouponService {
  constructor(store, vault) { this.store = store; this.vault = vault; this.used = new Map(); }

  #row(tenantId, id) {
    const c = this.store.find('coupons', (r) => r.tenant_id === tenantId && r.coupon_id === id);
    if (!c) throw new ValidationError('クーポンが存在しません');
    return c;
  }
  get(tenantId, id) { return this.#row(tenantId, id); }

  // 期限などから見たクーポン自体の状態
  window(c, now = Date.now()) {
    if (c.status === 'ARCHIVED') return 'archived';
    if (c.valid_from && now < startOf(c.valid_from)) return 'not_started';
    if (c.valid_until && now > endOf(c.valid_until)) return 'expired';
    return 'active';
  }
  // 会員から見た状態: 付与されていない / 使用済み / 利用可能 など
  state(c, memberId, now = Date.now()) {
    const granted = !!this.store.find('coupon_grants', (g) => g.tenant_id === c.tenant_id && g.coupon_id === c.coupon_id && g.member_id === memberId);
    if (!granted) return 'not_granted';
    if (this.store.find('coupon_redemptions', (r) => r.tenant_id === c.tenant_id && r.coupon_id === c.coupon_id && r.member_id === memberId)) return 'used';
    const w = this.window(c, now);
    return w === 'active' ? 'available' : w;
  }

  // ---- 管理 ----
  list(actor, tenantId) {
    require_(actor, 'COUPON_MANAGE', tenantId);
    const grants = this.store.select('coupon_grants', (g) => g.tenant_id === tenantId), reds = this.store.select('coupon_redemptions', (r) => r.tenant_id === tenantId);
    return this.store.select('coupons', (c) => c.tenant_id === tenantId).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((c) => ({ ...c, window: this.window(c), granted: grants.filter((g) => g.coupon_id === c.coupon_id).length, redeemed: reds.filter((r) => r.coupon_id === c.coupon_id).length }));
  }
  // スタッフ用: 使用できる(有効な)クーポンの一覧 (手入力での使用済み処理・配信の添付に使う)
  active(actor, tenantId) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    return this.store.select('coupons', (c) => c.tenant_id === tenantId && this.window(c) === 'active').map((c) => ({ coupon_id: c.coupon_id, title: c.title, benefit: c.benefit, valid_until: c.valid_until }));
  }
  create(actor, tenantId, input) {
    require_(actor, 'COUPON_MANAGE', tenantId);
    const v = clean(input ?? {});
    const row = { coupon_id: randomUUID().replace(/-/g, ''), tenant_id: tenantId, title: v.title, benefit: v.benefit ?? '', description: v.description ?? '', valid_from: v.valid_from ?? '', valid_until: v.valid_until ?? '',
      status: 'ACTIVE', created_by: actor.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.store.insert('coupons', row);
    audit(this.store, { tenant_id: tenantId, actor, action: 'COUPON_CREATE', target: row.coupon_id, detail: { title: row.title } });
    return row;
  }
  update(actor, tenantId, id, patch) {
    require_(actor, 'COUPON_MANAGE', tenantId);
    const cur = this.#row(tenantId, id), v = clean(patch ?? {}, { partial: true });
    const next = { ...cur, ...v };
    if (next.valid_from && next.valid_until && next.valid_until < next.valid_from) throw new ValidationError('有効期限は、利用開始日以降にしてください');
    this.store.update('coupons', (r) => r.tenant_id === tenantId && r.coupon_id === id, { ...v, updated_at: new Date().toISOString() });
    audit(this.store, { tenant_id: tenantId, actor, action: 'COUPON_UPDATE', target: id, detail: { fields: Object.keys(v) } });
    return this.#row(tenantId, id);
  }
  setStatus(actor, tenantId, id, status) {
    require_(actor, 'COUPON_MANAGE', tenantId);
    this.#row(tenantId, id);
    this.store.update('coupons', (r) => r.tenant_id === tenantId && r.coupon_id === id, { status, updated_at: new Date().toISOString() });
    audit(this.store, { tenant_id: tenantId, actor, action: status === 'ARCHIVED' ? 'COUPON_ARCHIVE' : 'COUPON_RESTORE', target: id });
  }

  // 配信に添付できるか (有効・期間内)
  assertOfferable(tenantId, id) {
    const c = this.#row(tenantId, id), w = this.window(c);
    if (w !== 'active') throw new ValidationError(w === 'expired' ? 'このクーポンは有効期限が過ぎています' : w === 'archived' ? 'このクーポンは終了しています' : 'このクーポンはまだ利用開始前です');
    return c;
  }
  // 配信が届いた会員にだけ付与 (同じ会員に重複して付与しない)
  grant(tenantId, couponId, memberIds, messageId = '') {
    const have = new Set(this.store.select('coupon_grants', (g) => g.tenant_id === tenantId && g.coupon_id === couponId).map((g) => g.member_id));
    let n = 0;
    for (const m of memberIds) if (!have.has(m)) { this.store.insert('coupon_grants', { coupon_id: couponId, tenant_id: tenantId, member_id: m, message_id: messageId, granted_at: new Date().toISOString() }); have.add(m); n++; }
    return n;
  }

  // ---- 会員向け ----
  memberList(tenantId, memberId) {
    const ids = this.store.select('coupon_grants', (g) => g.tenant_id === tenantId && g.member_id === memberId).map((g) => g.coupon_id);
    return ids.map((id) => this.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === id)).filter(Boolean)
      .map((c) => ({ coupon: this.#public(c), state: this.state(c, memberId) })).filter((x) => x.state !== 'archived');
  }
  memberCoupon(tenantId, memberId, id) {
    const c = this.#row(tenantId, id), state = this.state(c, memberId);
    if (state === 'not_granted') throw new ValidationError('このクーポンは、あなたには配布されていません');
    return { coupon: this.#public(c), state };
  }
  #public(c) { return { coupon_id: c.coupon_id, title: c.title, benefit: c.benefit, description: c.description, valid_from: c.valid_from, valid_until: c.valid_until }; }

  // 5分有効の使用コード(QR)。利用できる状態のときだけ発行
  issueRedeemCode(tenantId, memberId, id) {
    const c = this.#row(tenantId, id), state = this.state(c, memberId);
    if (state !== 'available') throw new ValidationError(STATE_MSG[state] ?? 'このクーポンは使えません');
    const exp = Date.now() + CODE_TTL;
    return { code: `MCP1.${this.vault.sign('coupon', { t: tenantId, m: memberId, c: id, e: exp, n: randomBytes(9).toString('base64url') })}`, expiresAt: exp };
  }

  // ---- 使用 (スタッフ) ----
  redeemByCode(actor, tenantId, code, members) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const p = typeof code === 'string' && code.startsWith('MCP1.') ? this.vault.verify('coupon', code.slice(5)) : null;
    if (!p || !(p.e > Date.now())) throw new ValidationError('クーポンのQRコードが無効か、期限切れです。会員に画面を更新してもらってください');
    if (p.t !== tenantId) throw new ValidationError('他店舗のクーポンです');
    for (const [n, e] of this.used) if (e < Date.now()) this.used.delete(n);
    if (this.used.has(p.n)) throw new ValidationError('このQRコードは使用済みです');
    const r = this.#redeem(actor, tenantId, p.c, p.m, 'QR', members);
    this.used.set(p.n, p.e);
    return r;
  }
  redeemManual(actor, tenantId, { couponId, memberNumber }, members) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const m = this.store.find('members', (x) => x.tenant_id === tenantId && x.member_number === String(memberNumber ?? '').trim() && x.status !== 'WITHDRAWN');
    if (!m) throw new ValidationError('その会員番号の有効な会員が見つかりません');
    return this.#redeem(actor, tenantId, couponId, m.member_id, 'MANUAL', members);
  }
  #redeem(actor, tenantId, couponId, memberId, method) {
    const c = this.#row(tenantId, couponId);
    const m = this.store.find('members', (x) => x.tenant_id === tenantId && x.member_id === memberId);
    if (!m || m.status === 'WITHDRAWN') throw new ValidationError('退会済みの会員です');
    const state = this.state(c, memberId);
    if (state !== 'available') throw new ValidationError(STATE_MSG[state] ?? 'このクーポンは使えません');
    this.store.insert('coupon_redemptions', { redemption_id: randomUUID(), coupon_id: couponId, tenant_id: tenantId, member_id: memberId, redeemed_at: new Date().toISOString(), recorded_by: actor.id, method });
    audit(this.store, { tenant_id: tenantId, actor, action: 'COUPON_REDEEM', target: couponId, detail: { member: m.member_number, method } });
    return { title: c.title, benefit: c.benefit, member_number: m.member_number };
  }
}
const STATE_MSG = { used: 'このクーポンは使用済みです', expired: 'このクーポンは有効期限が過ぎています', not_started: 'このクーポンはまだ利用開始前です', archived: 'このクーポンは終了しています', not_granted: 'このクーポンは、この会員には配布されていません' };
