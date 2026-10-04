// 店舗ごとの動的登録フォーム管理 (項目定義 = custom_fields)
import { randomBytes } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { FIELD_TYPES, CHOICE_TYPES, SENSITIVITY, VISIBILITY, INPUT_SCRIPTS } from './fieldTypes.js';
import { require_, canSeeField } from './permissions.js';
import { audit } from './audit.js';
import { assertNotBanned } from './master.js';
import { TEMPLATES, INTEREST_FIELD } from './templates.js';

const now = () => new Date().toISOString();
const nextId = (store, tenantId) => {
  const n = store.select('custom_fields', (f) => f.tenant_id === tenantId).length + 1;
  return `F${String(n).padStart(3, '0')}`;
};

export class FormService {
  constructor(store) { this.store = store; this.cache = new Map(); }

  // ---- テナント / 登録URL ----
  createTenant(actor, tenantId, name) {
    require_(actor, 'MASTER_EDIT', actor.tenantId);
    assertSafeText(name, '店舗名');
    this.store.insert('tenants', { tenant_id: tenantId, name, status: 'ACTIVE', form_version: 0, created_at: now() });
    return this.issueRegistrationUrl(actor, tenantId);
  }
  issueRegistrationUrl(actor, tenantId) {
    require_(actor, 'FORM_EDIT', tenantId);
    const token = randomBytes(16).toString('hex');
    this.store.insert('tenant_urls', { token, tenant_id: tenantId, enabled: true, created_at: now() });
    audit(this.store, { tenant_id: tenantId, actor, action: 'REG_URL_ISSUE', target: token.slice(0, 6) });
    return token;
  }
  // URL上のtokenだけで店舗を決めず、必ずバックエンドで有効性を検証する
  resolveTenant(token) {
    const u = typeof token === 'string' ? this.store.find('tenant_urls', (r) => r.token === token && r.enabled) : null;
    const t = u && this.store.find('tenants', (r) => r.tenant_id === u.tenant_id && r.status === 'ACTIVE');
    if (!t) throw new ValidationError('登録URLが無効です');
    return t.tenant_id;
  }

  // ---- 取得 (キャッシュ: 設定変更時に無効化) ----
  fields(tenantId, { includeDisabled = false } = {}) {
    return this.store.select('custom_fields', (f) => f.tenant_id === tenantId && (includeDisabled || f.enabled))
      .sort((a, b) => a.display_order - b.display_order);
  }
  // 会員向けフォーム定義 (USER 公開項目のみ)
  getUserForm(tenantId) {
    const hit = this.cache.get(tenantId);
    const version = this.store.find('tenants', (t) => t.tenant_id === tenantId)?.form_version ?? 0;
    if (hit && hit.version === version) return hit.form;
    const form = { tenant_id: tenantId, version, fields: this.fields(tenantId).filter((f) => canSeeField(null, f)) };
    this.cache.set(tenantId, { version, form });
    return form;
  }
  // 変更の確定: バージョンを上げて履歴を残し、キャッシュを無効化する。一括保存の最中は、最後に1回だけ確定する。
  #changed(tenantId, actor) {
    if (this.batch) { this.batch.dirty = true; return this.#version(tenantId) + 1; }
    return this.#commit(tenantId, actor);
  }
  #version(tenantId) {
    const t = this.store.find('tenants', (r) => r.tenant_id === tenantId);
    if (!t) throw new ValidationError('店舗が存在しません');
    return Number(t.form_version) || 0;
  }
  #commit(tenantId, actor) {
    const version = this.#version(tenantId) + 1;
    this.store.update('tenants', (r) => r.tenant_id === tenantId, { form_version: version });
    this.store.insert('form_versions', { tenant_id: tenantId, version, snapshot: this.fields(tenantId, { includeDisabled: true }),
      created_by: actor.id, created_at: now() });
    this.cache.delete(tenantId); // キャッシュ無効化
    return version;
  }
  version(tenantId) { return this.#version(tenantId); }

  // 一括保存: 画面で下書き編集した変更を、1回で反映する。全部成功するか、全部取り消すか(途中で失敗したら元に戻す)。
  // baseVersion: 編集を始めたときのバージョン。他の管理者が先に保存していたら、上書きせずに拒否する。
  // ops: { op:'add', tempId, masterKey, overrides } | { op:'add', tempId, field } | { op:'update', id, patch } | { op:'enable', id, enabled } | { op:'order', ids }
  //      id / ids には、同じ一括保存の中で作る項目の tempId も使える。
  applyBatch(actor, tenantId, { baseVersion, ops }) {
    require_(actor, 'FORM_EDIT', tenantId);
    if (!Array.isArray(ops) || ops.length === 0) throw new ValidationError('変更がありません');
    if (ops.length > 300) throw new ValidationError('一度に保存できる変更が多すぎます');
    if (baseVersion !== this.#version(tenantId)) throw Object.assign(new ValidationError('他の管理者が先に変更を保存しました。画面を読み込み直してください(未保存の変更は破棄されます)'), { code: 'conflict' });
    return this.store.transaction(['custom_fields', 'tenants', 'form_versions', 'audit_logs'], () => {
      const ids = new Map(); // tempId -> 実際の field_id
      const real = (id) => { const r = ids.get(id) ?? id; if (typeof r !== 'string') throw new ValidationError('項目の指定が不正です'); return r; };
      const names = new Map();
      let dirty = false;
      this.batch = { dirty: false };
      try {
        ops.forEach((o, i) => {
          const where = () => `(${i + 1}件目の変更${names.get(i) ? `: ${names.get(i)}` : ''})`;
          try {
            if (o.op === 'add') {
              names.set(i, o.field?.field_name ?? o.overrides?.field_name ?? o.masterKey);
              const f = o.masterKey ? this.addFromMaster(actor, tenantId, o.masterKey, o.overrides ?? {}) : this.addCustomField(actor, tenantId, o.field ?? {});
              if (o.tempId) ids.set(o.tempId, f.field_id);
            } else if (o.op === 'update') this.updateField(actor, tenantId, real(o.id), o.patch ?? {});
            else if (o.op === 'enable') this.setEnabled(actor, tenantId, real(o.id), !!o.enabled);
            else if (o.op === 'order') this.reorder(actor, tenantId, (o.ids ?? []).map(real));
            else throw new ValidationError('未対応の変更です');
          } catch (e) { if (e instanceof ValidationError) { e.message = `${e.message} ${where()}`; } throw e; }
        });
        dirty = this.batch.dirty;
      } finally { this.batch = null; }
      const version = dirty ? this.#commit(tenantId, actor) : this.#version(tenantId);
      audit(this.store, { tenant_id: tenantId, actor, action: 'FORM_BATCH_SAVE', target: 'form', detail: { operations: ops.length, version } });
      return { version, fields: this.fields(tenantId, { includeDisabled: true }) };
    });
  }
  versions(tenantId) { return this.store.select('form_versions', (v) => v.tenant_id === tenantId); }

  // ---- 入力検証 (保存時) ----
  #checkDef(tenantId, def, existing = null) {
    const f = { ...existing, ...def };
    if (!FIELD_TYPES.includes(f.field_type)) throw new ValidationError('入力形式が不正です');
    if (!f.field_name?.trim()) throw new ValidationError('項目名は必須です');
    if (f.field_name.length > 50) throw new ValidationError('項目名は50文字以内です');
    if (!VISIBILITY.includes(f.visibility)) throw new ValidationError('visibilityが不正です');
    if (!SENSITIVITY.includes(f.sensitivity)) throw new ValidationError('個人情報区分が不正です');
    for (const [v, l] of [[f.field_name, '項目名'], [f.placeholder, 'プレースホルダー'], [f.purpose_text, '利用目的']]) assertSafeText(v, l);
    if (CHOICE_TYPES.includes(f.field_type)) {
      if (!f.options?.length) throw new ValidationError('選択式の項目には選択肢が必要です');
      const vals = new Set();
      for (const op of f.options) {
        assertSafeText(op.label, '選択肢'); assertSafeText(op.value, '選択肢');
        if (!op.value?.trim()) throw new ValidationError('空の選択肢は設定できません');
        if (vals.has(op.value)) throw new ValidationError(`選択肢が重複しています: ${op.value}`);
        vals.add(op.value);
      }
      if (f.allow_other && !vals.has('その他')) throw new ValidationError('「その他」入力を許可するには選択肢に「その他」が必要です');
    } else if (f.options?.length) throw new ValidationError('選択式以外に選択肢は設定できません');
    if (f.input_script && (!INPUT_SCRIPTS.includes(f.input_script) || f.field_type !== 'TEXT')) throw new ValidationError('入力する文字の指定は、1行の文字項目(ひらがな/カタカナ/アルファベット)だけに設定できます');
    if (f.required && f.visibility !== 'USER') throw new ValidationError('会員に表示しない項目は必須にできません');
    // 配信への同意は任意でなければならない (同意しないと登録できない形にしない)
    if (f.consent_target && f.required) throw new ValidationError('配信への同意は必須にできません(任意のチェックボックスにしてください)');
    if (f.consent_target && !['LINE', 'EMAIL', 'MARKETING'].includes(f.consent_target)) throw new ValidationError('同意の対象が不正です');
    if (f.consent_target && f.field_type !== 'CHECKBOX') throw new ValidationError('同意項目はCHECKBOXにしてください');
    if (f.user_editable && f.visibility !== 'USER') throw new ValidationError('会員に表示しない項目はユーザー変更可にできません');
  }
  #normalizeOrder(tenantId) {
    this.fields(tenantId, { includeDisabled: true }).forEach((f, i) =>
      this.store.update('custom_fields', (r) => r.field_id === f.field_id && r.tenant_id === tenantId, { display_order: i + 1 }));
  }

  // ---- 標準項目(マスタ)の追加 ----
  addFromMaster(actor, tenantId, masterKey, overrides = {}) {
    require_(actor, 'FORM_EDIT', tenantId);
    const m = this.store.find('field_master', (r) => r.key === masterKey && r.enabled);
    if (!m) throw new ValidationError('マスタに存在しない項目です');
    const dup = this.store.find('custom_fields', (f) => f.tenant_id === tenantId && f.master_key === masterKey);
    if (dup) {
      if (dup.enabled) throw new ValidationError('この項目は既に追加されています');
      return this.setEnabled(actor, tenantId, dup.field_id, true); // 無効化されていた項目は再有効化(データ保持)
    }
    return this.#insert(actor, tenantId, {
      master_key: masterKey, field_name: m.label, field_type: m.field_type, options: m.options, purpose_text: m.purpose_text,
      sensitivity: m.sensitivity, consent_target: m.consent_target || null, input_script: m.input_script || '', ...overrides,
    });
  }

  // ---- カスタム項目の追加 ----
  addCustomField(actor, tenantId, def) {
    require_(actor, 'FORM_EDIT', tenantId);
    assertNotBanned(this.store, def.field_name, def.placeholder, def.purpose_text, (def.options ?? []).map((o) => o.label ?? o));
    return this.#insert(actor, tenantId, { master_key: null, sensitivity: 'PERSONAL', ...def });
  }

  #insert(actor, tenantId, def) {
    const options = (def.options ?? []).map((o, i) => (typeof o === 'string' ? { value: o, label: o, order: i + 1 } : { order: i + 1, label: o.value, ...o }));
    const row = {
      master_key: null, required: false, enabled: true, placeholder: '', purpose_text: '', user_editable: true, visibility: 'USER',
      sensitivity: 'PERSONAL', allow_other: false, consent_target: null, input_script: '', ...def, options,
    };
    this.#checkDef(tenantId, row);
    const field = { ...row, field_id: nextId(this.store, tenantId), tenant_id: tenantId,
      display_order: this.fields(tenantId, { includeDisabled: true }).length + 1, created_at: now(), updated_at: now() };
    this.store.insert('custom_fields', field);
    const version = this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: 'FIELD_ADD', target: field.field_id, detail: { name: field.field_name, type: field.field_type, version } });
    return field;
  }

  #get(tenantId, fieldId) {
    const f = this.store.find('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId);
    if (!f) throw new ValidationError('項目が存在しません');
    return f;
  }

  // ---- 更新: 表示名/必須/プレースホルダー/選択肢/利用目的/ユーザー編集可 ... (field_id・入力形式は不変) ----
  updateField(actor, tenantId, fieldId, patch) {
    require_(actor, 'FORM_EDIT', tenantId);
    const cur = this.#get(tenantId, fieldId);
    const ALLOWED = ['field_name', 'required', 'placeholder', 'purpose_text', 'user_editable', 'visibility', 'allow_other', 'options', 'consent_target', 'input_script'];
    const bad = Object.keys(patch).filter((k) => !ALLOWED.includes(k));
    if (bad.length) throw new ValidationError(`変更できない属性: ${bad.join(', ')}`);
    const next = { ...patch };
    if (next.options) next.options = next.options.map((o, i) => (typeof o === 'string' ? { value: o, label: o, order: i + 1 } : { order: i + 1, label: o.value, ...o }));
    if (!cur.master_key) assertNotBanned(this.store, next.field_name, next.placeholder, next.purpose_text, (next.options ?? []).map((o) => o.label));
    // 選択肢の削除は既存値を壊さないため禁止 (非表示=disabled にする運用)。値は変更不可、ラベル変更/追加のみ。
    if (next.options && cur.options) {
      const have = new Set(next.options.map((o) => o.value));
      const lost = cur.options.filter((o) => !have.has(o.value));
      if (lost.length) next.options = [...next.options, ...lost.map((o) => ({ ...o, hidden: true, order: next.options.length + 1 }))];
    }
    this.#checkDef(tenantId, next, cur);
    this.store.update('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId, { ...next, updated_at: now() });
    const version = this.#changed(tenantId, actor);
    const labelOnly = (k) => k === 'field_name' ? 'FIELD_RENAME' : k === 'required' ? 'FIELD_REQUIRED_CHANGE' : k === 'options' ? 'FIELD_OPTIONS_CHANGE'
      : k === 'purpose_text' ? 'FIELD_PURPOSE_CHANGE' : 'FIELD_UPDATE';
    for (const k of Object.keys(next)) {
      audit(this.store, { tenant_id: tenantId, actor, action: labelOnly(k), target: fieldId, detail: { key: k, from: cur[k], to: next[k], version } });
    }
    return this.#get(tenantId, fieldId);
  }

  // ---- 有効/無効 (削除ではなく無効化。既存データは保持) ----
  setEnabled(actor, tenantId, fieldId, enabled) {
    require_(actor, 'FORM_EDIT', tenantId);
    const cur = this.#get(tenantId, fieldId);
    if (cur.enabled === enabled) return cur;
    this.store.update('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId, { enabled, updated_at: now() });
    const version = this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: enabled ? 'FIELD_ENABLE' : 'FIELD_DISABLE', target: fieldId, detail: { version } });
    return this.#get(tenantId, fieldId);
  }
  // 店舗管理者の「削除」= 無効化
  removeField(actor, tenantId, fieldId) { return this.setEnabled(actor, tenantId, fieldId, false); }

  // 運営管理者のみ: 完全削除 (値も削除)
  hardDeleteField(actor, tenantId, fieldId) {
    require_(actor, 'FIELD_HARD_DELETE', tenantId);
    const cur = this.#get(tenantId, fieldId);
    const n = this.store.remove('member_custom_values', (v) => v.tenant_id === tenantId && v.field_id === fieldId);
    this.store.remove('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId);
    this.#normalizeOrder(tenantId);
    const version = this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: 'FIELD_HARD_DELETE', target: fieldId, detail: { name: cur.field_name, deletedValues: n, version } });
  }

  // ---- 並び替え (項目 / 選択肢) ----
  reorder(actor, tenantId, orderedFieldIds) {
    require_(actor, 'FORM_EDIT', tenantId);
    const all = this.fields(tenantId, { includeDisabled: true }).map((f) => f.field_id);
    const given = [...new Set(orderedFieldIds)];
    if (given.some((id) => !all.includes(id))) throw new ValidationError('存在しない項目が含まれています');
    // 重複/欠落は自動整理: 指定順 + 未指定(元の順)
    const final = [...given, ...all.filter((id) => !given.includes(id))];
    final.forEach((id, i) => this.store.update('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === id, { display_order: i + 1 }));
    const version = this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: 'FIELD_REORDER', target: 'form', detail: { order: final, version } });
  }
  reorderOptions(actor, tenantId, fieldId, orderedValues) {
    require_(actor, 'FORM_EDIT', tenantId);
    const cur = this.#get(tenantId, fieldId);
    const vals = new Set(cur.options.map((o) => o.value));
    if (orderedValues.some((v) => !vals.has(v))) throw new ValidationError('存在しない選択肢が含まれています');
    const rest = cur.options.map((o) => o.value).filter((v) => !orderedValues.includes(v));
    const order = [...new Set(orderedValues), ...rest];
    const options = order.map((v, i) => ({ ...cur.options.find((o) => o.value === v), order: i + 1 }));
    this.store.update('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId, { options, updated_at: now() });
    const version = this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: 'FIELD_OPTIONS_CHANGE', target: fieldId, detail: { order, version } });
  }

  // ---- テンプレート適用 (既存項目は残し、無い項目のみ追加) ----
  applyTemplate(actor, tenantId, name) {
    require_(actor, 'FORM_EDIT', tenantId);
    const tpl = TEMPLATES[name];
    if (!tpl) throw new ValidationError('テンプレートが存在しません');
    const added = [];
    for (const { key, required } of tpl.fields) {
      if (key === '__interest') {
        if (!this.store.find('custom_fields', (f) => f.tenant_id === tenantId && f.field_name === INTEREST_FIELD.field_name)) {
          added.push(this.addCustomField(actor, tenantId, { ...INTEREST_FIELD }));
        }
        continue;
      }
      const ex = this.store.find('custom_fields', (f) => f.tenant_id === tenantId && f.master_key === key);
      if (ex) { if (!ex.enabled) this.setEnabled(actor, tenantId, ex.field_id, true); continue; }
      added.push(this.addFromMaster(actor, tenantId, key, { required }));
    }
    audit(this.store, { tenant_id: tenantId, actor, action: 'FORM_TEMPLATE_APPLY', target: name, detail: { added: added.map((f) => f.field_id) } });
    return added;
  }

  // 運営管理者: 個人情報区分の変更
  setSensitivity(actor, tenantId, fieldId, sensitivity) {
    require_(actor, 'MASTER_EDIT', tenantId);
    if (!SENSITIVITY.includes(sensitivity)) throw new ValidationError('個人情報区分が不正です');
    this.#get(tenantId, fieldId);
    this.store.update('custom_fields', (r) => r.tenant_id === tenantId && r.field_id === fieldId, { sensitivity, updated_at: now() });
    this.#changed(tenantId, actor);
    audit(this.store, { tenant_id: tenantId, actor, action: 'FIELD_SENSITIVITY_CHANGE', target: fieldId, detail: { sensitivity } });
  }
}
