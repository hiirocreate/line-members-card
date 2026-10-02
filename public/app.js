// LINEミニアプリ(LIFF)画面。サーバから受け取ったフォーム定義で動的に画面を作る。
// すべて textContent / value で DOM を組み立て、HTML文字列は使わない(XSS対策)。
import { el, buildForm } from './formkit.js';

const root = document.getElementById('root');
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
