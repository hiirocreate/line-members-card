// テーブル型ストア。Google Sheets のシート構成 (members / custom_fields / member_custom_values ...)
// とそのまま対応する。他DB/SheetsAPI実装へ差し替える場合は同じメソッドを実装する。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// シートごとのヘッダー。配列/オブジェクト列は JSON 文字列でセルに保存する。
export const SHEETS = {
  tenants: ['tenant_id', 'name', 'status', 'form_version', 'created_at'],
  tenant_urls: ['token', 'tenant_id', 'enabled', 'created_at'],
  members: ['member_id', 'tenant_id', 'user_id', 'member_number', 'name', 'phone', 'email',
    'registered_at', 'last_visit_at', 'visit_count', 'status', 'form_version'],
  field_master: ['key', 'label', 'field_type', 'sensitivity', 'purpose_text', 'core_column', 'options',
    'enabled', 'created_at'],
  custom_fields: ['field_id', 'tenant_id', 'master_key', 'field_name', 'field_type', 'required', 'enabled',
    'display_order', 'options', 'placeholder', 'purpose_text', 'user_editable', 'visibility', 'sensitivity',
    'allow_other', 'consent_target', 'created_at', 'updated_at'],
  member_custom_values: ['member_id', 'tenant_id', 'field_id', 'value', 'updated_at'],
  member_consents: ['member_id', 'tenant_id', 'channel', 'granted', 'updated_at'],
  form_versions: ['tenant_id', 'version', 'snapshot', 'created_by', 'created_at'],
  audit_logs: ['log_id', 'tenant_id', 'actor', 'action', 'target', 'detail', 'created_at'],
  settings: ['key', 'value'],
};
const JSON_COLS = new Set(['options', 'snapshot', 'detail', 'value']);

export class Store {
  constructor(file = null) {
    this.file = file;
    this.t = Object.fromEntries(Object.keys(SHEETS).map((k) => [k, []]));
    if (file && existsSync(file)) this.t = { ...this.t, ...JSON.parse(readFileSync(file, 'utf8')) };
  }
  select(table, pred = () => true) { return this.t[table].filter(pred).map((r) => structuredClone(r)); }
  find(table, pred) { return this.select(table, pred)[0] ?? null; }
  insert(table, row) { this.t[table].push(structuredClone(row)); this.#save(); return row; }
  update(table, pred, patch) {
    let n = 0;
    for (const r of this.t[table]) if (pred(r)) { Object.assign(r, structuredClone(patch)); n++; }
    if (n) this.#save();
    return n;
  }
  remove(table, pred) { // 運営管理者の完全削除専用。通常運用では使わない
    const before = this.t[table].length;
    this.t[table] = this.t[table].filter((r) => !pred(r));
    this.#save();
    return before - this.t[table].length;
  }
  #save() { if (this.file) writeFileSync(this.file, JSON.stringify(this.t)); }

  // Google Sheets 形式 (ヘッダー行 + セル値) へ出力/取り込み
  exportSheets() {
    const out = {};
    for (const [name, headers] of Object.entries(SHEETS)) {
      out[name] = [headers, ...this.t[name].map((r) => headers.map((h) => {
        const v = r[h];
        return JSON_COLS.has(h) && v !== undefined ? JSON.stringify(v) : (v ?? '');
      }))];
    }
    return out;
  }
  importSheets(sheets) {
    for (const [name, [headers, ...rows]] of Object.entries(sheets)) {
      this.t[name] = rows.map((cells) => Object.fromEntries(headers.map((h, i) => {
        const c = cells[i];
        return [h, JSON_COLS.has(h) && c !== '' ? JSON.parse(c) : c];
      })));
    }
    this.#save();
  }
}
