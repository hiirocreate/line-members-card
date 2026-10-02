// LINEミニアプリ(LIFF)画面。サーバから受け取ったフォーム定義で動的に画面を作る。
// すべて textContent / value で DOM を組み立て、HTML文字列は使わない(XSS対策)。
const root = document.getElementById('root');
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};
let T, idToken, form, shop;

const api = async (path, { method = 'GET', body } = {}) => {
  const r = await fetch(`/t/${T}/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { details: j.details });
  return j;
};

function showError(e) {
  const box = el('div', { className: 'card err' }, el('div', {}, e.message));
  for (const d of e.details ?? []) box.append(el('div', {}, `・${d}`));
  root.prepend(box);
  window.scrollTo(0, 0);
}

const ADDR = [['postal', '郵便番号'], ['prefecture', '都道府県'], ['city', '市区町村'], ['street', '番地・建物']];
const INPUT = { TEXT: 'text', NUMBER: 'number', DATE: 'date', TEL: 'tel', EMAIL: 'email', ZIP: 'text', URL: 'url' };
const visibleOptions = (f) => (f.options || []).filter((o) => !o.hidden).sort((a, b) => a.order - b.order);

function control(f, init) {
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
function collect(fields, formEl) {
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

function buildForm(fields, values, onSubmit, label) {
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

function showCard(me) {
  root.replaceChildren(el('h1', {}, me.shop));
  const card = el('div', { className: 'card' }, el('div', {}, '会員番号'), el('h2', {}, me.member_number), el('div', { id: 'qr' }));
  root.append(card);
  if (window.QRCode) new QRCode(card.querySelector('#qr'), { text: me.member_number, width: 160, height: 160 });
  if (me.notice) root.append(el('div', { className: 'card notice' }, me.notice));
  const dl = el('dl');
  for (const i of me.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value));
  root.append(el('div', { className: 'card' }, dl));
  const editable = form.fields.filter((f) => f.user_editable);
  if (editable.length) root.append(el('button', { className: 'sub', onclick: () => showEdit(me, editable) }, '登録情報を変更する'));
}

function showEdit(me, editable) {
  const init = Object.fromEntries(me.items.map((i) => [i.field_id, i.raw]));
  root.replaceChildren(el('h1', {}, '登録情報の変更'), buildForm(editable, init, async (values) => {
    try { await api('me', { method: 'PATCH', body: { values } }); showCard(await api('me')); } catch (e) { showError(e); }
  }, '保存する'));
}

function showRegister() {
  root.replaceChildren(el('h1', {}, shop), el('h2', {}, '会員登録'), buildForm(form.fields, null, async (values) => {
    try {
      const c = await api('confirm', { method: 'POST', body: { values } });
      const dl = el('dl'); for (const i of c.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value || '（未入力）'));
      root.replaceChildren(el('h1', {}, '登録内容の確認'), el('div', { className: 'card' }, dl),
        el('button', { onclick: async () => { try { await api('register', { method: 'POST', body: { values, confirmed: true } }); showCard(await api('me')); } catch (e) { showError(e); } } }, '登録する'),
        el('button', { className: 'sub', onclick: showRegister }, '戻る'));
    } catch (e) { showError(e); }
  }, '確認する'));
}

(async () => {
  try {
    const { liffId } = await (await fetch('/app/config.json')).json();
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    // 店舗token: ミニアプリURLの ?t= (liff.state 経由の場合も考慮)
    const q = new URLSearchParams(location.search);
    const st = new URLSearchParams((q.get('liff.state') || '').replace(/^\//, '').replace(/^\?/, ''));
    T = q.get('t') || st.get('t');
    if (!/^[0-9a-f]{32}$/.test(T || '')) throw new Error('このURLは無効です。店舗のメニューから開き直してください。');
    idToken = liff.getIDToken();
    const f = await (await fetch(`/t/${T}/form`)).json();
    if (f.error) throw new Error(f.error);
    form = f; shop = f.shop;
    const me = await api('me');
    me.registered ? showCard(me) : showRegister();
  } catch (e) { root.replaceChildren(el('div', { className: 'card err' }, e.message)); }
})();
