// 再来店のお知らせ(来店頻度連動)。会員ごとの「いつもの来店間隔」を出し、それに比べて来店が空いている会員へ自動でLINEを送る。
// 来店間隔 = 最終来店の直前 window_days 日間の来店の平均間隔。 最終来店からの日数 ≥ max(min_days, 平均間隔 × multiplier) で対象。
// 同じ「来店が空いている期間」には1回だけ送る(来店するとリセット)。stop_days を超えて空いた会員には送らない。
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { resolveLine } from './settings.js';
import { push, couponFlex } from './line.js';
import { parseDays } from './coupons.js';
import { featureOn } from './features.js';

const DAY = 86400_000, CAP = 200, SYSTEM = { id: 'system', role: 'OPERATOR' };
export const DEFAULT_TEXT = '{名前}さん、しばらくお会いできていませんね。\nまたのご来店をお待ちしております😊';
const isOn = (v) => v === true || v === 'TRUE';
const DEFAULTS = { multiplier: 2.5, min_days: 14, stop_days: 180, window_days: 90, min_visits: 3 };

// 来店の時刻(ms, 昇順)から、{ avg: 平均間隔(日), n: 来店回数 } を返す。直近の最終来店から window_days 日以内のものだけを使う。
export function frequency(times, windowDays) {
  const t = [...times].sort((a, b) => a - b); if (!t.length) return { avg: null, n: 0 };
  const last = t.at(-1), use = t.filter((x) => last - x <= windowDays * DAY);
  return { avg: use.length >= 2 ? (use.at(-1) - use[0]) / (use.length - 1) / DAY : null, n: use.length };
}

export class RevisitService {
  constructor(store, vault, members, coupons, fetchImpl = fetch) { Object.assign(this, { store, vault, members, coupons, fetchImpl }); this.running = new Set(); }
  #row(tenantId) { return this.store.find('revisit_settings', (r) => r.tenant_id === tenantId); }

  get(actor, tenantId) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const r = this.#row(tenantId), n = (k) => (r?.[k] === '' || r?.[k] === undefined ? DEFAULTS[k] : Number(r[k]));
    return { enabled: isOn(r?.enabled), multiplier: n('multiplier'), min_days: n('min_days'), stop_days: n('stop_days'), window_days: n('window_days'), min_visits: n('min_visits'),
      message_text: r?.message_text ?? DEFAULT_TEXT, coupon_id: r?.coupon_id ?? '', coupon_days: r?.coupon_days || '', last_run_at: r?.last_run_at ?? '', last_result: r?.last_result || null };
  }
  save(actor, tenantId, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const errors = [], v = {};
    const num = (k, label, min, max, int) => { const x = Number(input[k]); if (!Number.isFinite(x) || x < min || x > max || (int && !Number.isInteger(x))) errors.push(`${label}は${min}〜${max}${int ? 'の整数' : ''}で指定してください`); v[k] = x; };
    num('multiplier', '「いつもの間隔の何倍で送るか」', 1.5, 10, false); num('min_days', '「最低でも空く日数」', 1, 365, true); num('stop_days', '「送るのをやめる日数」', 7, 1000, true);
    num('window_days', '「来店間隔を調べる期間」', 14, 730, true); num('min_visits', '「間隔を出すのに必要な来店回数」', 2, 50, true);
    if (v.stop_days <= v.min_days) errors.push('「送るのをやめる日数」は「最低でも空く日数」より大きくしてください');
    const text = typeof input.message_text === 'string' ? input.message_text.trim() : '', coupon_id = input.coupon_id || '';
    if (text.length > 1000) errors.push('メッセージは1000文字以内です');
    try { assertSafeText(text, 'メッセージ'); } catch (e) { errors.push(e.message); }
    if (coupon_id && !this.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === coupon_id)) errors.push('クーポンが存在しません');
    if (input.enabled && !text && !coupon_id) errors.push('メッセージかクーポンのどちらかを設定してください');
    let coupon_days = null; try { coupon_days = parseDays(input.coupon_days); } catch (e) { errors.push(e.message); }
    if (errors.length) throw new ValidationError('再来店のお知らせの入力内容に誤りがあります', errors);
    const patch = { ...v, enabled: !!input.enabled, message_text: text, coupon_id, coupon_days: coupon_days ?? '', updated_at: new Date().toISOString(), updated_by: actor.id };
    if (this.#row(tenantId)) this.store.update('revisit_settings', (r) => r.tenant_id === tenantId, patch);
    else this.store.insert('revisit_settings', { tenant_id: tenantId, last_run_at: '', last_result: '', ...patch });
    audit(this.store, { tenant_id: tenantId, actor, action: 'REVISIT_SETTINGS', detail: { enabled: patch.enabled, multiplier: v.multiplier } });
    return this.get(actor, tenantId);
  }

  // 会員ごとの判定。status: 'due'(送る) | 'sent'(この空き期間には送信済み) | 'ok'(まだ空いていない) | 'few'(来店が少なく間隔が出せない) | 'long'(空きすぎ) | 'off'(同意なし/断っている)
  #judge(cfg, m, times, consented, sentFor, nowMs) {
    const last = Date.parse(m.last_visit_at); if (Number.isNaN(last)) return { status: 'few' };
    const f = frequency(times, cfg.window_days), idle = (nowMs - last) / DAY;
    if (f.n < cfg.min_visits || f.avg === null) return { status: 'few', idle, n: f.n };
    const threshold = Math.max(cfg.min_days, f.avg * cfg.multiplier), base = { idle, avg: f.avg, threshold, n: f.n };
    if (idle < threshold) return { status: 'ok', ...base };
    if (idle > cfg.stop_days) return { status: 'long', ...base };
    if (!consented || this.members.prefsOf(m).revisit === false) return { status: 'off', ...base };
    return { status: sentFor.has(m.last_visit_at) ? 'sent' : 'due', ...base };
  }
  #plan(tenantId, cfg, nowMs) {
    const consented = new Set(this.store.select('member_consents', (c) => c.tenant_id === tenantId && c.channel === 'LINE' && c.granted).map((c) => c.member_id));
    const byMember = new Map();
    for (const v of this.store.select('visits', (x) => x.tenant_id === tenantId)) { const t = Date.parse(v.visited_at); if (!Number.isNaN(t)) (byMember.get(v.member_id) ?? byMember.set(v.member_id, []).get(v.member_id)).push(t); }
    const sent = new Map();
    for (const s of this.store.select('revisit_sends', (x) => x.tenant_id === tenantId)) (sent.get(s.member_id) ?? sent.set(s.member_id, new Set()).get(s.member_id)).add(s.last_visit_at);
    const out = { due: [], counts: { due: 0, sent: 0, ok: 0, few: 0, long: 0, off: 0 } };
    for (const m of this.store.select('members', (x) => x.tenant_id === tenantId && (x.status || 'ACTIVE') === 'ACTIVE')) {
      const j = this.#judge(cfg, m, byMember.get(m.member_id) ?? [], consented.has(m.member_id), sent.get(m.member_id) ?? new Set(), nowMs);
      out.counts[j.status]++;
      if (j.status === 'due') out.due.push({ m, ...j });
    }
    return out;
  }
  // 設定の確認用: 今送ると何人に届くか。sample は来店間隔の例
  preview(actor, tenantId, nowMs = Date.now()) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const p = this.#plan(tenantId, this.get(actor, tenantId), nowMs);
    return { counts: p.counts, willSend: Math.min(p.due.length, CAP), sample: p.due.slice(0, 5).map((d) => ({ member_number: d.m.member_number, avg_days: Math.round(d.avg * 10) / 10, idle_days: Math.floor(d.idle) })) };
  }
  // 会員ごとの来店頻度(会員の詳細に表示)
  memberStat(actor, tenantId, memberId, nowMs = Date.now()) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    const cfg = this.get(SYSTEM, tenantId), m = this.store.find('members', (x) => x.tenant_id === tenantId && x.member_id === memberId);
    if (!m) throw new ValidationError('会員が存在しません');
    const f = frequency(this.store.select('visits', (v) => v.tenant_id === tenantId && v.member_id === memberId).map((v) => Date.parse(v.visited_at)).filter((x) => !Number.isNaN(x)), cfg.window_days);
    return { avg_days: f.avg === null ? null : Math.round(f.avg * 10) / 10, visits_in_window: f.n, window_days: cfg.window_days, enabled: this.members.prefsOf(m).revisit !== false };
  }
  setMemberEnabled(actor, tenantId, memberId, enabled) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const m = this.store.find('members', (x) => x.tenant_id === tenantId && x.member_id === memberId);
    if (!m) throw new ValidationError('会員が存在しません');
    if (typeof enabled !== 'boolean') throw new ValidationError('設定の値が不正です');
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === memberId, { notify_prefs: { ...this.members.prefsOf(m), revisit: enabled } });
    audit(this.store, { tenant_id: tenantId, actor, action: 'MEMBER_REVISIT_TOGGLE', target: memberId, detail: { enabled } });
    return { enabled };
  }

  async run(actor, tenantId, { nowMs = Date.now(), force = false } = {}) { require_(actor, 'MESSAGE_SEND', tenantId); return this.#run(actor, tenantId, nowMs, force); }
  async runAll(nowMs = Date.now(), { morningOnly = false } = {}) {
    const out = [];
    if (morningOnly && new Date(nowMs + 9 * 3600_000).getUTCHours() < 9) return out; // 日本時間の朝9時より前には送らない
    for (const c of this.store.select('revisit_settings', (r) => isOn(r.enabled))) {
      try { out.push({ tenant_id: c.tenant_id, ...(await this.#run(SYSTEM, c.tenant_id, nowMs, false)) }); } catch (e) { out.push({ tenant_id: c.tenant_id, error: e.message }); }
    }
    return out;
  }
  async #run(actor, tenantId, nowMs, force) {
    if (!featureOn(this.store, tenantId, 'revisit')) throw new ValidationError('この機能はご利用できません');
    const cfg = this.get(SYSTEM, tenantId);
    if (!cfg.enabled && !force) throw new ValidationError('再来店のお知らせがオフです');
    if (this.running.has(tenantId)) throw new ValidationError('実行中です');
    this.running.add(tenantId);
    try {
      const fail = (message) => { this.#record(tenantId, nowMs, { error: message }); throw new ValidationError(message); };
      const { messagingToken } = resolveLine(this.store, this.vault, tenantId);
      if (!messagingToken) fail('LINE設定でチャネルアクセストークンを登録してください');
      const coupon = cfg.coupon_id ? (() => { try { return this.coupons.assertOfferable(tenantId, cfg.coupon_id); } catch (e) { fail(`クーポンを付けられません: ${e.message}`); } })() : null;
      let url = null;
      if (coupon) { url = this.couponUrl?.(actor, tenantId, coupon.coupon_id); if (!url) fail('クーポンのURLを作れません。「LINE連携」でLIFF IDを設定してください(登録URLも必要です)'); }
      const shop = this.store.find('tenants', (t) => t.tenant_id === tenantId)?.name ?? '';
      const plan = this.#plan(tenantId, cfg, nowMs), batch = plan.due.slice(0, CAP);
      const r = { target: batch.length, sent: 0, failed: 0, granted: 0, deferred: plan.due.length - batch.length, errors: [] };
      for (const d of batch) {
        const m = d.m, messages = [], text = cfg.message_text.replaceAll('{名前}', this.members.cardName(tenantId, m) || 'お客').replaceAll('{日数}', String(Math.floor(d.idle)));
        if (text) messages.push({ type: 'text', text });
        if (coupon) messages.push(couponFlex({ shop, coupon, url, untilText: this.coupons.untilText(coupon, nowMs, cfg.coupon_days || null) }));
        let status = 'SENT', granted = 0;
        try { await push(messagingToken, m.user_id, messages, this.fetchImpl); granted = coupon ? this.coupons.grant(tenantId, coupon.coupon_id, [m.member_id], `revisit:${m.last_visit_at}`, cfg.coupon_days || null) : 0; r.sent++; r.granted += granted; }
        catch (e) { status = 'FAILED'; r.failed++; if (r.errors.length < 3) r.errors.push(String(e.message).slice(0, 200)); }
        this.store.insert('revisit_sends', { tenant_id: tenantId, member_id: m.member_id, last_visit_at: m.last_visit_at, sent_at: new Date(nowMs).toISOString(), status, coupon_granted: granted > 0 });
      }
      this.#record(tenantId, nowMs, r);
      audit(this.store, { tenant_id: tenantId, actor, action: 'REVISIT_RUN', detail: { sent: r.sent, failed: r.failed, granted: r.granted } });
      return r;
    } finally { this.running.delete(tenantId); }
  }
  #record(tenantId, nowMs, result) {
    const patch = { last_run_at: new Date(nowMs).toISOString(), last_result: result };
    if (this.#row(tenantId)) this.store.update('revisit_settings', (x) => x.tenant_id === tenantId, patch);
    else this.store.insert('revisit_settings', { tenant_id: tenantId, enabled: false, message_text: '', coupon_id: '', ...patch });
  }
}
