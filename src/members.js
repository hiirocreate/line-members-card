// 会員登録・更新・検索・出力。固定項目は members、それ以外は member_custom_values に保存。
import { ValidationError } from './sanitize.js';
import { validateValue, displayValue } from './fieldTypes.js';
import { require_, canSeeField, can } from './permissions.js';
import { audit } from './audit.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { daysUntilBirthday } from './dates.js';
import { buildXlsx } from './xlsx.js';

const now = () => new Date().toISOString();
export const UNREGISTERED = '未登録';

// 姓・名の項目名 (「姓」「姓(漢字)」など。読み仮名の項目や「氏名」は含めない)
const NOT_KANA = (re) => ({ test: (t) => re.test(t) && !/カナ|かな|ふりがな|フリガナ|ｶﾅ|kana/i.test(t) });
const FAMILY_LABEL = NOT_KANA(/^(姓|苗字|名字|氏(?!名))/), GIVEN_LABEL = NOT_KANA(/^名(?:[（(].*[）)])?$/);
export class MemberService {
  constructor(store, forms, vault = null) { this.store = store; this.forms = forms; this.vault = vault; this.usedNonces = new Map(); }

  findByUser(tenantId, userId) { return this.store.find('members', (m) => m.tenant_id === tenantId && m.user_id === userId); }

  // ---- 値の読み書き ----
  #member(tenantId, memberId) {
    const m = this.store.find('members', (r) => r.tenant_id === tenantId && r.member_id === memberId);
    if (!m) throw new ValidationError('会員が存在しません');
    return m;
  }
  #valuesOf(tenantId, memberId) {
    return Object.fromEntries(this.store.select('member_custom_values', (v) => v.tenant_id === tenantId && v.member_id === memberId)
      .map((v) => [v.field_id, v.value]));
  }
  #read(member, field, vals) {
    if (field.master_key) {
      const core = this.store.find('field_master', (m) => m.key === field.master_key)?.core_column;
      if (core) return member[core] === '' || member[core] === undefined ? null : member[core];
    }
    return vals[field.field_id] ?? null;
  }
  #write(member, field, value) {
    const core = field.master_key && this.store.find('field_master', (m) => m.key === field.master_key)?.core_column;
    if (core) { this.store.update('members', (r) => r.tenant_id === member.tenant_id && r.member_id === member.member_id, { [core]: value ?? '' }); return; }
    const pred = (v) => v.tenant_id === member.tenant_id && v.member_id === member.member_id && v.field_id === field.field_id;
    if (value === null) { this.store.remove('member_custom_values', pred); return; } // 値クリアのみ。項目削除では呼ばない
    const row = { member_id: member.member_id, tenant_id: member.tenant_id, field_id: field.field_id, value, updated_at: now() };
    if (this.store.find('member_custom_values', pred)) this.store.update('member_custom_values', pred, row);
    else this.store.insert('member_custom_values', row);
  }
  #setConsent(member, field, granted) {
    if (!field.consent_target) return;
    const pred = (c) => c.tenant_id === member.tenant_id && c.member_id === member.member_id && c.channel === field.consent_target;
    const row = { member_id: member.member_id, tenant_id: member.tenant_id, channel: field.consent_target, granted: !!granted, updated_at: now() };
    if (this.store.find('member_consents', pred)) this.store.update('member_consents', pred, row); else this.store.insert('member_consents', row);
  }
  consents(tenantId, memberId) {
    // 配信同意はフォームの同意項目でのみ付与される。メールアドレス登録だけでは「同意なし」
    const out = { LINE: false, EMAIL: false, MARKETING: false };
    for (const c of this.store.select('member_consents', (r) => r.tenant_id === tenantId && r.member_id === memberId)) out[c.channel] = c.granted;
    return out;
  }

  // 入力を項目定義で検証。editable(field) が false の項目は拒否 (他店舗/内部項目の注入防止)
  #validate(fields, input, { requireAll }) {
    const byId = new Map(fields.map((f) => [f.field_id, f]));
    const errors = [];
    for (const k of Object.keys(input)) if (!byId.has(k)) errors.push(`未知または入力できない項目: ${k}`);
    const out = new Map();
    for (const f of fields) {
      if (!requireAll && !(f.field_id in input)) continue;
      try { out.set(f.field_id, validateValue(f, input[f.field_id])); } catch (e) { if (e instanceof ValidationError) errors.push(e.message); else throw e; }
    }
    if (errors.length) throw new ValidationError('入力内容に誤りがあります', errors);
    return out;
  }

  // ---- 会員登録 (確認画面 → 登録) ----
  confirmRegistration(tenantId, input) {
    const form = this.forms.getUserForm(tenantId);
    const out = this.#validate(form.fields, input, { requireAll: true });
    return { version: form.version, items: form.fields.map((f) => ({ field_id: f.field_id, label: f.field_name, value: displayValue(f, out.get(f.field_id)) })) };
  }
  register(tenantId, userId, input, { confirmed = false } = {}) {
    if (!confirmed) throw new ValidationError('登録内容の確認が必要です');
    if (!userId) throw new ValidationError('ユーザーを特定できません');
    const existing = this.findByUser(tenantId, userId);
    if (existing && existing.status !== 'WITHDRAWN') throw new ValidationError('既に登録されています');
    const form = this.forms.getUserForm(tenantId);
    const out = this.#validate(form.fields, input, { requireAll: true });
    let member = existing;
    if (existing) { // 退会済みの再入会: 同じ会員番号で有効化。過去データは保持し、入力された項目だけ更新
      this.store.update('members', (m) => m.tenant_id === tenantId && m.member_id === existing.member_id, { status: 'ACTIVE', withdrawn_at: '', withdraw_reason: '', form_version: form.version });
    } else {
      const seq = this.store.select('members', (m) => m.tenant_id === tenantId).length + 1;
      member = { member_id: `M${String(seq).padStart(3, '0')}`, tenant_id: tenantId, user_id: userId, member_number: String(seq).padStart(6, '0'),
        name: '', phone: '', email: '', registered_at: now(), last_visit_at: '', visit_count: 0, status: 'ACTIVE', form_version: form.version, withdrawn_at: '', withdraw_reason: '' };
      this.store.insert('members', member);
    }
    for (const f of form.fields) {
      const v = out.get(f.field_id);
      if (v !== null) this.#write(member, f, v); else if (existing) this.#write(member, f, null);
      this.#setConsent(member, f, v === true);
    }
    audit(this.store, { tenant_id: tenantId, actor: { id: userId }, action: existing ? 'MEMBER_REJOIN' : 'MEMBER_REGISTER', target: member.member_id, detail: { version: form.version } });
    return this.store.find('members', (m) => m.member_id === member.member_id && m.tenant_id === tenantId);
  }

  // ---- 配信の受け取り設定 (会員本人が会員証の画面から切り替える) ----
  // 登録フォームに同意項目が無い店舗でも使える。同意項目がある場合は、その値も同じ状態にそろえる。
  setConsentByUser(tenantId, userId, channel, granted) {
    if (channel !== 'LINE') throw new ValidationError('この設定は変更できません');
    if (typeof granted !== 'boolean') throw new ValidationError('設定の値が不正です');
    const m = this.findByUser(tenantId, userId);
    if (!m || m.status === 'WITHDRAWN') throw new ValidationError('会員が存在しません');
    const f = this.forms.fields(tenantId).find((x) => x.consent_target === channel);
    if (f) this.#write(m, f, granted);
    this.#setConsent(m, { consent_target: channel }, granted);
    audit(this.store, { tenant_id: tenantId, actor: { id: userId }, action: 'MEMBER_CONSENT_CHANGE', target: m.member_id, detail: { channel, granted } });
  }

  // 受け取る内容の設定 (LINE全体のオン/オフとは別)。既定はすべて受け取る
  static PREF_KEYS = ['news', 'coupon', 'birthday'];
  prefsOf(m) {
    const p = m.notify_prefs && typeof m.notify_prefs === 'object' ? m.notify_prefs : {};
    return Object.fromEntries(MemberService.PREF_KEYS.map((k) => [k, p[k] !== false]));
  }
  setPrefsByUser(tenantId, userId, input) {
    const m = this.findByUser(tenantId, userId);
    if (!m || m.status === 'WITHDRAWN') throw new ValidationError('会員が存在しません');
    const next = this.prefsOf(m);
    for (const k of MemberService.PREF_KEYS) if (input?.[k] !== undefined) { if (typeof input[k] !== 'boolean') throw new ValidationError('設定の値が不正です'); next[k] = input[k]; }
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === m.member_id, { notify_prefs: next });
    audit(this.store, { tenant_id: tenantId, actor: { id: userId }, action: 'MEMBER_PREFS_CHANGE', target: m.member_id, detail: next });
    return next;
  }
  // 姓・名が別項目のとき: { family, given } (どちらも無ければ null)。マスタの「姓」「名」、または項目名が「姓」「名」の項目を使う
  cardNameParts(tenantId, m) {
    const fields = this.forms.fields(tenantId), vals = this.#valuesOf(tenantId, m.member_id);
    const pick = (key, re) => fields.find((f) => f.master_key === key) ?? fields.find((f) => !f.master_key && f.field_type === 'TEXT' && re.test(f.field_name.trim()));
    const val = (f) => { const v = f ? this.#read(m, f, vals) : null; return typeof v === 'string' ? v.trim() : ''; };
    const family = val(pick('last_name', FAMILY_LABEL)), given = val(pick('first_name', GIVEN_LABEL));
    return family || given ? { family, given } : null;
  }
  // 会員証に出す氏名: 氏名項目(コア列)が空なら、「氏名/名前」という名前の文字項目の値を使う
  cardName(tenantId, m) {
    if (m.name) return m.name;
    const vals = this.#valuesOf(tenantId, m.member_id);
    for (const f of this.forms.fields(tenantId).filter((x) => x.field_type === 'TEXT' && /氏名|名前|なまえ|ネーム/.test(x.field_name))) {
      const v = this.#read(m, f, vals);
      if (typeof v === 'string' && v) return v;
    }
    const p = this.cardNameParts(tenantId, m);
    return p ? [p.family, p.given].filter(Boolean).join(' ') : '';
  }

  // ---- 退会 (削除せず status=WITHDRAWN。データは保持し、配信同意は取り消す) ----
  #withdraw(m, actor, reason) {
    if (m.status === 'WITHDRAWN') throw new ValidationError('既に退会済みです');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    this.store.update('members', (r) => r.tenant_id === m.tenant_id && r.member_id === m.member_id, { status: 'WITHDRAWN', withdrawn_at: now(), withdraw_reason: why });
    this.store.update('member_consents', (c) => c.tenant_id === m.tenant_id && c.member_id === m.member_id, { granted: false, updated_at: now() });
    audit(this.store, { tenant_id: m.tenant_id, actor, action: 'MEMBER_WITHDRAW', target: m.member_id, detail: { by: actor.id === m.user_id ? 'self' : 'admin' } });
  }
  withdrawByUser(tenantId, userId, reason) {
    const m = this.findByUser(tenantId, userId);
    if (!m) throw new ValidationError('会員が存在しません');
    this.#withdraw(m, { id: userId }, reason);
  }
  withdrawByAdmin(actor, tenantId, memberId, reason) {
    require_(actor, 'MEMBER_STATUS', tenantId);
    this.#withdraw(this.#member(tenantId, memberId), actor, reason);
  }
  restore(actor, tenantId, memberId) {
    require_(actor, 'MEMBER_STATUS', tenantId);
    const m = this.#member(tenantId, memberId);
    if (m.status !== 'WITHDRAWN') throw new ValidationError('退会済みの会員ではありません');
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === memberId, { status: 'ACTIVE', withdrawn_at: '', withdraw_reason: '' });
    audit(this.store, { tenant_id: tenantId, actor, action: 'MEMBER_RESTORE', target: memberId }); // 配信同意は復元しない(再同意が必要)
  }

  // ---- 来店記録 ----
  recordVisit(actor, tenantId, memberId, { method = 'MANUAL' } = {}) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const m = this.#member(tenantId, memberId);
    if (m.status === 'WITHDRAWN') throw new ValidationError('退会済みの会員です');
    const at = now();
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === memberId, { visit_count: m.visit_count + 1, last_visit_at: at });
    this.store.insert('visits', { visit_id: randomUUID(), tenant_id: tenantId, member_id: memberId, visited_at: at, method, recorded_by: actor.id });
    return { member_number: m.member_number, visit_count: m.visit_count + 1 };
  }
  visits(actor, tenantId, limit = 50) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    const nums = new Map(this.store.select('members', (m) => m.tenant_id === tenantId).map((m) => [m.member_id, m]));
    return this.store.select('visits', (v) => v.tenant_id === tenantId).slice(-limit).reverse()
      .map((v) => ({ ...v, member_number: nums.get(v.member_id)?.member_number ?? '', name: nums.get(v.member_id)?.name ?? '' }));
  }

  // 会員証QR: 署名付き・5分有効。画面は定期的に再取得する (スクリーンショットの使い回し防止)
  issueVisitCode(tenantId, userId, ttlMs = 5 * 60_000) {
    const m = this.findByUser(tenantId, userId);
    if (!m || m.status === 'WITHDRAWN') throw new ValidationError('会員が存在しません');
    const exp = Date.now() + ttlMs;
    return { code: `MC1.${this.vault.sign('visit', { t: tenantId, m: m.member_id, e: exp, n: randomBytes(9).toString('base64url') })}`, expiresAt: exp };
  }
  // 店舗スタッフが会員証QRを読み取って来店を記録 (自店舗の会員のみ / 使い捨て / 連続記録の抑止)
  scanVisit(actor, tenantId, code, { cooldownMin = 30 } = {}) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const p = typeof code === 'string' && code.startsWith('MC1.') ? this.vault.verify('visit', code.slice(4)) : null;
    if (!p || !(p.e > Date.now())) throw new ValidationError('QRコードが無効か、期限切れです。会員に画面を更新してもらってください');
    if (p.t !== tenantId) throw new ValidationError('他店舗の会員証です');
    for (const [n, e] of this.usedNonces) if (e < Date.now()) this.usedNonces.delete(n);
    if (this.usedNonces.has(p.n)) throw new ValidationError('このQRコードは使用済みです');
    const m = this.#member(tenantId, p.m);
    if (m.status === 'WITHDRAWN') throw new ValidationError('退会済みの会員です');
    if (m.last_visit_at && Date.now() - Date.parse(m.last_visit_at) < cooldownMin * 60_000) throw new ValidationError(`${cooldownMin}分以内に来店記録済みです`);
    this.usedNonces.set(p.n, p.e);
    return this.recordVisit(actor, tenantId, m.member_id, { method: 'QR' });
  }

  // ---- 変更 ----
  updateByUser(tenantId, userId, input) {
    const m = this.store.find('members', (r) => r.tenant_id === tenantId && r.user_id === userId);
    if (!m || m.status === 'WITHDRAWN') throw new ValidationError('会員が存在しません');
    const editable = this.forms.getUserForm(tenantId).fields.filter((f) => f.user_editable); // 店舗のみ変更可の項目は除外
    const out = this.#validate(editable, input, { requireAll: false });
    for (const [id, v] of out) { const f = editable.find((x) => x.field_id === id); this.#write(m, f, v); this.#setConsent(m, f, v === true); }
    audit(this.store, { tenant_id: tenantId, actor: { id: userId }, action: 'MEMBER_SELF_UPDATE', target: m.member_id, detail: { fields: [...out.keys()] } });
  }
  updateByStaff(actor, tenantId, memberId, input) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const m = this.#member(tenantId, memberId);
    const fields = this.forms.fields(tenantId).filter((f) => canSeeField(actor, f));
    const out = this.#validate(fields, input, { requireAll: false });
    for (const [id, v] of out) { const f = fields.find((x) => x.field_id === id); this.#write(m, f, v); this.#setConsent(m, f, v === true); }
    audit(this.store, { tenant_id: tenantId, actor, action: 'MEMBER_UPDATE', target: memberId, detail: { fields: [...out.keys()] } });
  }

  // ---- 参照: 未入力は「未登録」。過去フォームで登録した会員も壊れない ----
  profile(actor, tenantId, memberId) {
    if (actor) require_(actor, 'MEMBER_VIEW', tenantId);
    const m = this.#member(tenantId, memberId);
    const vals = this.#valuesOf(tenantId, memberId);
    const all = this.forms.fields(tenantId, { includeDisabled: !!actor }).filter((f) => canSeeField(actor, f));
    const items = [];
    for (const f of all) {
      const raw = this.#read(m, f, vals);
      if (!f.enabled && raw === null) continue; // 無効項目は値がある時だけ表示 (スタッフのみ)
      items.push({ field_id: f.field_id, label: f.field_name, enabled: f.enabled, registered: raw !== null,
        value: raw === null ? UNREGISTERED : displayValue(f, raw), raw });
    }
    const missing = items.filter((i) => i.enabled && !i.registered);
    const needsUpdate = all.some((f) => f.enabled && f.required && this.#read(m, f, vals) === null);
    return { member: m, items, missing: missing.map((i) => i.label), needsUpdate,
      notice: needsUpdate ? '会員情報を更新してください' : null, consents: this.consents(tenantId, memberId) };
  }

  // ---- 検索 (AND/OR 木構造。現在は AND で運用し OR も評価可能) ----
  #rows(actor, tenantId) {
    const fields = this.forms.fields(tenantId, { includeDisabled: true }).filter((f) => canSeeField(actor, f));
    const vals = new Map();
    for (const v of this.store.select('member_custom_values', (r) => r.tenant_id === tenantId)) {
      if (!vals.has(v.member_id)) vals.set(v.member_id, {});
      vals.get(v.member_id)[v.field_id] = v.value;
    }
    const members = this.store.select('members', (m) => m.tenant_id === tenantId);
    return { fields, rows: members.map((m) => ({ m, v: vals.get(m.member_id) ?? {} })) };
  }
  // 誕生日が withinDays 日以内(今日を含む)の有効な会員。権限チェックは呼び出し側で行う(自動配信用)。
  birthdayCandidates(tenantId, withinDays, nowMs = Date.now()) {
    const bday = this.forms.fields(tenantId, { includeDisabled: false }).find((f) => f.master_key === 'birthday');
    if (!bday) return [];
    const vals = new Map();
    for (const v of this.store.select('member_custom_values', (r) => r.tenant_id === tenantId && r.field_id === bday.field_id)) vals.set(v.member_id, v.value);
    const out = [];
    for (const m of this.store.select('members', (x) => x.tenant_id === tenantId && (x.status || 'ACTIVE') === 'ACTIVE')) {
      const b = this.#read(m, bday, { [bday.field_id]: vals.get(m.member_id) });
      const r = typeof b === 'string' ? daysUntilBirthday(b, nowMs) : null;
      if (r && r.days <= withinDays) out.push({ m, days: r.days, year: r.year });
    }
    return out.sort((a, b) => a.days - b.days);
  }
  // status: 'ACTIVE'(既定) | 'WITHDRAWN' | 'ALL'。退会済みは既定で除外される。
  // columns: 一覧に表示する項目(field_id)。指定すると、各会員に values: { field_id: 表示用の文字列 } が付く (権限のない項目は含まれない)
  search(actor, tenantId, { where, sort, limit = 100, offset = 0, status = 'ACTIVE', columns } = {}) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    if (!['ACTIVE', 'WITHDRAWN', 'ALL'].includes(status)) throw new ValidationError('statusが不正です');
    const { fields, rows: all } = this.#rows(actor, tenantId);
    const rows = status === 'ALL' ? all : all.filter((r) => (r.m.status || 'ACTIVE') === status);
    const fieldById = new Map(fields.map((f) => [f.field_id, f]));
    const bday = fields.find((f) => f.master_key === 'birthday' && f.enabled !== false);
    const get = (row, key) => {
      if (key === 'days_until_birthday') { const b = bday ? this.#read(row.m, bday, row.v) : null; return typeof b === 'string' ? daysUntilBirthday(b)?.days ?? null : null; }
      if (key === 'days_since_last_visit') return row.m.last_visit_at ? Math.floor((Date.now() - Date.parse(row.m.last_visit_at)) / 864e5) : Infinity;
      if (['visit_count', 'registered_at', 'last_visit_at', 'member_number', 'status'].includes(key)) return row.m[key] === '' ? null : row.m[key];
      const f = fieldById.get(key);
      if (!f) throw new ValidationError(`検索できない項目: ${key}`);
      return this.#read(row.m, f, row.v);
    };
    const test = (node, row) => {
      if (node.conditions) { const fn = (c) => test(c, row); return node.logic === 'OR' ? node.conditions.some(fn) : node.conditions.every(fn); }
      const f = fieldById.get(node.field);
      const raw = get(row, node.field);
      const flat = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.values ?? raw.value ?? displayValue(f, raw)) : raw;
      const isEmpty = flat === null || flat === '' || (Array.isArray(flat) && !flat.length);
      const list = Array.isArray(flat) ? flat : [flat];
      switch (node.op) {
        case 'eq': return list.some((x) => String(x) === String(node.value));
        case 'ne': return !list.some((x) => String(x) === String(node.value));
        case 'contains': return !isEmpty && list.some((x) => String(typeof x === 'object' ? displayValue(f, x) : x).includes(String(node.value)));
        case 'in': return list.some((x) => node.value.map(String).includes(String(x)));
        case 'gte': return !isEmpty && flat >= node.value;
        case 'lte': return !isEmpty && flat <= node.value;
        case 'empty': return isEmpty;
        case 'notEmpty': return !isEmpty;
        default: throw new ValidationError(`未対応の演算子: ${node.op}`);
      }
    };
    let res = where ? rows.filter((r) => test(where, r)) : rows;
    if (sort) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      const num = fieldById.get(sort.field)?.field_type === 'NUMBER' || ['visit_count', 'days_until_birthday'].includes(sort.field);
      res = res.sort((a, b) => {
        const x = get(a, sort.field), y = get(b, sort.field);
        if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1; // 空は常に末尾
        if (y === null || y === undefined) return -1;
        const sx = typeof x === 'object' ? displayValue(fieldById.get(sort.field), x) : x;
        const sy = typeof y === 'object' ? displayValue(fieldById.get(sort.field), y) : y;
        return dir * (num ? sx - sy : String(sx).localeCompare(String(sy), 'ja'));
      });
    }
    const colFields = (columns ?? []).map((id) => fieldById.get(id)).filter(Boolean);
    const members = res.slice(offset, offset + limit).map((r) => (colFields.length
      ? { ...r.m, values: Object.fromEntries(colFields.map((f) => { const v = this.#read(r.m, f, r.v); return [f.field_id, v === null ? '' : displayValue(f, v)]; })) } : r.m));
    return { total: res.length, members, _rows: res };
  }

  // ---- CSV (Excelで開けるUTF-8 BOM付き) 出力 ----
  #exportTable(actor, tenantId, { columns, where, sort, status }, format) {
    require_(actor, 'EXPORT_MEMBERS', tenantId);
    const { fields } = this.#rows(actor, tenantId);
    const fieldById = new Map(fields.map((f) => [f.field_id, f]));
    const BUILTIN = { member_number: '会員番号', registered_at: '登録日', status: 'ステータス', user_id: 'LINEユーザーID',
      last_visit_at: '最終来店日', visit_count: '来店回数' };
    const head = []; const getters = [];
    for (const c of columns) {
      if (BUILTIN[c]) {
        if (c === 'user_id' && !can(actor, 'EXPORT_PERSONAL_DATA')) throw new ValidationError('この項目の出力権限がありません: LINEユーザーID');
        if (['last_visit_at', 'visit_count'].includes(c) && !can(actor, 'EXPORT_VISITS')) throw new ValidationError('来店情報の出力権限がありません');
        head.push(BUILTIN[c]); getters.push(({ m }) => m[c]);
        continue;
      }
      const f = fieldById.get(c);
      if (!f) throw new ValidationError(`出力できない項目: ${c}`);
      if (f.sensitivity !== 'NORMAL' && !can(actor, 'EXPORT_PERSONAL_DATA')) throw new ValidationError(`個人情報の出力権限がありません: ${f.field_name}`);
      head.push(f.field_name); getters.push(({ m, v }) => { const r = this.#read(m, f, v); return r === null ? '' : displayValue(f, r); });
    }
    const { _rows } = this.search(actor, tenantId, { where, sort, limit: Infinity, status });
    const table = [head, ..._rows.map((r) => getters.map((g) => g(r)))];
    audit(this.store, { tenant_id: tenantId, actor, action: 'MEMBERS_EXPORT', target: format, detail: { columns, rows: _rows.length } });
    return table;
  }
  exportCsv(actor, tenantId, opts) {
    const table = this.#exportTable(actor, tenantId, opts, 'csv');
    const esc = (x) => {
      let s = String(x ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSVインジェクション対策
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return `\uFEFF${table.map((l) => l.map(esc).join(',')).join('\r\n')}\r\n`;
  }
  exportXlsx(actor, tenantId, opts) {
    return buildXlsx(this.#exportTable(actor, tenantId, opts, 'xlsx'));
  }
}
