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

// 管理画面の「会員証デザイン」のプレビュー用 (?preview=1): 実際の会員画面と同じ描画コードを、サンプルのデータで動かす。通信はしない
const PREVIEW = new URLSearchParams(location.search).has('preview');
let previewMe = null, previewUrls = {};
const previewApi = async (path) => {
  if (path === 'me') return previewMe;
  if (path === 'qr') return { code: 'PREVIEW-SAMPLE', expiresAt: Date.now() + 3_600_000 };
  if (path === 'coupons') return { coupons: previewMe.sampleCoupon ? [{ state: 'available', coupon: { coupon_id: 'sample', title: '誕生日クーポン', benefit: '10%OFF', valid_until: '' } }] : [] };
  if (path === 'consent' || path === 'prefs') return { ok: true };
  throw new Error('プレビューでは使えません');
};
const api = async (path, { method = 'GET', body } = {}) => {
  if (PREVIEW) return previewApi(path);
  const tok = idToken();
  if (!tok) return new Promise(() => {}); // 再ログインへ遷移中
  const r = await fetch(`/t/${T}/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (r.status === 401 && j.code === 'line_auth' && relogin()) return new Promise(() => {});
  if (!r.ok) throw Object.assign(new Error(j.error), { details: j.details, code: j.code, addUrl: j.addUrl });
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
const cardData = (me) => ({ shop: me.shop, name: me.card_data?.name ?? '', nameParts: me.card_data?.parts ?? null, rank: me.rank ?? null, memberNumber: me.member_number, registeredAt: me.card_data?.registered_at ?? me.registered_at, lastVisitAt: me.last_visit_at, visitCount: me.visit_count });
const assetImage = (id) => (id ? loadImage(PREVIEW ? (previewUrls[id] ?? '') : `/t/${T}/asset/${id}`).catch(() => null) : Promise.resolve(null)); // 画像が読めなくてもカードは表示する

// 会員証QR: 署名付き・5分有効。期限の1分前に自動更新 (スクリーンショットの使い回し防止)
function showCard(me, opts = {}) {
  clearTimeout(qrTimer); clearInterval(meTimer);
  const storeMode = me.scan_mode === 'STORE_QR'; // 店舗のQRを会員が読み取る方式の店舗: 会員証のQRは出さない
  const design = storeMode ? { ...me.card, qr: 'below' } : me.card;
  applyPage(design.page);
  let cur = me, logo = null, bg = null, qrCanvas = null, privacy = !!opts.privacy; // privacy: 個人情報とQRを隠している状態
  const canvas = el('canvas', { className: 'card-canvas', 'aria-label': '会員証' });
  const qrBox = el('div', { id: 'qr' });
  const qrCard = el('div', { className: 'card mini', style: 'text-align:center' }, qrBox);
  const qrHidden = el('div', { className: 'card', style: 'text-align:center;opacity:.8' }, 'QRコードは非表示です');
  const hint = el('small', { className: 'mini-t' });
  const visit = el('div', { id: 'visit', style: 'margin:4px 0;font-size:13px;font-weight:bold;text-align:center' });
  const infoCard = el('div', { className: 'card' });
  const dl = el('dl'); for (const i of me.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value)); infoCard.append(dl);
  const toggle = el('button', { className: 'chip' }, '');
  const paint = () => drawCard(canvas, design, cardData(cur), { logo, bg, qr: design.qr === 'inside' && !privacy ? qrCanvas : null, privacy });
  const cardHasVisit = !!(design.fields.lastVisit || design.fields.visitCount); // カードの中に最終来店・来店回数が出ているときは、カードの下には出さない
  const rankLine = () => { const n = cur.rank?.next; return n ? (cur.rank.demoted ? `ご来店で「${n.title}」に戻ります` : `「${n.title}」まであと${n.remaining}回`) : ''; };
  const renderVisit = () => { visit.textContent = [cardHasVisit ? '' : (privacy ? '最終来店: ••••' : visitText(cur)), rankLine()].filter(Boolean).join(' / '); visit.style.display = visit.textContent ? '' : 'none'; };

  async function refreshQr() {
    if (privacy || storeMode) return; // 隠している間(と、店舗のQRを読み取る方式のとき)は、QRを取得も表示もしない
    try {
      const { code, expiresAt } = await api('qr');
      if (privacy) return;
      if (design.qr === 'inside') { qrCanvas = makeQr(code, 190); paint(); } else { qrBox.replaceChildren(); new QRCode(qrBox, { text: code, width: 150, height: 150 }); }
      clearTimeout(qrTimer);
      qrTimer = setTimeout(refreshQr, Math.max(10_000, expiresAt - Date.now() - 60_000));
    } catch (e) { (design.qr === 'inside' ? visit : qrBox).append(el('div', { className: 'err' }, e.message)); }
  }
  const refreshMe = async () => { try { cur = await api('me'); renderVisit(); paint(); } catch { /* 一時的な失敗は無視 */ } };

  // 隠す/表示する: 個人情報(氏名・来店・登録情報の一覧)とQRコードをまとめて切り替える
  function applyPrivacy() {
    toggle.replaceChildren((privacy ? ICON.eye : ICON.eyeOff)(), privacy ? '表示する' : '隠す'); toggle.classList.toggle('on', privacy);
    infoCard.style.display = privacy ? 'none' : '';
    qrCard.style.display = privacy || storeMode ? 'none' : ''; qrHidden.style.display = privacy && !storeMode && design.qr === 'below' ? '' : 'none';
    hint.textContent = privacy ? '個人情報を隠しています。「表示する」を押すと元に戻ります' : storeMode ? '来店したら、店頭のQRコードを読み取ってください' : '来店時にこの画面をスタッフにお見せください(QRは自動更新)';
    renderVisit(); paint();
    if (privacy) { clearTimeout(qrTimer); qrCanvas = null; qrBox.replaceChildren(); } else if (window.QRCode) refreshQr();
  }
  toggle.onclick = () => { privacy = !privacy; applyPrivacy(); };

  root.replaceChildren(el('h1', { className: 'shop' }, design.shopName.text || me.shop), canvas, visit); // 見出しも、デザインで設定した店舗名に合わせる
  if (opts.flash) root.append(opts.flash); // 来店を記録した直後のメッセージ
  if (design.qr === 'below') root.append(qrCard, qrHidden); else qrHidden.style.display = 'none';
  root.append(hint);
  if (storeMode) root.append(chip(ICON.scan, '店頭のQRを読み取って来店を記録', async () => { try { await scanStoreQr(); } catch (e) { showError(e); } }, 'cta'));
  // 操作ボタン: 1行にコンパクトに並べる (詳細はシートで開く)
  const editable = form.fields.filter((f) => f.user_editable && !f.consent_target); // 同意は「お知らせ」の設定から変更する
  const bar = el('div', { className: 'bar' }, toggle,
    chip(ICON.image, '画像保存', () => showCardImage(cur, design, logo, bg, privacy)),
    ...(design.page.showNotice !== false ? [chip(ICON.bell, 'お知らせ', () => noticeSheet(cur, () => refreshMe()))] : []),
    chip(ICON.menu, 'メニュー', () => menuSheet(cur, editable)));
  root.append(bar);
  paint(); // 画像の読み込み前にも、まず文字だけで描く
  Promise.all([assetImage(design.logo.imageId), assetImage(design.background.imageId)]).then(([l, b]) => { logo = l; bg = b; paint(); });
  if (!window.QRCode) root.append(el('div', { className: 'err' }, 'QRコードを表示できません'));
  applyPrivacy();
  // 店舗で来店が記録されたら、開いたままでも更新される (表示中のみ20秒ごと / アプリに戻ったとき)
  if (!PREVIEW) meTimer = setInterval(() => { if (!document.hidden) refreshMe(); }, 20_000);
  document.onvisibilitychange = () => { if (!document.hidden) { refreshMe(); if (window.QRCode && !privacy) refreshQr(); } };

  if (me.shopcardUrl && design.page.showShopcard) root.append(el('button', { className: 'chip cta', onclick: () => openLine(me.shopcardUrl) }, ICON.card(), '公式LINEのショップカードを開く'));
  if (design.page.welcomeText) root.append(el('div', { className: 'card mini welcome' }, design.page.welcomeText));
  if (me.notice) root.append(el('div', { className: 'card mini notice' }, me.notice));
  // 使えるクーポン (読み込みは非同期)
  const couponBox = el('div'); root.append(couponBox);
  api('coupons').then(({ coupons }) => {
    const list = coupons.filter((x) => x.state === 'available');
    if (!list.length) return;
    couponBox.append(el('div', { className: 'card mini' }, el('b', {}, `🎟 使えるクーポン(${list.length})`),
      ...list.map((x) => el('div', { style: 'margin-top:8px;padding:8px 10px;border:1px solid rgba(128,128,128,.4);border-radius:10px;cursor:pointer', onclick: () => showCoupon(x.coupon.coupon_id, cur) },
        el('div', { style: 'font-weight:bold' }, x.coupon.title), x.coupon.benefit ? el('div', { style: 'color:#d9381e;font-weight:bold' }, x.coupon.benefit) : null,
        el('small', {}, x.coupon.valid_until ? `有効期限: ${x.coupon.valid_until.replaceAll('-', '/')}まで` : '有効期限なし')))));
  }).catch(() => { /* クーポンが読めなくても会員証は使える */ });
  if (design.page.showInfoList) root.append(el('details', { className: 'card mini' }, el('summary', {}, '登録情報'), infoCard)); // 折りたたみ (1画面に収めるため)
  infoCard.className = ''; infoCard.style.margin = '6px 0 0';
}

const svg = (d) => () => { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('viewBox', '0 0 24 24'); n.innerHTML = d; return n; }; // 固定の図形のみ
const ICON = {
  image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
  bell: svg('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>'),
  menu: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  eye: svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M17.9 17.9A10.9 10.9 0 0112 19c-7 0-11-7-11-7a19 19 0 015.1-5.9M9.9 4.2A10.7 10.7 0 0112 4c7 0 11 7 11 7a19 19 0 01-2.2 3.2"/><path d="M1 1l22 22"/>'),
  scan: svg('<path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><path d="M7 12h10"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>'),
};
const chip = (icon, label, onclick, extra = '') => el('button', { className: `chip ${extra}`.trim(), onclick }, icon(), label);

// 店舗のQR(店頭に表示)で来店を記録。QRの中身は「ミニアプリを開くURL」なので、スマホのカメラで読み取って開いた場合も、このボタンでLINEのリーダーを使った場合も、同じ処理になる
const visitCodeOf = (text) => /(?:^|[?&])visit=(MS1\.[\w.\-]+)/.exec(String(text))?.[1] ?? (String(text).startsWith('MS1.') ? String(text) : null);
async function recordStoreVisit(code) {
  const r = await api('visit', { method: 'POST', body: { code } });
  const got = (r.rewards ?? []).filter((x) => x.status === 'SENT').map((x) => x.rule);
  return el('div', { className: 'card mini ok', style: 'font-weight:700;text-align:center' }, `✓ 来店を記録しました(${r.visit_count}回目)`, got.length ? el('div', { style: 'font-weight:400;font-size:12px' }, `特典をLINEでお送りしました: ${got.join('、')}`) : null);
}
async function scanStoreQr() {
  if (!liff.isApiAvailable?.('scanCodeV2')) throw new Error('この端末では、アプリ内の読み取りが使えません。スマホのカメラで、店頭のQRコードを読み取ってください。');
  const r = await liff.scanCodeV2(); const code = visitCodeOf(r?.value);
  if (!code) throw new Error('来店用のQRコードではありません。店頭のQRコードを読み取ってください。');
  const flash = await recordStoreVisit(code); showCard(await api('me'), { flash });
}
// 下からのシート(ダイアログ)。LINE内ブラウザでも使える標準の <dialog>
function sheet(title, ...nodes) {
  const d = el('dialog', { className: 'sheet' }, el('h2', {}, title), ...nodes, el('button', { className: 'chip', style: 'width:100%;margin-top:10px;padding:9px', onclick: () => d.close() }, '閉じる'));
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
}
const toggleRow = (label, sub, checked, onchange, disabled = false) => {
  const cb = el('input', { type: 'checkbox', className: 'sw', checked, disabled, onchange: () => onchange(cb) });
  return { node: el('label', { className: 'row2' }, el('div', {}, el('div', { style: 'font-size:14px' }, label), sub ? el('small', {}, sub) : null), cb), cb };
};
// LINEでのお知らせ: 全体のオン/オフ + 受け取る内容の選択
function noticeSheet(me, onDone) {
  const err = el('div', { className: 'err' }); let on = !!me.consents?.LINE; const prefs = { ...(me.prefs ?? { news: true, coupon: true, birthday: true }) };
  const save = async (fn) => { try { err.textContent = ''; await fn(); onDone(); } catch (e) { err.textContent = e.message; } };
  const kinds = [['news', 'お知らせ・キャンペーン', '新商品やイベントのご案内'], ['coupon', 'クーポン', 'お得なクーポンの配信'], ['birthday', 'お誕生日のお祝い', 'メッセージやクーポン']];
  const subs = kinds.map(([k, l, d]) => toggleRow(l, d, prefs[k], (cb) => save(async () => { prefs[k] = cb.checked; await api('prefs', { method: 'POST', body: { [k]: cb.checked } }); }), !on));
  const main = toggleRow('LINEでお知らせを受け取る', '店舗からのお知らせやクーポンをLINEで受け取ります', on, (cb) => save(async () => {
    await api('consent', { method: 'POST', body: { channel: 'LINE', granted: cb.checked } }); on = cb.checked; for (const s of subs) s.cb.disabled = !on;
  }));
  sheet('LINEでのお知らせ', main.node, el('div', { className: 'mini-t', style: 'text-align:left;margin-top:8px' }, '受け取る内容'), ...subs.map((s) => s.node), err);
}
function menuSheet(me, editable) {
  const d = sheet('メニュー',
    ...(editable.length ? [el('button', { className: 'lnk', onclick: () => { d.close(); showEdit(me, editable); } }, '登録情報を変更する')] : []),
    el('button', { className: 'lnk dng', onclick: () => { d.close(); showWithdraw(me); } }, '退会する'));
}

// カードを画像として表示 (LINE内ブラウザは直接ダウンロードできないことがあるため、長押しで保存してもらう)
// 保存用の画像にはQRを含めない (QRは5分で失効するため)
function showCardImage(me, design, logo, bg, privacy = false) {
  const c = document.createElement('canvas');
  drawCard(c, { ...design, qr: 'below' }, cardData(me), { logo, bg, privacy }); // 隠している間は、保存する画像も隠した状態
  const img = el('img', { src: c.toDataURL('image/png'), alt: '会員証', style: 'width:100%;border-radius:12px' });
  root.replaceChildren(el('h1', {}, '会員証の画像'), img, el('p', { className: 'hint' }, '画像を長押しして「写真に追加」などで保存できます。'),
    el('button', { className: 'sub', onclick: () => showCard(me, { privacy }) }, '戻る'));
}

function showEdit(me, editable) {
  const init = Object.fromEntries(me.items.map((i) => [i.field_id, i.raw]));
  root.replaceChildren(el('h1', {}, '登録情報の変更'), buildForm(editable, init, async (values) => {
    try { await api('me', { method: 'PATCH', body: { values } }); showCard(await api('me')); } catch (e) { showError(e); }
  }, '保存する'), el('button', { className: 'sub', onclick: () => showCard(me) }, '戻る'));
}

// ---- クーポン ----
// 会員が「クーポンを使う」を押すと、5分有効のQRを表示する。スタッフが読み取ると使用済みになり、この画面も切り替わる。
const COUPON_STATE = { available: '', used: '使用済みです', expired: '有効期限が切れています', not_started: 'まだ利用開始前です', archived: 'このクーポンは終了しました' };
async function showCoupon(id, me) {
  clearTimeout(qrTimer); clearInterval(meTimer);
  const back = async () => showCard(me ?? (await api('me')));
  let data;
  try { data = await api(`coupon/${id}`); } catch (e) { root.replaceChildren(el('h1', {}, 'クーポン'), el('div', { className: 'card err' }, e.message), el('button', { className: 'sub', onclick: back }, '会員証に戻る')); return; }
  const c = data.coupon, until = (c.valid_until ? `有効期限: ${c.valid_until.replaceAll('-', '/')}まで` : '有効期限なし') + (c.multi_use ? '・期間中は何度でも使えます' : '');
  const card = el('div', { className: 'card', style: 'border-left:6px solid var(--accent,#06c755)' }, el('small', { style: 'color:var(--accent,#06c755);font-weight:bold' }, 'COUPON'), el('h2', { style: 'margin:6px 0' }, c.title),
    c.benefit ? el('div', { style: 'font-size:20px;font-weight:bold;color:#d9381e;margin:6px 0' }, c.benefit) : null, c.description ? el('p', { style: 'white-space:pre-wrap' }, c.description) : null, el('small', {}, until));
  const body = el('div'), status = el('div', { style: 'text-align:center;font-weight:bold;margin:8px 0' });
  root.replaceChildren(el('h1', {}, shop), card, status, body, el('button', { className: 'sub', onclick: back }, '会員証に戻る'));
  if (data.state !== 'available') { status.textContent = COUPON_STATE[data.state] ?? ''; status.className = 'err'; return; }

  let poll = null, count = data.redeemed_count ?? 0;
  const stop = () => { clearInterval(poll); clearTimeout(qrTimer); };
  async function showCode() {
    stop();
    try {
      const { code, expiresAt } = await api(`coupon/${id}/code`, { method: 'POST' });
      const box = el('div', { id: 'qr' }); body.replaceChildren(el('div', { className: 'card', style: 'text-align:center' }, box, el('small', {}, 'お会計のときに、この画面をスタッフにお見せください。スタッフが読み取ると、クーポンが使用済みになります。')));
      new QRCode(box, { text: code, width: 200, height: 200 });
      status.textContent = ''; status.className = '';
      qrTimer = setTimeout(showCode, Math.max(10_000, expiresAt - Date.now() - 60_000)); // 期限の1分前に新しいQRへ
      poll = setInterval(async () => { // 使用済みになったら画面を切り替える
        try { const d = await api(`coupon/${id}`);
          if (d.state === 'available' && d.redeemed_count > count) { // 何度でも使えるクーポン: 使用を確認したら、使用済みにはせず、次に使えるように戻す
            count = d.redeemed_count; stop(); body.replaceChildren(); status.textContent = `✓ クーポンを使用しました(${count}回目)。期間中は、また使えます。`; status.className = 'ok'; setTimeout(() => { status.textContent = ''; showOpen(); }, 4000); return;
          }
          if (d.state !== 'available') { stop(); body.replaceChildren(); status.textContent = d.state === 'used' ? '✓ クーポンを使用しました。ご利用ありがとうございました。' : COUPON_STATE[d.state]; status.className = d.state === 'used' ? 'ok' : 'err'; } } catch { /* 無視 */ }
      }, 4000);
    } catch (e) { showError(e); }
  }
  const showOpen = () => body.replaceChildren(el('button', { onclick: () => { if (!window.QRCode) return showError(new Error('QRコードを表示できません')); if (confirm('お会計の場でスタッフに見せる画面を開きます。よろしいですか?')) showCode(); } }, 'クーポンを使う'),
    el('small', { style: 'display:block;text-align:center;margin-top:6px' }, '※ お会計の直前に押してください。'));
  showOpen();
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
// ---- 友だち追加の案内 (会員登録の条件) ----
// 登録の前に、公式アカウントの友だち追加を確認する。確認はサーバーがLINEに問い合わせて行う。
async function startRegistration() {
  try {
    const f = await api('friend');
    if (f.required && !f.friend) return showFriendGate(f.addUrl, false);
  } catch (e) { return showError(e); }
  showRegister();
}
function showFriendGate(addUrl, again) {
  root.replaceChildren(el('h1', {}, shop), el('div', { className: 'card' }, el('h2', {}, '友だち追加のお願い'),
    el('p', {}, '会員登録には、この店舗の公式アカウントの友だち追加が必要です。'), el('ol', { style: 'padding-left:20px' }, el('li', {}, '「友だち追加する」を押して、公式アカウントを追加します'), el('li', {}, 'このページに戻って、「追加したので次へ」を押します')),
    again ? el('div', { className: 'err' }, 'まだ友だち追加が確認できません。追加したあとに、もう一度押してください。(すでに追加済みの場合は、ブロックしていないかご確認ください)') : null),
    addUrl ? el('button', { onclick: () => openLine(addUrl) }, '友だち追加する') : el('div', { className: 'card err' }, '友だち追加のURLが設定されていません。店舗にお問い合わせください。'),
    el('button', { className: 'sub', onclick: async () => { try { const f = await api('friend'); if (f.required && !f.friend) return showFriendGate(f.addUrl, true); showRegister(); } catch (e) { showError(e); } } }, '追加したので次へ'));
}

function showWithdrawn() {
  clearTimeout(qrTimer); clearInterval(meTimer);
  root.replaceChildren(el('h1', {}, shop), el('div', { className: 'card' }, el('p', {}, '退会済みです。'), el('p', {}, 'もう一度ご利用になる場合は、再登録してください。')),
    el('button', { onclick: startRegistration }, '再登録する'));
}

// ---- 登録 ----
function showRegister() {
  root.replaceChildren(el('h1', {}, shop), el('h2', {}, '会員登録'), buildForm(form.fields, null, async (values) => {
    try {
      const c = await api('confirm', { method: 'POST', body: { values } });
      const dl = el('dl'); for (const i of c.items) dl.append(el('dt', {}, i.label), el('dd', {}, i.value || '（未入力）'));
      root.replaceChildren(el('h1', {}, '登録内容の確認'), el('div', { className: 'card' }, dl),
        el('button', { onclick: async () => { try { await api('register', { method: 'POST', body: { values, confirmed: true } }); showCard(await api('me')); } catch (e) { if (e.code === 'friend_required') showFriendGate(e.addUrl, true); else showError(e); } } }, '登録する'),
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

if (PREVIEW) { // 親(管理画面)から { me, assetUrls } を受け取るたびに描き直す。同じオリジンからのメッセージだけ受け付ける
  form = { fields: [] }; shop = '';
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== parent || e.data?.type !== 'preview') return;
    previewMe = e.data.me; previewUrls = e.data.assetUrls ?? {}; shop = previewMe.shop;
    const y = window.scrollY; showCard(previewMe); window.scrollTo(0, y);
  });
  parent.postMessage({ type: 'preview-ready' }, location.origin);
} else (async () => {
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
    let me = await api('me');
    if (me.registered) {
      const cp = findParam('coupon'), vc = visitCodeOf(`visit=${findParam('visit') ?? ''}`);
      if (/^[0-9a-f]{32}$/.test(cp || '')) showCoupon(cp, me);
      else if (vc) { // 店頭のQRを読み取って開いた: 来店を記録してから会員証を表示
        let flash; try { flash = await recordStoreVisit(vc); me = await api('me'); } catch (e) { flash = el('div', { className: 'card mini err', style: 'text-align:center' }, e.message); }
        try { const u = new URL(location.href); u.searchParams.delete('visit'); history.replaceState(null, '', u); } catch { /* 無視 */ }
        showCard(me, { flash });
      } else showCard(me);
    } else if (me.withdrawn) showWithdrawn(); else startRegistration();
  } catch (e) { root.replaceChildren(el('div', { className: 'card err' }, e.message)); }
})();
