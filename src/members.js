// 会員登録・更新・検索・出力。固定項目は members、それ以外は member_custom_values に保存。
import { ValidationError } from './sanitize.js';
import { validateValue, displayValue } from './fieldTypes.js';
import { require_, canSeeField, can } from './permissions.js';
import { audit } from './audit.js';
import { buildXlsx } from './xlsx.js';

const now = () => new Date().toISOString();
export const UNREGISTERED = '未登録';

export class MemberService {
  constructor(store, forms) { this.store = store; this.forms = forms; }

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
    if (this.store.find('members', (m) => m.tenant_id === tenantId && m.user_id === userId)) throw new ValidationError('既に登録されています');
    const form = this.forms.getUserForm(tenantId);
    const out = this.#validate(form.fields, input, { requireAll: true });
    const seq = this.store.select('members', (m) => m.tenant_id === tenantId).length + 1;
    const member = { member_id: `M${String(seq).padStart(3, '0')}`, tenant_id: tenantId, user_id: userId, member_number: String(seq).padStart(6, '0'),
      name: '', phone: '', email: '', registered_at: now(), last_visit_at: '', visit_count: 0, status: 'ACTIVE', form_version: form.version };
    this.store.insert('members', member);
    for (const f of form.fields) {
      const v = out.get(f.field_id);
      if (v !== null) this.#write(member, f, v);
      this.#setConsent(member, f, v === true);
    }
    audit(this.store, { tenant_id: tenantId, actor: { id: userId }, action: 'MEMBER_REGISTER', target: member.member_id, detail: { version: form.version } });
    return this.store.find('members', (m) => m.member_id === member.member_id && m.tenant_id === tenantId);
  }

  // ---- 来店記録 ----
  recordVisit(actor, tenantId, memberId) {
    require_(actor, 'MEMBER_EDIT', tenantId);
    const m = this.#member(tenantId, memberId);
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === memberId, { visit_count: m.visit_count + 1, last_visit_at: now() });
  }

  // ---- 変更 ----
  updateByUser(tenantId, userId, input) {
    const m = this.store.find('members', (r) => r.tenant_id === tenantId && r.user_id === userId);
    if (!m) throw new ValidationError('会員が存在しません');
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
  search(actor, tenantId, { where, sort, limit = 100, offset = 0 } = {}) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    const { fields, rows } = this.#rows(actor, tenantId);
    const fieldById = new Map(fields.map((f) => [f.field_id, f]));
    const get = (row, key) => {
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
      const num = fieldById.get(sort.field)?.field_type === 'NUMBER' || sort.field === 'visit_count';
      res = res.sort((a, b) => {
        const x = get(a, sort.field), y = get(b, sort.field);
        if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1; // 空は常に末尾
        if (y === null || y === undefined) return -1;
        const sx = typeof x === 'object' ? displayValue(fieldById.get(sort.field), x) : x;
        const sy = typeof y === 'object' ? displayValue(fieldById.get(sort.field), y) : y;
        return dir * (num ? sx - sy : String(sx).localeCompare(String(sy), 'ja'));
      });
    }
    return { total: res.length, members: res.slice(offset, offset + limit).map((r) => r.m), _rows: res };
  }

  // ---- CSV (Excelで開けるUTF-8 BOM付き) 出力 ----
  #exportTable(actor, tenantId, { columns, where, sort }, format) {
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
    const { _rows } = this.search(actor, tenantId, { where, sort, limit: Infinity });
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
