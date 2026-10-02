// フォーム部品 (会員画面と管理画面のプレビューで共用)。HTML文字列は使わず DOM API のみ。
export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};
export const ADDR = [['postal', '郵便番号'], ['prefecture', '都道府県'], ['city', '市区町村'], ['street', '番地・建物']];
const INPUT = { TEXT: 'text', NUMBER: 'number', DATE: 'date', TEL: 'tel', EMAIL: 'email', ZIP: 'text', URL: 'url' };
const visibleOptions = (f) => (f.options || []).filter((o) => !o.hidden).sort((a, b) => a.order - b.order);

export function control(f, init) {
  const name = f.field_id;
  const other = f.allow_other ? el('input', { type: 'text', name: `${name}.other`, placeholder: 'その他の内容', maxLength: 200 }) : null;
  switch (f.field_type) {
    case 'TEXTAREA': return el('textarea', { name, placeholder: f.placeholder, value: init ?? '' });
    case 'SELECT': {
      const s = el('select', { name }, el('option', { value: '' }, '選択してください'), visibleOptions(f).map((o) => el('option', { value: o.value }, o.label)));
      s.value = (init && init.value) ?? init ?? '';
      return el('div', {}, s, other);
    }
    case 'RADIO': case 'YESNO': {
      const opts = f.field_type === 'YESNO' ? [{ value: 'true', label: 'はい' }, { value: 'false', label: 'いいえ' }] : visibleOptions(f);
      const cur = init === undefined || init === null ? null : String((init && init.value) ?? init);
      return el('div', {}, opts.map((o) => el('label', { className: 'o' }, el('input', { type: 'radio', name, value: o.value, checked: cur === o.value }), ` ${o.label}`)), other);
    }
    case 'MULTI_SELECT': {
      const cur = new Set(Array.isArray(init) ? init : (init && init.values) || []);
      return el('div', {}, visibleOptions(f).map((o) => el('label', { className: 'o' }, el('input', { type: 'checkbox', name, value: o.value, checked: cur.has(o.value) }), ` ${o.label}`)), other);
    }
    case 'CHECKBOX': return el('label', { className: 'o' }, el('input', { type: 'checkbox', name, checked: init === true }), ` ${f.field_name}`);
    case 'ADDRESS': return el('div', {}, ADDR.map(([p, ph]) => el('input', { type: 'text', name: `${name}.${p}`, placeholder: ph, maxLength: 200, value: (init && init[p]) || '' })));
    default: return el('input', { type: INPUT[f.field_type] || 'text', name, placeholder: f.placeholder, value: init ?? '' });
  }
}

// フォームの入力値 → API形式
export function collect(fields, formEl) {
  const out = {};
  for (const f of fields) {
    const n = f.field_id, q = (s) => formEl.querySelectorAll(`[name="${CSS.escape(s)}"]`);
    const other = formEl.querySelector(`[name="${CSS.escape(`${n}.other`)}"]`)?.value;
    switch (f.field_type) {
      case 'ADDRESS': out[n] = Object.fromEntries(ADDR.map(([p]) => [p, formEl.querySelector(`[name="${CSS.escape(`${n}.${p}`)}"]`).value])); break;
      case 'CHECKBOX': out[n] = q(n)[0].checked; break;
      case 'MULTI_SELECT': {
        const vals = [...q(n)].filter((i) => i.checked).map((i) => i.value);
        out[n] = other && vals.includes('その他') ? [...vals.filter((v) => v !== 'その他'), { value: 'その他', other }] : vals; break;
      }
      case 'RADIO': case 'YESNO': {
        const c = [...q(n)].find((i) => i.checked);
        out[n] = c ? (f.field_type === 'YESNO' ? c.value === 'true' : (other && c.value === 'その他' ? { value: c.value, other } : c.value)) : ''; break;
      }
      case 'SELECT': { const v = q(n)[0].value; out[n] = other && v === 'その他' ? { value: v, other } : v; break; }
      default: out[n] = q(n)[0].value;
    }
  }
  return out;
}

export function buildForm(fields, values, onSubmit, label) {
  const f = el('form', {});
  for (const fd of fields) {
    f.append(el('div', { className: 'f' },
      fd.field_type === 'CHECKBOX' ? null : el('span', { className: 'l' }, fd.field_name + (fd.required ? ' *' : '')),
      control(fd, values?.[fd.field_id]),
      fd.purpose_text ? el('small', {}, fd.purpose_text) : null));
  }
  f.append(el('button', { type: 'submit' }, label));
  f.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(collect(fields, f)); });
  return f;
}

