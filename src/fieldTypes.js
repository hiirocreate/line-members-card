import { ValidationError } from './sanitize.js';

export const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'TEL', 'EMAIL', 'ZIP', 'URL',
  'SELECT', 'MULTI_SELECT', 'RADIO', 'CHECKBOX', 'YESNO', 'ADDRESS'];
export const CHOICE_TYPES = ['SELECT', 'MULTI_SELECT', 'RADIO'];
export const SENSITIVITY = ['NORMAL', 'PERSONAL', 'SENSITIVE'];
export const VISIBILITY = ['USER', 'STAFF', 'ADMIN', 'OPERATOR', 'SYSTEM'];
export const INPUT_SCRIPTS = ['', 'hiragana', 'katakana', 'alphabet']; // 読み仮名などの入力文字の指定
export const SCRIPT_LABEL = { hiragana: 'ひらがな', katakana: 'カタカナ', alphabet: 'アルファベット' };
export const ADDRESS_PARTS = ['postal', 'prefecture', 'city', 'street'];

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// ひらがな/カタカナの項目は、もう一方の文字で入力されても自動で変換する。アルファベットの項目は、全角の英字を半角にそろえる。
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
function normalizeScript(s, script, bad) {
  const sp = s.replace(/[\s\u3000]+/g, ' ');
  if (script === 'hiragana') { const v = toHira(sp); if (!/^[ぁ-ゖー・ ]+$/.test(v)) bad('ひらがなで入力してください'); return v; }
  if (script === 'katakana') { const v = toKata(sp); if (!/^[ァ-ヶー・ ]+$/.test(v)) bad('カタカナで入力してください'); return v; }
  if (script === 'alphabet') { const v = sp.normalize('NFKC'); if (!/^[A-Za-z .'\-]+$/.test(v)) bad('アルファベットで入力してください'); return v; }
  return sp;
}
// 検証して正規化済みの値を返す。不正なら ValidationError。空値は null。
export function validateValue(field, raw) {
  const label = field.field_name;
  if (isEmpty(raw) || (field.field_type === 'ADDRESS' && raw && typeof raw === 'object' &&
      ADDRESS_PARTS.every((p) => isEmpty(raw[p])))) {
    if (field.required) throw new ValidationError(`${label}は必須です`);
    return null;
  }
  const bad = (msg) => { throw new ValidationError(`${label}: ${msg}`); };
  const str = () => { if (typeof raw !== 'string') bad('文字列で入力してください'); return raw.trim(); };
  const optionValues = () => new Set((field.options ?? []).map((o) => o.value));
  switch (field.field_type) {
    case 'TEXT': {
      let s = str(); if (s.length > 200) bad('200文字以内');
      if (field.input_script) s = normalizeScript(s, field.input_script, bad);
      return s;
    }
    case 'TEXTAREA': { const s = str(); if (s.length > 2000) bad('2000文字以内'); return s; }
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || String(raw).trim() === '') bad('数値で入力してください');
      return n;
    }
    case 'DATE': { const s = str(); if (!validDate(s)) bad('正しい日付(YYYY-MM-DD)'); return s; }
    case 'TEL': {
      const s = str().replace(/[-\s]/g, '');
      if (!/^0\d{9,10}$/.test(s)) bad('電話番号の形式が正しくありません');
      return s;
    }
    case 'EMAIL': {
      const s = str();
      if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) bad('メールアドレスの形式が正しくありません');
      return s;
    }
    case 'ZIP': {
      const s = str().replace('-', '');
      if (!/^\d{7}$/.test(s)) bad('郵便番号の形式が正しくありません');
      return s;
    }
    case 'URL': {
      const s = str();
      let u; try { u = new URL(s); } catch { bad('URLの形式が正しくありません'); }
      if (!['http:', 'https:'].includes(u.protocol)) bad('http/https のURLのみ');
      return s;
    }
    case 'SELECT': case 'RADIO': {
      const v = typeof raw === 'object' ? raw.value : raw;
      const other = typeof raw === 'object' ? raw.other : undefined;
      if (!optionValues().has(v)) bad('選択肢にない値です');
      return packOther(field, v, other, bad);
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(raw)) bad('配列で指定してください');
      const set = optionValues();
      const vals = raw.map((x) => (typeof x === 'object' ? x.value : x));
      if (vals.some((v) => !set.has(v))) bad('選択肢にない値です');
      const other = raw.find((x) => typeof x === 'object' && x.other)?.other;
      const base = [...new Set(vals)];
      return field.allow_other && other && base.includes('その他') ? { values: base, other: cleanOther(other, bad) } : base;
    }
    case 'CHECKBOX': case 'YESNO': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      return bad('真偽値で指定してください');
    }
    case 'ADDRESS': {
      if (typeof raw !== 'object' || Array.isArray(raw)) bad('住所は分割項目で指定してください');
      const a = {};
      for (const p of ADDRESS_PARTS) {
        const v = raw[p];
        if (v !== undefined && v !== null && typeof v !== 'string') bad('住所は文字列で入力してください');
        a[p] = (v ?? '').trim();
        if (a[p].length > 200) bad('200文字以内');
      }
      if (a.postal && !/^\d{3}-?\d{4}$/.test(a.postal)) bad('郵便番号の形式が正しくありません');
      a.postal = a.postal.replace('-', '');
      return a;
    }
    default: return bad('未対応の入力形式');
  }
}

function cleanOther(other, bad) {
  if (typeof other !== 'string' || other.length > 200) bad('「その他」は200文字以内で入力してください');
  return other.trim();
}
function packOther(field, v, other, bad) {
  if (field.allow_other && v === 'その他' && other) return { value: v, other: cleanOther(other, bad) };
  return v;
}

// 検索・出力用: 値を人が読める文字列にする
export function displayValue(field, v) {
  if (v === null || v === undefined || v === '') return '';
  switch (field.field_type) {
    case 'CHECKBOX': case 'YESNO': return v ? 'はい' : 'いいえ';
    case 'MULTI_SELECT': return Array.isArray(v) ? v.join(', ') : `${v.values.join(', ')}(${v.other})`;
    case 'SELECT': case 'RADIO': return typeof v === 'object' ? `${v.value}(${v.other})` : String(v);
    case 'ADDRESS': return [v.postal && `〒${v.postal}`, v.prefecture, v.city, v.street].filter(Boolean).join(' ');
    default: return String(v);
  }
}
