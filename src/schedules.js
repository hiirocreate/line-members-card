// 予約メッセージ(定期): 日時を決めて、メッセージ(とクーポン)を自動で配信する。1回だけ/毎日/毎週/毎月。
// Cloud Scheduler が /api/cron/run を10分おきに呼ぶと、時刻になった予約が実行される (同じ日に二重には送らない)。
import { randomUUID } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { parseDays } from './coupons.js';
import { featureOn } from './features.js';

const SYSTEM = { id: 'system', role: 'OPERATOR' };
const KINDS = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'];
const isOn = (v) => v === true || v === 'TRUE';
const jst = (ms) => { const d = new Date(ms + 9 * 3600_000); return { day: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), dow: d.getUTCDay(), dom: d.getUTCDate(), last: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() }; };

export class ScheduleService {
  constructor(store, members, messaging) { Object.assign(this, { store, members, messaging }); this.running = new Set(); }

  #row(tenantId, id) {
    const r = this.store.find('scheduled_messages', (x) => x.tenant_id === tenantId && x.schedule_id === id);
    if (!r) throw new ValidationError('予約が存在しません');
    return r;
  }
  #clean(tenantId, i) {
    const errors = [], name = typeof i.name === 'string' ? i.name.trim() : '', text = typeof i.message_text === 'string' ? i.message_text.trim() : '';
    if (!name || name.length > 40) errors.push('予約名は1〜40文字で入力してください');
    if (text.length > 5000) errors.push('メッセージは5000文字以内です');
    try { assertSafeText(name, '予約名'); assertSafeText(text, 'メッセージ'); } catch (e) { errors.push(e.message); }
    const kind = i.kind; if (!KINDS.includes(kind)) errors.push('くり返しの種類が不正です');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(i.time ?? '')) errors.push('送信時刻は HH:MM で指定してください');
    let run_date = '', weekday = '', day_of_month = '';
    if (kind === 'ONCE') { run_date = i.run_date ?? ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(run_date) || Number.isNaN(Date.parse(run_date))) errors.push('送信日を指定してください'); }
    if (kind === 'WEEKLY') { weekday = Number(i.weekday); if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) errors.push('曜日が不正です'); }
    if (kind === 'MONTHLY') { day_of_month = Number(i.day_of_month); if (!Number.isInteger(day_of_month) || day_of_month < 0 || day_of_month > 28) errors.push('日にちは1〜28日、または月末を指定してください'); }
    const coupon_id = i.coupon_id || '';
    if (coupon_id && !this.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === coupon_id)) errors.push('クーポンが存在しません');
    if (!text && !coupon_id) errors.push('メッセージかクーポンのどちらかを設定してください');
    let coupon_days = null; try { coupon_days = parseDays(i.coupon_days); } catch (e) { errors.push(e.message); }
    const where = i.where && typeof i.where === 'object' && i.where.conditions?.length ? i.where : null;
    if (where) { try { this.members.search(SYSTEM, tenantId, { where, limit: 1 }); } catch (e) { errors.push(`配信先の条件が不正です: ${e.message}`); } }
    if (errors.length) throw new ValidationError('予約の入力内容に誤りがあります', errors);
    return { name, enabled: i.enabled !== false, kind, run_date, weekday, day_of_month, time: i.time, message_text: text, coupon_id, coupon_days: coupon_days ?? '', where };
  }
  #view(r) { return { ...r, enabled: isOn(r.enabled) }; }

  list(actor, tenantId) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    return this.store.select('scheduled_messages', (r) => r.tenant_id === tenantId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((r) => this.#view(r));
  }
  create(actor, tenantId, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const row = { schedule_id: randomUUID().replace(/-/g, ''), tenant_id: tenantId, ...this.#clean(tenantId, input ?? {}), last_run_key: '', last_result: '', created_by: actor.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.store.insert('scheduled_messages', row);
    audit(this.store, { tenant_id: tenantId, actor, action: 'SCHEDULE_CREATE', target: row.schedule_id, detail: { name: row.name, kind: row.kind } });
    return this.#view(row);
  }
  update(actor, tenantId, id, input) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const cur = this.#row(tenantId, id), v = this.#clean(tenantId, { ...cur, enabled: isOn(cur.enabled), ...input });
    this.store.update('scheduled_messages', (r) => r.tenant_id === tenantId && r.schedule_id === id, { ...v, last_run_key: '', updated_at: new Date().toISOString() }); // 設定を変えたら、その日の分はもう一度実行できる
    audit(this.store, { tenant_id: tenantId, actor, action: 'SCHEDULE_UPDATE', target: id, detail: { enabled: v.enabled } });
    return this.#view(this.#row(tenantId, id));
  }
  remove(actor, tenantId, id) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    this.#row(tenantId, id);
    this.store.remove('scheduled_messages', (r) => r.tenant_id === tenantId && r.schedule_id === id);
    audit(this.store, { tenant_id: tenantId, actor, action: 'SCHEDULE_DELETE', target: id });
  }
  // 手動で今すぐ実行 (予約の設定どおりの内容・配信先)
  async runNow(actor, tenantId, id) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    return this.#exec(this.#row(tenantId, id), Date.now(), actor);
  }

  #due(r, t) {
    if (!isOn(r.enabled) || r.last_run_key === t.day || r.time > t.time) return false;
    if (r.kind === 'ONCE') return r.run_date === t.day;
    if (r.kind === 'WEEKLY') return Number(r.weekday) === t.dow;
    if (r.kind === 'MONTHLY') return Number(r.day_of_month) === 0 ? t.dom === t.last : Number(r.day_of_month) === t.dom;
    return true; // DAILY
  }
  // 時刻になった予約をすべて実行 (cron から呼ぶ)
  async runDue(nowMs = Date.now()) {
    const t = jst(nowMs), out = [];
    for (const r of this.store.select('scheduled_messages', (x) => this.#due(x, t))) {
      if (!featureOn(this.store, r.tenant_id, 'schedule')) continue;
      out.push({ tenant_id: r.tenant_id, schedule_id: r.schedule_id, ...(await this.#exec(r, nowMs, SYSTEM).catch((e) => ({ error: e.message }))) });
    }
    return out;
  }
  async #exec(r, nowMs, actor) {
    if (this.running.has(r.schedule_id)) throw new ValidationError('実行中です');
    this.running.add(r.schedule_id);
    const t = jst(nowMs);
    this.store.update('scheduled_messages', (x) => x.schedule_id === r.schedule_id, { last_run_key: t.day }); // 先に印を付ける(失敗しても同じ日に何度も送らない)
    let result;
    try {
      const res = await this.messaging.send(SYSTEM, r.tenant_id, { text: r.message_text, where: r.where ?? undefined, couponId: r.coupon_id || undefined, couponDays: r.coupon_days || undefined, auto: true });
      result = { at: new Date(nowMs).toISOString(), audience: res.audience, sent: res.sent, failed: res.failed };
    } catch (e) { result = { at: new Date(nowMs).toISOString(), error: e.message }; }
    finally { this.running.delete(r.schedule_id); }
    const patch = { last_result: result }; if (r.kind === 'ONCE') patch.enabled = false;
    this.store.update('scheduled_messages', (x) => x.schedule_id === r.schedule_id, patch);
    audit(this.store, { tenant_id: r.tenant_id, actor, action: 'SCHEDULE_RUN', target: r.schedule_id, detail: result });
    return result;
  }
}
