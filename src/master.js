// 登録項目マスタ (運営管理者がシステム全体で管理)。店舗はここから選んで使う。
import { ValidationError, assertSafeText } from './sanitize.js';
import { FIELD_TYPES, SENSITIVITY } from './fieldTypes.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';

const OCCUPATIONS = ['会社員', '自営業', '公務員', '学生', '主婦・主夫', 'その他'];
const o = (list) => list.map((value, i) => ({ value, label: value, order: i + 1 }));

export const DEFAULT_MASTER = [
  { key: 'name', label: '氏名', field_type: 'TEXT', sensitivity: 'PERSONAL', core_column: 'name' },
  { key: 'last_name', label: '姓', field_type: 'TEXT', sensitivity: 'PERSONAL' },
  { key: 'first_name', label: '名', field_type: 'TEXT', sensitivity: 'PERSONAL' },
  { key: 'phone', label: '電話番号', field_type: 'TEL', sensitivity: 'PERSONAL', core_column: 'phone',
    purpose_text: 'ご本人確認・ご連絡のために利用します。' },
  { key: 'email', label: 'メールアドレス', field_type: 'EMAIL', sensitivity: 'PERSONAL', core_column: 'email',
    purpose_text: '店舗からのお知らせをお送りするために利用します。' },
  { key: 'postal_code', label: '郵便番号', field_type: 'ZIP', sensitivity: 'PERSONAL' },
  { key: 'prefecture', label: '都道府県', field_type: 'TEXT', sensitivity: 'PERSONAL' },
  { key: 'city', label: '市区町村', field_type: 'TEXT', sensitivity: 'PERSONAL' },
  { key: 'address', label: '住所', field_type: 'ADDRESS', sensitivity: 'PERSONAL' },
  { key: 'birthday', label: '生年月日', field_type: 'DATE', sensitivity: 'PERSONAL',
    purpose_text: 'お誕生日特典の提供に利用します。' },
  { key: 'gender', label: '性別', field_type: 'RADIO', sensitivity: 'PERSONAL', options: o(['男性', '女性', '回答しない']) },
  { key: 'occupation', label: '職業', field_type: 'SELECT', sensitivity: 'NORMAL', options: o(OCCUPATIONS) },
  { key: 'marital_status', label: '結婚の有無', field_type: 'RADIO', sensitivity: 'PERSONAL', options: o(['未婚', '既婚', '回答しない']) },
  { key: 'has_children', label: '子どもの有無', field_type: 'YESNO', sensitivity: 'PERSONAL' },
  { key: 'line_display_name', label: 'LINE表示名', field_type: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'note', label: '備考', field_type: 'TEXTAREA', sensitivity: 'NORMAL' },
];

export function seedMaster(store, now = new Date().toISOString()) {
  for (const m of DEFAULT_MASTER) {
    if (store.find('field_master', (r) => r.key === m.key)) continue;
    store.insert('field_master', { options: [], purpose_text: '', core_column: '', enabled: true, created_at: now, ...m });
  }
  if (!store.find('settings', (r) => r.key === 'banned_terms')) {
    // 高リスク情報(医療/思想・信条/金融)は初期項目にせず、店舗が自由追加できないようにする
    store.insert('settings', { key: 'banned_terms', value: ['病歴', '病気', '診断', '疾患', '医療', '健康状態', '障害', '思想', '信条', '宗教',
      '政治', '犯罪', '口座', '銀行', 'クレジット', 'カード番号', '年収', '資産', '借入', 'マイナンバー', 'パスワード'] });
  }
}

export const getBannedTerms = (store) => store.find('settings', (r) => r.key === 'banned_terms')?.value ?? [];

export function assertNotBanned(store, ...texts) {
  const banned = getBannedTerms(store);
  for (const t of texts.flat().filter((x) => typeof x === 'string')) {
    const hit = banned.find((b) => t.includes(b));
    if (hit) throw new ValidationError(`「${hit}」に関する項目は店舗では追加できません(運営管理者のみ設定可)`);
  }
}

export function listMaster(store) { return store.select('field_master', (r) => r.enabled); }

// 運営管理者: システム標準項目の追加 (将来の「好きな商品」「来店きっかけ」等)
export function addMasterField(store, actor, def) {
  require_(actor, 'MASTER_EDIT', actor.tenantId);
  const { key, label, field_type, sensitivity = 'NORMAL' } = def;
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key ?? '')) throw new ValidationError('keyは英小文字/数字/_のみ');
  if (store.find('field_master', (r) => r.key === key)) throw new ValidationError('keyが重複しています');
  if (!FIELD_TYPES.includes(field_type)) throw new ValidationError('入力形式が不正です');
  if (!SENSITIVITY.includes(sensitivity)) throw new ValidationError('個人情報区分が不正です');
  assertSafeText(label, '項目名'); assertSafeText(def.purpose_text, '利用目的');
  for (const op of def.options ?? []) assertSafeText(op.label, '選択肢');
  const row = store.insert('field_master', { options: [], purpose_text: '', core_column: '', enabled: true,
    created_at: new Date().toISOString(), ...def, sensitivity });
  audit(store, { tenant_id: null, actor, action: 'MASTER_FIELD_ADD', target: key, detail: { label } });
  return row;
}

// 運営管理者: 禁止ワードの設定
export function setBannedTerms(store, actor, terms) {
  require_(actor, 'POLICY_EDIT', actor.tenantId);
  store.update('settings', (r) => r.key === 'banned_terms', { value: terms });
  audit(store, { tenant_id: null, actor, action: 'BANNED_TERMS_SET', target: 'banned_terms', detail: { count: terms.length } });
}
