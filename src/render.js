// 動的フォームのHTML生成 (スマホプレビュー兼 会員登録画面)。値はすべてエスケープする。
import { escapeHtml as h } from './sanitize.js';
import { ADDRESS_PARTS } from './fieldTypes.js';

const INPUT_TYPE = { TEXT: 'text', NUMBER: 'number', DATE: 'date', TEL: 'tel', EMAIL: 'email', ZIP: 'text', URL: 'url' };
const ADDR_LABEL = { postal: '郵便番号', prefecture: '都道府県', city: '市区町村', street: '番地・建物' };

function control(f) {
  const n = h(f.field_id), req = f.required ? ' required' : '', ph = h(f.placeholder);
  const opts = (f.options ?? []).filter((o) => !o.hidden).sort((a, b) => a.order - b.order);
  const other = f.allow_other ? `<input type="text" name="${n}.other" placeholder="その他の内容" maxlength="200">` : '';
  switch (f.field_type) {
    case 'TEXTAREA': return `<textarea name="${n}" placeholder="${ph}" maxlength="2000"${req}></textarea>`;
    case 'SELECT': return `<select name="${n}"${req}><option value="">選択してください</option>${opts.map((o) => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select>${other}`;
    case 'RADIO': return opts.map((o) => `<label><input type="radio" name="${n}" value="${h(o.value)}"${req}> ${h(o.label)}</label>`).join('') + other;
    case 'MULTI_SELECT': return opts.map((o) => `<label><input type="checkbox" name="${n}" value="${h(o.value)}"> ${h(o.label)}</label>`).join('') + other;
    case 'CHECKBOX': return `<label><input type="checkbox" name="${n}" value="true"${req}> ${h(f.field_name)}</label>`;
    case 'YESNO': return ['true', 'false'].map((v) => `<label><input type="radio" name="${n}" value="${v}"${req}> ${v === 'true' ? 'はい' : 'いいえ'}</label>`).join('');
    case 'ADDRESS': return ADDRESS_PARTS.map((p) => `<input type="text" name="${n}.${p}" placeholder="${ADDR_LABEL[p]}" maxlength="200">`).join('');
    default: return `<input type="${INPUT_TYPE[f.field_type] ?? 'text'}" name="${n}" placeholder="${ph}"${req}>`;
  }
}

export function renderForm({ shopName, fields, action = '#' }) {
  const body = fields.map((f) => `<div class="f"><label class="l">${h(f.field_name)}${f.required ? ' <b>*</b>' : ''}</label>${control(f)}${f.purpose_text ? `<small>${h(f.purpose_text)}</small>` : ''}</div>`).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(shopName)} 会員登録</title><style>body{font-family:sans-serif;max-width:480px;margin:0 auto;padding:16px}.f{margin:14px 0}.l{display:block;font-weight:bold}
input[type=text],input[type=tel],input[type=email],input[type=number],input[type=date],input[type=url],select,textarea{width:100%;padding:8px;box-sizing:border-box;margin-top:4px}
label{display:block}small{color:#666}button{width:100%;padding:12px;margin-top:12px}</style>
<h1>${h(shopName)}</h1><h2>会員登録</h2><form method="post" action="${h(action)}">${body}<button type="submit">確認する</button></form></html>`;
}
