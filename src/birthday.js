// 誕生日メッセージ/クーポン。誕生日が「N日以内」に入った会員へ、1年に1回だけ自動で送る。
// 対象: 有効な会員 かつ LINE配信に同意 かつ 今年(その誕生日の年)まだ送っていない会員。
// 毎日1回、Cloud Scheduler が POST /api/cron/birthday を呼ぶ想定。管理画面からの手動実行もできる。
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { resolveLine } from './settings.js';
import { push, couponFlex } from './line.js';

const CAP = 200; // 1回の実行で送る最大人数 (超えた分は翌日に回る)
export const DEFAULT_TEXT = '{名前}さん、お誕生日おめでとうございます🎂\nいつもご利用ありがとうございます。ささやかですが、お祝いの気持ちをお届けします。';
const SYSTEM = { id: 'system', role: 'OPERATOR' }; // 自動実行用(店舗の設定に従って送るだけ)

export class BirthdayService {
  constructor(store, vault, members, coupons, fetchImpl = fetch) { Object.assign(this, { store, vault, members, coupons, fetchImpl }); this.running = new Set(); }

  #row(tenantId) { return this.store.find('birthday_campaigns', (r) => r.tenant_id === tenantId); }
  get(actor, tenantId) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const r = this.#row(tenantId);
    return { enabled: r?.enabled === true || r?.enabled === 'TRUE', days_before: Number(r?.days_before ?? 7), message_text: r?.message_text ?? DEFAULT_TEXT, coupon_id: r?.coupon_id ?? '',
      last_run_at: r?.last_run_at ?? '', last_result: r?.last_result || null, hasBirthdayField: !!this.members.forms.fields(tenantId).find((f) => f.master_key === 'birthday') };
  }
  save(actor, tenantId, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const days = Number(input.days_before), text = typeof input.message_text === 'string' ? input.message_text.trim() : '', coupon_id = input.coupon_id || '';
    const errors = [];
    if (!Number.isInteger(days) || days < 0 || days > 60) errors.push('「何日前から送るか」は0〜60の整数で指定してください');
    if (text.length > 1000) errors.push('メッセージは1000文字以内です');
    try { assertSafeText(text, 'メッセージ'); } catch (e) { errors.push(e.message); }
    if (coupon_id && !this.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === coupon_id)) errors.push('クーポンが存在しません');
    if (input.enabled && !text && !coupon_id) errors.push('メッセージかクーポンのどちらかを設定してください');
    if (errors.length) throw new ValidationError('誕生日配信の入力内容に誤りがあります', errors);
    const patch = { enabled: !!input.enabled, days_before: days, message_text: text, coupon_id, updated_at: new Date().toISOString(), updated_by: actor.id };
    if (this.#row(tenantId)) this.store.update('birthday_campaigns', (r) => r.tenant_id === tenantId, patch);
    else this.store.insert('birthday_campaigns', { tenant_id: tenantId, last_run_at: '', last_result: '', ...patch });
    audit(this.store, { tenant_id: tenantId, actor, action: 'BIRTHDAY_SETTINGS', detail: { enabled: patch.enabled, days_before: days, coupon: coupon_id || null } });
    return this.get(actor, tenantId);
  }

  // 送信対象の内訳
  #plan(tenantId, days, nowMs) {
    const cands = this.members.birthdayCandidates(tenantId, days, nowMs);
    const consented = new Set(this.store.select('member_consents', (c) => c.tenant_id === tenantId && c.channel === 'LINE' && c.granted).map((c) => c.member_id));
    const sent = new Set(this.store.select('birthday_sends', (s) => s.tenant_id === tenantId).map((s) => `${s.member_id}:${s.year}`));
    const targets = [], skipped = { notConsented: 0, alreadySent: 0 };
    // (誕生日のお知らせを断っている会員は「未同意」として数える)
    for (const c of cands) {
      if (sent.has(`${c.m.member_id}:${c.year}`)) skipped.alreadySent++;
      else if (!consented.has(c.m.member_id) || !this.members.prefsOf(c.m).birthday) skipped.notConsented++;
      else targets.push(c);
    }
    return { matched: cands.length, targets, skipped };
  }
  preview(actor, tenantId, days = this.get(actor, tenantId).days_before, nowMs = Date.now()) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const p = this.#plan(tenantId, days, nowMs);
    return { matched: p.matched, willSend: Math.min(p.targets.length, CAP), skipped: p.skipped };
  }

  async run(actor, tenantId, { nowMs = Date.now(), force = false } = {}) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    return this.#run(actor, tenantId, nowMs, force);
  }
  // 全店舗(有効なもの)を実行 — Cloud Scheduler 用
  async runAll(nowMs = Date.now()) {
    const out = [];
    for (const c of this.store.select('birthday_campaigns', (r) => r.enabled === true || r.enabled === 'TRUE')) {
      try { out.push({ tenant_id: c.tenant_id, ...(await this.#run(SYSTEM, c.tenant_id, nowMs, false)) }); } catch (e) { out.push({ tenant_id: c.tenant_id, error: e.message }); }
    }
    return out;
  }

  async #run(actor, tenantId, nowMs, force) {
    const cfg = this.get(SYSTEM, tenantId);
    if (!cfg.enabled && !force) throw new ValidationError('誕生日配信がオフです');
    if (this.running.has(tenantId)) throw new ValidationError('実行中です');
    this.running.add(tenantId);
    try {
      const fail = (message) => { this.#record(tenantId, nowMs, { error: message }); throw new ValidationError(message); };
      const { messagingToken } = resolveLine(this.store, this.vault, tenantId);
      if (!messagingToken) fail('LINE設定でチャネルアクセストークンを登録してください');
      if (!cfg.hasBirthdayField) fail('会員登録フォームに「生年月日」の項目がありません');
      const coupon = cfg.coupon_id ? (() => { try { return this.coupons.assertOfferable(tenantId, cfg.coupon_id); } catch (e) { fail(`クーポンを付けられません: ${e.message}`); } })() : null;
      let url = null;
      if (coupon) {
        url = this.couponUrl?.(actor, tenantId, coupon.coupon_id);
        if (!url) fail('クーポンのURLを作れません。「LINE連携」でLIFF IDを設定してください(登録URLも必要です)');
      }
      const shop = this.store.find('tenants', (t) => t.tenant_id === tenantId)?.name ?? '';
      const plan = this.#plan(tenantId, cfg.days_before, nowMs);
      const batch = plan.targets.slice(0, CAP), r = { matched: plan.matched, target: batch.length, sent: 0, failed: 0, granted: 0, skipped: plan.skipped, deferred: plan.targets.length - batch.length, errors: [] };
      for (const { m, year } of batch) {
        const messages = [];
        const text = cfg.message_text.replaceAll('{名前}', m.name || 'お客');
        if (text) messages.push({ type: 'text', text });
        if (coupon) messages.push(couponFlex({ shop, coupon, url, untilText: this.coupons.untilText(coupon, nowMs) }));
        try { await push(messagingToken, m.user_id, messages, this.fetchImpl); }
        catch (e) { r.failed++; if (r.errors.length < 3) r.errors.push(String(e.message).slice(0, 200)); continue; }
        r.sent++;
        const g = coupon ? this.coupons.grant(tenantId, coupon.coupon_id, [m.member_id], `birthday:${year}`) : 0;
        r.granted += g;
        this.store.insert('birthday_sends', { tenant_id: tenantId, member_id: m.member_id, year, sent_at: new Date(nowMs).toISOString(), coupon_granted: g > 0 });
      }
      this.#record(tenantId, nowMs, r);
      audit(this.store, { tenant_id: tenantId, actor, action: 'BIRTHDAY_RUN', detail: { sent: r.sent, failed: r.failed, granted: r.granted } });
      return r;
    } finally { this.running.delete(tenantId); }
  }
  #record(tenantId, nowMs, result) {
    const patch = { last_run_at: new Date(nowMs).toISOString(), last_result: result };
    if (this.#row(tenantId)) this.store.update('birthday_campaigns', (x) => x.tenant_id === tenantId, patch);
    else this.store.insert('birthday_campaigns', { tenant_id: tenantId, enabled: false, days_before: 7, message_text: '', coupon_id: '', updated_at: '', updated_by: '', ...patch });
  }
}
