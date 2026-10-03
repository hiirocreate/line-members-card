// LINEミニアプリ(LIFF)画面。サーバから受け取ったフォーム定義で動的に画面を作る。
// すべて textContent / value で DOM を組み立て、HTML文字列は使わない(XSS対策)。
// ログイン: LINEアプリ内では LIFF が自動でログイン済み。LINEのIDトークンでサーバが毎回本人確認し、会員とLINEアカウントを紐づける。
import { el, buildForm } from './formkit.js';

const root = document.getElementById('root');
let T, form, shop, qrTimer;

const mem = { // 無効環境(プライベートモード等)でも動くように try/catch
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作する */ } },
};
const flag = { // 再ログインの無限ループ防止
  get: () => { try { return sessionStorage.getItem('relogin'); } catch { return null; } },
  set: (v) => { try { v ? sessionStorage.setItem('relogin', '1') : sessionStorage.removeItem('relogin'); } catch { /* 無視 */ } },
};

function relogin() {
  if (flag.get()) return false;
  flag.set(true);
  try { liff.logout(); } catch { /* 未ログインでも続行 */ }
  liff.login({ redirectUri: location.href });
  return true;
}
// IDトークンの有効期限が近ければ先に再ログイン (期限切れの401を避ける)
function idToken() {
  const d = liff.getDecodedIDToken?.();
  if (d && d.exp * 1000 < Date.now() + 30_000 && relogin()) return null;
  return liff.getIDToken();
}

const api = async (path, { method = 'GET', body } = {}) => {
  const tok = idToken();
  if (!tok) return new Promise(() => {}); // 再ログインへ遷移中
  const r = await fetch(`/t/${T}/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (r.status === 401 && j.code === 'line_auth' && relogin()) return new Promise(() => {});
  if (!r.ok) throw Object.assign(new Error(j.error), { details: j.details });
  flag.set(false);
  return j;
};

function showError(e) {
  const box = el('div', { className: 'card err' }, el('div', {}, e.message));
  for (const d of e.details ?? []) box.append(el('div', {}, `・${d}`));
  root.prepend(box);
  window.scrollTo(0, 0);
}

function openLine(url) {
  try { liff.openWindow({ url, external: false }); } catch { location.href = url; }
}

// ---- 会員証 ----
async function drawQr(box) {
  try {
    const { code, expiresAt } = await api('qr');
    box.replaceChildren();
    new QRCode(box, { text: code, width: 180, height: 180 });
    clearTimeout(qrTimer);
    qrTimer = setTimeout(() => drawQr(box), Math.max(10_000, expiresAt - Date.now() - 60_000)); // 期限の1分前に自動更新
  } catch (e) { box.replaceChildren(el('div', { className: 'err' }, e.message)); }
}

function showCard(me) {
  clearTimeout(qrTimer);
  root.replaceChildren(el('h1', {}, me.shop));
  const qr = el('div', { id: 'qr' });
  root.append(el('div', { className: 'card', style: 'text-align:center' }, el('div', {}, '会員番号'), el('h2', {}, me.member_number), qr,
    el('small', {}, '来店時にこの画面を店舗スタッフにお見せください(QRは自動で更新されます)')));
  if (window.QRCode) drawQr(qr); else qr.append(el('div', { className: 'err' }, 'QRコードを表示できません'));
  document.onvisibilitychange = () => { if (!document.hidden && window.QRCode) drawQr(qr); }; // アプリに戻ったら最新に更新
  if (me.shopcardUrl) root.append(el('button', { onclick: () => openLine(me.shopcardUrl) }, '公式LINEのショップカードを開く'));
  if (me.notice) root.append(el('div', { className: 'card notice' }, me.notice));
  const dl = el('dl');
  for (const i of me.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value));
  root.append(el('div', { className: 'card' }, dl));
  const editable = form.fields.filter((f) => f.user_editable);
  if (editable.length) root.append(el('button', { className: 'sub', onclick: () => showEdit(me, editable) }, '登録情報を変更する'));
  root.append(el('button', { className: 'sub', style: 'background:#fff;color:#c00;border:1px solid #c00', onclick: () => showWithdraw(me) }, '退会する'));
}

function showEdit(me, editable) {
  const init = Object.fromEntries(me.items.map((i) => [i.field_id, i.raw]));
  root.replaceChildren(el('h1', {}, '登録情報の変更'), buildForm(editable, init, async (values) => {
    try { await api('me', { method: 'PATCH', body: { values } }); showCard(await api('me')); } catch (e) { showError(e); }
  }, '保存する'), el('button', { className: 'sub', onclick: () => showCard(me) }, '戻る'));
}

// ---- 退会 ----
function showWithdraw(me) {
  const reason = el('textarea', { maxLength: 200, placeholder: '(任意)退会の理由', style: 'width:100%;min-height:70px;box-sizing:border-box' });
  root.replaceChildren(el('h1', {}, '退会の確認'),
    el('div', { className: 'card' }, el('p', {}, '退会すると、会員証・来店の記録・店舗からのお知らせは利用できなくなります。'),
      el('p', {}, '登録情報は店舗に保管されたままとなり、再度登録すると同じ会員番号で再開できます。'), reason),
    el('button', { style: 'background:#c00', onclick: async () => {
      try { await api('withdraw', { method: 'POST', body: { reason: reason.value } }); showWithdrawn(); } catch (e) { showError(e); }
    } }, '退会する'),
    el('button', { className: 'sub', onclick: () => showCard(me) }, 'キャンセル'));
}
function showWithdrawn() {
  clearTimeout(qrTimer);
  root.replaceChildren(el('h1', {}, shop), el('div', { className: 'card' }, el('p', {}, '退会済みです。'), el('p', {}, 'もう一度ご利用になる場合は、再登録してください。')),
    el('button', { onclick: showRegister }, '再登録する'));
}

// ---- 登録 ----
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

// ---- 起動: 店舗tokenを特定 → LIFF初期化(自動ログイン) → 会員証 or 登録 ----
function findToken() {
  const q = new URLSearchParams(location.search);
  const st = new URLSearchParams((q.get('liff.state') || '').replace(/^\//, '').replace(/^\?/, ''));
  const t = q.get('t') || st.get('t');
  if (/^[0-9a-f]{32}$/.test(t || '')) { mem.set('t', t); return t; }
  const saved = mem.get('t'); // LINEのトーク/ホームから開き直した場合など、?t= が無いときは前回の店舗
  return /^[0-9a-f]{32}$/.test(saved || '') ? saved : null;
}

(async () => {
  try {
    T = findToken();
    if (!T) throw new Error('このURLは無効です。店舗のメニューから開き直してください。');
    const { liffId } = await (await fetch(`/app/config.json?t=${T}`)).json();
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; } // LINEアプリ内では通常ここは通らない(自動ログイン済み)
    const f = await (await fetch(`/t/${T}/form`)).json();
    if (f.error) throw new Error(f.error);
    form = f; shop = f.shop;
    const me = await api('me');
    if (me.registered) showCard(me); else if (me.withdrawn) showWithdrawn(); else showRegister();
  } catch (e) { root.replaceChildren(el('div', { className: 'card err' }, e.message)); }
})();
