// 運営からのお知らせ(手動)。運営が書いた内容を、全店舗または選んだ店舗の管理画面「🔔 お知らせ」に出す。表示期間・一時停止もできる。
import { randomUUID } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { jstParts } from './dates.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isOn = (v) => v === true || v === 'TRUE';
const today = (ms) => { const p = jstParts(ms); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const jstDate = (iso) => today(Date.parse(iso));

export class AnnouncementService {
  constructor(store) { this.store = store; }
  #row(id) { const r = this.store.find('announcements', (x) => x.announcement_id === id); if (!r) throw new ValidationError('お知らせが存在しません'); return r; }
  #view(r) { return { ...r, enabled: isOn(r.enabled), tenant_ids: Array.isArray(r.tenant_ids) ? r.tenant_ids : [] }; }
  #clean(i) {
    const errors = [], title = typeof i.title === 'string' ? i.title.trim() : '', body = typeof i.body === 'string' ? i.body.trim() : '';
    if (!title || title.length > 60) errors.push('タイトルは1〜60文字で入力してください');
    if (!body || body.length > 3000) errors.push('本文は1〜3000文字で入力してください');
    try { assertSafeText(title, 'タイトル'); assertSafeText(body, '本文'); } catch (e) { errors.push(e.message); }
    const ids = Array.isArray(i.tenant_ids) ? [...new Set(i.tenant_ids.map(String))] : [];
    for (const t of ids) if (!this.store.find('tenants', (x) => x.tenant_id === t)) errors.push(`店舗が存在しません: ${t}`);
    const from = i.visible_from || '', until = i.visible_until || '';
    for (const [d, l] of [[from, '表示開始日'], [until, '表示終了日']]) if (d && (!DAY.test(d) || Number.isNaN(Date.parse(d)))) errors.push(`${l}は YYYY-MM-DD の日付で指定してください`);
    if (from && until && until < from) errors.push('表示終了日は開始日以降にしてください');
    if (errors.length) throw new ValidationError('お知らせの入力内容に誤りがあります', errors);
    return { title, body, tenant_ids: ids, visible_from: from, visible_until: until, enabled: i.enabled !== false };
  }
  list(actor) { require_(actor, 'MASTER_EDIT'); return this.store.select('announcements').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((r) => this.#view(r)); }
  create(actor, input) {
    require_(actor, 'MASTER_EDIT');
    const now = new Date().toISOString(), row = { announcement_id: randomUUID().replace(/-/g, ''), ...this.#clean(input ?? {}), created_by: actor.id, created_at: now, updated_at: now };
    this.store.insert('announcements', row);
    audit(this.store, { tenant_id: '', actor, action: 'ANNOUNCEMENT_CREATE', target: row.announcement_id, detail: { title: row.title, tenants: row.tenant_ids.length || 'all' } });
    return this.#view(row);
  }
  update(actor, id, input) {
    require_(actor, 'MASTER_EDIT');
    const cur = this.#view(this.#row(id)), v = this.#clean({ ...cur, ...input });
    this.store.update('announcements', (r) => r.announcement_id === id, { ...v, updated_at: new Date().toISOString() });
    audit(this.store, { tenant_id: '', actor, action: 'ANNOUNCEMENT_UPDATE', target: id, detail: { enabled: v.enabled } });
    return this.#view(this.#row(id));
  }
  remove(actor, id) {
    require_(actor, 'MASTER_EDIT'); this.#row(id);
    this.store.remove('announcements', (r) => r.announcement_id === id);
    audit(this.store, { tenant_id: '', actor, action: 'ANNOUNCEMENT_DELETE', target: id });
  }
  // 管理画面に出すもの。tenantId が無い(運営)ときは、有効なものすべて。
  visible(tenantId, nowMs = Date.now()) {
    const day = today(nowMs);
    return this.store.select('announcements', (r) => isOn(r.enabled) && (!r.visible_from || day >= r.visible_from) && (!r.visible_until || day <= r.visible_until)
      && (!tenantId || !Array.isArray(r.tenant_ids) || !r.tenant_ids.length || r.tenant_ids.includes(tenantId)))
      .map((r) => ({ id: `a:${r.announcement_id}`, date: jstDate(r.created_at), at: r.created_at, title: r.title, body: r.body, from: '運営' }));
  }
}
