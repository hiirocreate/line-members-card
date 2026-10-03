// 来店回数トリガーの配信ルール。「N回目の来店」(または「N回ごと」)でメッセージ・クーポンを自動送信する。
// 来店が記録された直後(QRスキャン/手動記録)に判定。同じ会員・同じ来店回数には1回しか送らない。
import { randomUUID } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { resolveLine } from './settings.js';
import { push, couponFlex } from './line.js';
import { parseDays } from './coupons.js';
import { jstParts } from './dates.js';
import { featureOn } from './features.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = (ms) => { const p = jstParts(ms); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const isOn = (v) => v === true || v === 'TRUE';

export class VisitRuleService {
  constructor(store, vault, members, coupons, fetchImpl = fetch) { Object.assign(this, { store, vault, members, coupons, fetchImpl }); }

  #row(tenantId, id) {
    const r = this.store.find('visit_rules', (x) => x.tenant_id === tenantId && x.rule_id === id);
    if (!r) throw new ValidationError('ルールが存在しません');
    return r;
  }
  #clean(tenantId, input) {
    const errors = [], v = {};
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 40) errors.push('ルール名は1〜40文字で入力してください');
    const visits = Number(input.visits);
    if (!Number.isInteger(visits) || visits < 1 || visits > 1000) errors.push('来店回数は1〜1000の整数で指定してください');
    const text = typeof input.message_text === 'string' ? input.message_text.trim() : '';
    if (text.length > 1000) errors.push('メッセージは1000文字以内です');
    try { assertSafeText(name, 'ルール名'); assertSafeText(text, 'メッセージ'); } catch (e) { errors.push(e.message); }
    const coupon_id = input.coupon_id || '';
    if (coupon_id && !this.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === coupon_id)) errors.push('クーポンが存在しません');
    if (!text && !coupon_id) errors.push('メッセージかクーポンのどちらかを設定してください');
    let coupon_days = null;
    try { coupon_days = parseDays(input.coupon_days); } catch (e) { errors.push(e.message); }
    const from = input.valid_from || '', until = input.valid_until || '';
    for (const [d, l] of [[from, '開始日'], [until, '終了日']]) if (d && (!DAY.test(d) || Number.isNaN(Date.parse(d)))) errors.push(`${l}は YYYY-MM-DD の日付で指定してください`);
    if (from && until && until < from) errors.push('終了日は開始日以降にしてください');
    if (errors.length) throw new ValidationError('ルールの入力内容に誤りがあります', errors);
    Object.assign(v, { name, visits, repeat: !!input.repeat, message_text: text, coupon_id, coupon_days: coupon_days ?? '', valid_from: from, valid_until: until, enabled: input.enabled !== false });
    return v;
  }

  list(actor, tenantId) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const sends = this.store.select('visit_rule_sends', (s) => s.tenant_id === tenantId);
    return this.store.select('visit_rules', (r) => r.tenant_id === tenantId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((r) => ({ ...r, enabled: isOn(r.enabled), repeat: isOn(r.repeat), sent: sends.filter((s) => s.rule_id === r.rule_id && s.status === 'SENT').length, failed: sends.filter((s) => s.rule_id === r.rule_id && s.status === 'FAILED').length }));
  }
  create(actor, tenantId, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const row = { rule_id: randomUUID().replace(/-/g, ''), tenant_id: tenantId, ...this.#clean(tenantId, input ?? {}), created_by: actor.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.store.insert('visit_rules', row);
    audit(this.store, { tenant_id: tenantId, actor, action: 'VISIT_RULE_CREATE', target: row.rule_id, detail: { name: row.name, visits: row.visits } });
    return row;
  }
  update(actor, tenantId, id, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const cur = this.#row(tenantId, id);
    const v = this.#clean(tenantId, { ...cur, enabled: isOn(cur.enabled), repeat: isOn(cur.repeat), ...input });
    this.store.update('visit_rules', (r) => r.tenant_id === tenantId && r.rule_id === id, { ...v, updated_at: new Date().toISOString() });
    audit(this.store, { tenant_id: tenantId, actor, action: 'VISIT_RULE_UPDATE', target: id, detail: { enabled: v.enabled } });
    return this.#row(tenantId, id);
  }
  remove(actor, tenantId, id) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    this.#row(tenantId, id);
    this.store.remove('visit_rules', (r) => r.tenant_id === tenantId && r.rule_id === id);
    audit(this.store, { tenant_id: tenantId, actor, action: 'VISIT_RULE_DELETE', target: id });
  }

  // 来店が記録された直後に呼ぶ。失敗しても来店の記録には影響させない。戻り値: 送った特典の一覧
  async onVisit(tenantId, memberId, nowMs = Date.now()) {
    const out = [];
    try {
      if (!featureOn(this.store, tenantId, 'visitrules')) return out;
      const m = this.store.find('members', (x) => x.tenant_id === tenantId && x.member_id === memberId);
      if (!m || (m.status || 'ACTIVE') !== 'ACTIVE') return out;
      const count = Number(m.visit_count) || 0, day = today(nowMs);
      const rules = this.store.select('visit_rules', (r) => r.tenant_id === tenantId && isOn(r.enabled)
        && (isOn(r.repeat) ? count % Number(r.visits) === 0 : count === Number(r.visits)) && (!r.valid_from || day >= r.valid_from) && (!r.valid_until || day <= r.valid_until));
      for (const r of rules) {
        if (this.store.find('visit_rule_sends', (s) => s.rule_id === r.rule_id && s.member_id === memberId && Number(s.visit_count) === count)) continue;
        const status = await this.#fire(tenantId, r, m, count, nowMs);
        this.store.insert('visit_rule_sends', { rule_id: r.rule_id, tenant_id: tenantId, member_id: memberId, visit_count: count, sent_at: new Date(nowMs).toISOString(), status: status.status, coupon_granted: status.granted > 0 });
        audit(this.store, { tenant_id: tenantId, actor: { id: 'system' }, action: 'VISIT_RULE_FIRE', target: r.rule_id, detail: { member: m.member_number, visits: count, status: status.status } });
        out.push({ rule: r.name, status: status.status });
      }
    } catch (e) { console.error('visit rule error', e); }
    return out;
  }
  async #fire(tenantId, r, m, count, nowMs) {
    const consented = this.store.find('member_consents', (c) => c.tenant_id === tenantId && c.member_id === m.member_id && c.channel === 'LINE' && c.granted);
    const prefs = this.members.prefsOf(m);
    if (!consented || !prefs[r.coupon_id ? 'coupon' : 'news']) return { status: 'SKIPPED', granted: 0 }; // 配信に同意していない/断っている会員には送らない
    const { messagingToken } = resolveLine(this.store, this.vault, tenantId);
    if (!messagingToken) return { status: 'FAILED', granted: 0 };
    const messages = [], text = r.message_text.replaceAll('{名前}', this.members.cardName(tenantId, m) || 'お客').replaceAll('{回数}', String(count));
    if (text) messages.push({ type: 'text', text });
    const days = r.coupon_days ? Number(r.coupon_days) : null;
    let coupon = null;
    if (r.coupon_id) {
      try { coupon = this.coupons.assertOfferable(tenantId, r.coupon_id); } catch { return { status: 'FAILED', granted: 0 }; } // 期限切れ・終了したクーポンは付けられない
      const url = this.couponUrl?.({ id: 'system', role: 'OPERATOR' }, tenantId, coupon.coupon_id);
      if (!url) return { status: 'FAILED', granted: 0 };
      messages.push(couponFlex({ shop: this.store.find('tenants', (t) => t.tenant_id === tenantId)?.name ?? '', coupon, url, untilText: this.coupons.untilText(coupon, nowMs, days) }));
    }
    try { await push(messagingToken, m.user_id, messages, this.fetchImpl); } catch { return { status: 'FAILED', granted: 0 }; }
    return { status: 'SENT', granted: coupon ? this.coupons.grant(tenantId, coupon.coupon_id, [m.member_id], `visit:${r.rule_id}`, days) : 0 };
  }
}
