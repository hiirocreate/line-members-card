// LINEミニアプリ(LIFF)画面。サーバから受け取ったフォーム定義で動的に画面を作る。
// すべて textContent / value で DOM を組み立て、HTML文字列は使わない(XSS対策)。
// ログイン: LINEアプリ内では LIFF が自動でログイン済み。LINEのIDトークンでサーバが毎回本人確認し、会員とLINEアカウントを紐づける。
import { el, buildForm } from './formkit.js';
import { drawCard, applyPage, loadImage, makeQr } from './cardkit.js';

const root = document.getElementById('root');
let T, form, shop, qrTimer, meTimer;

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
// 日時は日本時間で表示 (サーバはUTCのISO文字列で保持)
const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? fmt.format(new Date(iso)) : null);
const visitText = (me) => (me.last_visit_at ? `最終来店: ${fmtDate(me.last_visit_at)}(来店 ${me.visit_count}回)` : '最終来店: まだ来店記録がありません');
const cardData = (me) => ({ shop: me.shop, name: me.card_data?.name ?? '', memberNumber: me.member_number, registeredAt: me.card_data?.registered_at ?? me.registered_at, lastVisitAt: me.last_visit_at, visitCount: me.visit_count });
const assetImage = (id) => (id ? loadImage(`/t/${T}/asset/${id}`).catch(() => null) : Promise.resolve(null)); // 画像が読めなくてもカードは表示する

// 会員証QR: 署名付き・5分有効。期限の1分前に自動更新 (スクリーンショットの使い回し防止)
function showCard(me) {
  clearTimeout(qrTimer); clearInterval(meTimer);
  const design = me.card;
  applyPage(design.page);
  let cur = me, logo = null, bg = null, qrCanvas = null;
  const canvas = el('canvas', { className: 'card-canvas', 'aria-label': '会員証' });
  const qrBox = el('div', { id: 'qr' });
  const paint = () => drawCard(canvas, design, cardData(cur), { logo, bg, qr: design.qr === 'inside' ? qrCanvas : null });
  const visit = el('div', { id: 'visit', style: 'margin:10px 0;font-weight:bold;text-align:center' }, visitText(me));

  async function refreshQr() {
    try {
      const { code, expiresAt } = await api('qr');
      if (design.qr === 'inside') { qrCanvas = makeQr(code, 190); paint(); } else { qrBox.replaceChildren(); new QRCode(qrBox, { text: code, width: 180, height: 180 }); }
      clearTimeout(qrTimer);
      qrTimer = setTimeout(refreshQr, Math.max(10_000, expiresAt - Date.now() - 60_000));
    } catch (e) { (design.qr === 'inside' ? visit : qrBox).append(el('div', { className: 'err' }, e.message)); }
  }
  const refreshMe = async () => { try { cur = await api('me'); visit.textContent = visitText(cur); paint(); } catch { /* 一時的な失敗は無視 */ } };

  root.replaceChildren(el('h1', {}, design.shopName.text || me.shop), canvas, visit); // 見出しも、デザインで設定した店舗名に合わせる
  if (design.qr === 'below') root.append(el('div', { className: 'card', style: 'text-align:center' }, qrBox));
  root.append(el('small', { style: 'display:block;text-align:center;margin-bottom:8px' }, '来店時にこの画面を店舗スタッフにお見せください(QRは自動で更新されます)'));
  paint(); // 画像の読み込み前にも、まず文字だけで描く
  Promise.all([assetImage(design.logo.imageId), assetImage(design.background.imageId)]).then(([l, b]) => { logo = l; bg = b; paint(); });
  if (window.QRCode) refreshQr(); else root.append(el('div', { className: 'err' }, 'QRコードを表示できません'));
  // 店舗で来店が記録されたら、開いたままでも更新される (表示中のみ20秒ごと / アプリに戻ったとき)
  meTimer = setInterval(() => { if (!document.hidden) refreshMe(); }, 20_000);
  document.onvisibilitychange = () => { if (!document.hidden) { refreshMe(); if (window.QRCode) refreshQr(); } };

  if (design.page.welcomeText) root.append(el('div', { className: 'card welcome' }, design.page.welcomeText));
  root.append(el('button', { className: 'sub', onclick: () => showCardImage(cur, design, logo, bg) }, 'カード画像を保存'));
  if (me.shopcardUrl && design.page.showShopcard) root.append(el('button', { onclick: () => openLine(me.shopcardUrl) }, '公式LINEのショップカードを開く'));
  if (me.notice) root.append(el('div', { className: 'card notice' }, me.notice));
  // LINEでのお知らせの受け取り (オン/オフ)。登録時に同意していなくても、ここからいつでも変更できる
  const lineField = form.fields.find((f) => f.consent_target === 'LINE' && f.user_editable);
  if (lineField) {
    const on = !!me.consents?.LINE;
    root.append(el('div', { className: 'card' }, el('b', {}, 'LINEでのお知らせ'), el('div', { style: 'margin:6px 0' }, on ? '現在: 受け取る(オン)' : '現在: 受け取らない(オフ)'),
      lineField.purpose_text ? el('small', {}, lineField.purpose_text) : null,
      el('button', { className: on ? 'sub' : '', onclick: async () => { try { await api('me', { method: 'PATCH', body: { values: { [lineField.field_id]: !on } } }); showCard(await api('me')); } catch (e) { showError(e); } } }, on ? 'お知らせを受け取らない' : 'お知らせを受け取る')));
  }
  if (design.page.showInfoList) {
    const dl = el('dl');
    for (const i of me.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value));
    root.append(el('div', { className: 'card' }, dl));
  }
  const editable = form.fields.filter((f) => f.user_editable);
  if (editable.length) root.append(el('button', { className: 'sub', onclick: () => showEdit(me, editable) }, '登録情報を変更する'));
  root.append(el('button', { className: 'sub', style: 'background:transparent;color:#c00;border:1px solid #c00', onclick: () => showWithdraw(me) }, '退会する'));
}

// カードを画像として表示 (LINE内ブラウザは直接ダウンロードできないことがあるため、長押しで保存してもらう)
// 保存用の画像にはQRを含めない (QRは5分で失効するため)
function showCardImage(me, design, logo, bg) {
  const c = document.createElement('canvas');
  drawCard(c, { ...design, qr: 'below' }, cardData(me), { logo, bg });
  const img = el('img', { src: c.toDataURL('image/png'), alt: '会員証', style: 'width:100%;border-radius:12px' });
  root.replaceChildren(el('h1', {}, '会員証の画像'), img, el('p', { className: 'hint' }, '画像を長押しして「写真に追加」などで保存できます。'),
    el('button', { className: 'sub', onclick: () => showCard(me) }, '戻る'));
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
  clearTimeout(qrTimer); clearInterval(meTimer);
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
// URLのパラメータ (?t=… / ?link=…)。LIFFの仕様で liff.state に入る場合も考慮する
function findParam(name) {
  const q = new URLSearchParams(location.search);
  const st = new URLSearchParams((q.get('liff.state') || '').replace(/^\//, '').replace(/^\?/, ''));
  return q.get(name) || st.get(name);
}
function findToken() {
  const t = findParam('t');
  if (/^[0-9a-f]{32}$/.test(t || '')) { mem.set('t', t); return t; }
  const saved = mem.get('t'); // LINEのトーク/ホームから開き直した場合など、?t= が無いときは前回の店舗
  return /^[0-9a-f]{32}$/.test(saved || '') ? saved : null;
}

// 管理者のLINE連携 (二段階認証でLINEにコードを受け取るため): 管理画面で発行したリンクをスマホのLINEで開く
async function linkMode(link) {
  root.replaceChildren(el('h1', {}, 'LINEの連携'), el('div', { className: 'card' }, '確認しています...'));
  const { liffId } = await (await fetch(`/app/config.json?link=${encodeURIComponent(link)}`)).json();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
  const r = await fetch('/api/admin/line-link/complete', { method: 'POST', body: JSON.stringify({ link, idToken: liff.getIDToken() }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '連携できませんでした');
  root.replaceChildren(el('h1', {}, 'LINEの連携'), el('div', { className: 'card' }, el('p', {}, '連携が完了しました。管理画面に戻って、ご確認ください。'),
    el('p', { className: 'hint' }, j.notified ? 'LINEに確認のメッセージを送りました。' : '確認のメッセージを送れませんでした。公式アカウントを友だち追加しているか、ブロックしていないか確認してください(連携自体は完了しています)。')));
}

(async () => {
  try {
    const link = findParam('link');
    if (link) return await linkMode(link);
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
