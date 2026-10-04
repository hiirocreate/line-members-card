// 配信予定のまとめ: 誕生日配信・来店回数配信・予約メッセージが「いま有効か」「次はいつ送られるか」をひとまとめにする。
import { require_ } from './permissions.js';
import { featureOn } from './features.js';

const JST = 9 * 3600_000, DAY = 86400_000;
const isOn = (v) => v === true || v === 'TRUE';
const ymd = (ms) => new Date(ms + JST).toISOString().slice(0, 10);
const parts = (ms) => { const d = new Date(ms + JST); return { day: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), dow: d.getUTCDay(), dom: d.getUTCDate(), last: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() }; };
const atMs = (day, time) => Date.parse(`${day}T${time}:00+09:00`);

// 予約の次の配信日時。state: 'upcoming'(これから) | 'pending'(今日の時刻を過ぎたが、まだ実行されていない=次の自動実行で送られる) | null(予定なし)
export function nextRun(s, nowMs = Date.now()) {
  if (!isOn(s.enabled)) return { at: null, state: null };
  const t = parts(nowMs), match = (p) => (s.kind === 'DAILY' ? true : s.kind === 'WEEKLY' ? Number(s.weekday) === p.dow : s.kind === 'MONTHLY' ? (Number(s.day_of_month) === 0 ? p.dom === p.last : Number(s.day_of_month) === p.dom) : s.run_date === p.day);
  for (let i = 0; i <= (s.kind === 'ONCE' ? 400 : 62); i++) {
    const p = parts(nowMs + i * DAY);
    if (!match(p)) continue;
    if (i === 0) {
      if (s.last_run_key === t.day) continue; // 今日の分はすでに送った
      return s.time > t.time ? { at: `${p.day} ${s.time}`, state: 'upcoming' } : { at: `${p.day} ${s.time}`, state: 'pending' };
    }
    return { at: `${p.day} ${s.time}`, state: 'upcoming' };
  }
  return { at: null, state: null };
}

export function deliveryOverview(app, actor, tenantId, nowMs = Date.now()) {
  require_(actor, 'MESSAGE_SEND', tenantId);
  const on = (k) => featureOn(app.store, tenantId, k);
  const hb = app.store.find('settings', (r) => r.key === 'cron_heartbeat')?.value;
  const hbMs = Date.parse(typeof hb === 'string' ? hb : hb?.at ?? '');
  const out = { now: new Date(nowMs).toISOString(), cron: { last_at: Number.isNaN(hbMs) ? null : new Date(hbMs).toISOString(), ok: !Number.isNaN(hbMs) && nowMs - hbMs < 30 * 60_000 }, birthday: null, schedules: null, visitRules: null };
  if (on('birthday')) {
    const b = app.birthday.get(actor, tenantId), coupon = b.coupon_id ? app.store.find('coupons', (c) => c.tenant_id === tenantId && c.coupon_id === b.coupon_id) : null;
    out.birthday = { enabled: b.enabled, days_before: b.days_before, message_text: b.message_text, coupon_title: coupon?.title ?? null, coupon_days: b.coupon_days || null, hasBirthdayField: b.hasBirthdayField, last_run_at: b.last_run_at || null, last_result: b.last_result,
      preview: b.hasBirthdayField ? app.birthday.preview(actor, tenantId, b.days_before, nowMs) : null };
  }
  if (on('schedule')) {
    out.schedules = app.schedules.list(actor, tenantId).map((s) => ({ schedule_id: s.schedule_id, name: s.name, kind: s.kind, run_date: s.run_date, weekday: s.weekday, day_of_month: s.day_of_month, time: s.time, enabled: s.enabled, has_coupon: !!s.coupon_id, message_text: s.message_text, segment: !!s.where, last_result: s.last_result || null, next: nextRun(s, nowMs) }))
      .sort((a, b) => (a.next.at ? atMs(...a.next.at.split(' ')) : Infinity) - (b.next.at ? atMs(...b.next.at.split(' ')) : Infinity));
  }
  if (on('visitrules')) out.visitRules = app.visitRules.list(actor, tenantId).map((r) => ({ rule_id: r.rule_id, name: r.name, enabled: r.enabled, visits: r.visits, repeat: r.repeat, has_coupon: !!r.coupon_id, message_text: r.message_text, valid_from: r.valid_from, valid_until: r.valid_until, sent: r.sent, failed: r.failed }));
  return out;
}
