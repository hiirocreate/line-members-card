// 管理画面 (SPA)。DOM は textContent / プロパティ代入のみで組み立て、HTML文字列は使わない。
import { el, buildForm, collect, control } from './formkit.js';
import { PRESETS, drawCard, loadImage, makeQr, contrast, applyPage, CARD_W, CARD_H } from './cardkit.js';

const root = document.getElementById('root');
const TYPES = { TEXT: '1行テキスト', TEXTAREA: '複数行テキスト', NUMBER: '数値', DATE: '日付', TEL: '電話番号', EMAIL: 'メールアドレス', ZIP: '郵便番号', URL: 'URL',
  SELECT: '選択式(1つ)', MULTI_SELECT: '複数選択', RADIO: 'ラジオ(1つ)', CHECKBOX: 'チェックボックス/同意', YESNO: 'Yes / No', ADDRESS: '住所' };
const CHOICE = ['SELECT', 'MULTI_SELECT', 'RADIO'];
const VIS = { USER: 'ユーザーに表示', STAFF: '店舗スタッフのみ', ADMIN: '店舗管理者以上', OPERATOR: '運営管理者のみ' };
const ST = { me: null, tenant: null, tab: 'form', fields: [], master: [], tenants: [] };
const store = { get: () => { try { return sessionStorage.getItem('tok'); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem('tok', v) : sessionStorage.removeItem('tok'); } catch { /* 無効でも動作させる */ } } };

async function api(path, { method = 'GET', body, blob } = {}) {
  const q = ST.me?.role === 'OPERATOR' && ST.tenant ? `${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(ST.tenant)}` : '';
  const r = await fetch(`/api/admin${path}${q}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${store.get()}` }, body: body && JSON.stringify(body) });
  if (r.status === 401 && path !== '/login') { store.set(null); ST.me = null; render(); throw new Error('ログインが必要です'); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || `エラー(${r.status})`), { details: j.details }); }
  return blob ? r.blob() : r.json();
}
// ---- パスキー (WebAuthn) ----
const b64uToBuf = (str) => { const t = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t.padEnd(Math.ceil(t.length / 4) * 4, '=')); return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer; };
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passkeySupported = () => !!(window.PublicKeyCredential && navigator.credentials);
async function getAssertion(options) {
  const pk = options.publicKey;
  const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: b64uToBuf(pk.challenge), allowCredentials: pk.allowCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
  return { id: cred.id, response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature) } };
}
async function createPasskey(options) {
  const pk = options.publicKey;
  const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: b64uToBuf(pk.challenge), user: { ...pk.user, id: b64uToBuf(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
  return { id: cred.id, response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) }, transports: cred.response.getTransports?.() ?? [] };
}
// ブラウザ/端末側の取り消し・タイムアウトは、分かりやすい文言にする
const passkeyError = (e) => (e?.name === 'NotAllowedError' ? new Error('パスキーの確認がキャンセルされたか、時間切れになりました') : e?.name === 'InvalidStateError' ? new Error('この端末のパスキーは既に登録されています') : e);

const errText = (e) => [e.message, ...(e.details ?? [])].join('\n');
const can = (p) => ST.me?.perms.includes(p);
const featOn = (k) => ST.me?.role === 'OPERATOR' || ST.me?.features?.[k] !== false; // 運営が店舗ごとに機能をオフにできる
const btn = (text, onclick, cls = '') => el('button', { className: `btn ${cls}`, type: 'button', onclick }, text);
const lab = (text, node, hint) => el('div', {}, el('label', { className: 'lb' }, text), node, hint ? el('div', { className: 'hint' }, hint) : null);
const run = (box, fn) => async (...a) => { try { box && (box.textContent = ''); await fn(...a); } catch (e) { if (box) { box.className = 'err'; box.textContent = errText(e); } else alert(errText(e)); } };

// ---------- ログイン ----------
function loginView() {
  if (location.hash.startsWith('#reset=')) return resetView(location.hash.slice('#reset='.length));
  const err = el('div', { className: 'err' });
  const email = el('input', { type: 'email', autocomplete: 'username webauthn' }), pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const code = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '6桁のコード または 回復コード' });
  const codeBox = lab('認証アプリのコード', code, '認証アプリのコードか、回復コードを入力してください。'); codeBox.style.display = 'none';
  const passkeyBox = el('div', { style: 'display:none;margin-top:12px' });
  const lineCode = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: 'LINEに届いた6桁のコード', maxLength: 6 });
  const sendLine = run(err, async () => {
    await api('/login/line-code', { method: 'POST', body: { email: email.value, password: pw.value } });
    err.className = 'ok'; err.textContent = 'LINEにコードを送りました(5分間有効)。届いたコードを入力して「ログイン」を押してください。'; lineCode.focus();
  });
  const lineBox = el('div', { style: 'display:none;margin-top:12px' }, btn('LINEにコードを送る', sendLine, 'pri'), lab('LINEに届いたコード', lineCode, '公式アカウントから届きます。届かない場合は、友だち追加とブロックの状態を確認してください。'));
  const base = () => ({ email: email.value, password: pw.value });
  const done = async (r) => { store.set(r.token); await boot(); };
  // パスキー: 毎回サーバから新しいチャレンジを受け取る (時間が経っても使える)
  const withPasskey = run(err, async () => {
    if (!passkeySupported()) throw new Error('このブラウザはパスキーに対応していません');
    const r = await api('/login', { method: 'POST', body: base() });
    if (!r.requires2fa || !r.passkey) throw new Error('パスキーが登録されていません');
    let assertion;
    try { assertion = await getAssertion(r.passkey); } catch (e) { throw passkeyError(e); }
    await done(await api('/login', { method: 'POST', body: { ...base(), challenge: r.passkey.token, assertion } }));
  });
  const go = run(err, async () => {
    const r = await api('/login', { method: 'POST', body: { ...base(), code: code.value || undefined, lineCode: lineCode.value || undefined } });
    if (!r.requires2fa) return done(r);
    err.textContent = '';
    codeBox.style.display = r.methods.includes('totp') ? '' : 'none';
    passkeyBox.style.display = r.methods.includes('passkey') ? '' : 'none';
    lineBox.style.display = r.methods.includes('line') ? '' : 'none';
    if (r.methods.includes('line') && r.lineAvailable === false) { err.className = 'err'; err.textContent = 'LINEのコード送信設定が無効です。別の方法でログインするか、管理者に2FAのリセットを依頼してください。'; }
    if (r.methods.includes('passkey')) { err.className = 'hint'; err.textContent = '指紋・顔・端末の画面ロックで確認してください。'; withPasskey(); }
    else code.focus();
  });
  passkeyBox.append(btn('パスキーでログイン(指紋・顔・画面ロック)', withPasskey, 'pri'), el('div', { className: 'hint' }, '認証アプリを使う場合は、上のコード欄に入力して「ログイン」を押してください。'));
  for (const i of [pw, code, lineCode]) i.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  root.replaceChildren(el('div', { className: 'login card' }, el('h2', {}, '管理画面ログイン'), lab('メールアドレス', email), lab('パスワード', pw), codeBox, err, passkeyBox, lineBox,
    el('div', { className: 'row', style: 'margin-top:12px' }, btn('ログイン', go, 'pri')), el('p', { className: 'hint' }, 'パスワードを忘れた場合は、店舗管理者または運営に再設定リンクの発行を依頼してください。')));
}
function resetView(token) {
  const err = el('div', { className: 'err' }), ok = el('div', { className: 'ok' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password' }), pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const go = run(err, async () => {
    if (pw.value !== pw2.value) throw new Error('確認用パスワードが一致しません');
    await api('/password-reset/consume', { method: 'POST', body: { token, password: pw.value } });
    history.replaceState(null, '', location.pathname); ok.textContent = '再設定しました。新しいパスワードでログインしてください。';
    setTimeout(render, 1500);
  });
  root.replaceChildren(el('div', { className: 'login card' }, el('h2', {}, 'パスワードの再設定'), lab('新しいパスワード(10文字以上)', pw), lab('新しいパスワード(確認)', pw2), err, ok,
    el('div', { className: 'row', style: 'margin-top:12px' }, btn('設定する', go, 'pri'))));
}

// ---------- 共通レイアウト ----------
const TABS = [['form', '会員登録フォーム'], ['card', '会員証デザイン'], ['members', '会員'], ['rank', '会員ランク'], ['scan', '来店スキャン'], ['messages', 'メッセージ配信'], ['birthday', '誕生日配信'], ['visitrules', '来店回数配信'], ['schedule', '予約メッセージ'], ['coupons', 'クーポン'], ['line', 'LINE連携'], ['urls', '登録URL'], ['audit', '監査ログ'], ['account', 'アカウント']];
function layout(content) {
  const tabs = [...TABS.filter(([k]) => featOn(k) && (['messages', 'birthday', 'visitrules', 'schedule'].includes(k) ? can('MESSAGE_SEND') : k === 'line' ? can('LINE_SETTINGS') : k === 'card' || k === 'rank' ? can('CARD_DESIGN') : k === 'coupons' ? can('COUPON_MANAGE') : true)), ...(ST.me.role === 'OPERATOR' ? [['ops', '運営']] : [])];
  const head = el('header', {}, el('h1', {}, '会員管理'), el('span', { className: 'hint' }, ST.me.tenantName ?? ''), el('span', { className: 'sp' }));
  if (ST.me.role === 'OPERATOR') {
    const sel = el('select', { style: 'width:auto', onchange: () => { if (formDirty() && !confirm('保存していない変更があります。破棄して店舗を切り替えますか?')) { sel.value = ST.tenant ?? ''; return; } discardFormDraft(); ST.tenant = sel.value || null; render(); } }, el('option', { value: '' }, '店舗を選択'),
      ST.tenants.map((t) => el('option', { value: t.tenant_id, selected: t.tenant_id === ST.tenant }, `${t.name} (${t.tenant_id})`)));
    head.append(sel);
  }
  head.append(el('span', { className: 'hint' }, ST.me.role), btn('ログアウト', () => { if (formDirty() && !confirm('保存していない変更があります。破棄してログアウトしますか?')) return; discardFormDraft(); store.set(null); ST.me = null; ST.tab = 'form'; render(); }));
  root.replaceChildren(head, el('nav', {}, tabs.map(([k, t]) => el('button', { className: ST.tab === k ? 'on' : '', onclick: () => { if (ST.tab === k && rendering) return; if (ST.tab === 'form' && k !== 'form' && formDirty()) { if (!confirm('保存していない変更があります。破棄して移動しますか?')) return; discardFormDraft(); } ST.tab = k; render(); } }, t))), el('main', {}, content));
}

// ---------- フォーム設定 ----------
const visibleOpts = (f) => (f.options ?? []).filter((o) => !o.hidden).sort((a, b) => a.order - b.order);

function previewNode() {
  const fields = ST.fields.filter((f) => f.enabled && f.visibility === 'USER');
  const box = el('div', { className: 'phone' }, el('h3', {}, ST.me.tenantName ?? ST.tenant ?? '店舗'), el('div', { className: 'hint' }, '会員登録'));
  box.append(fields.length ? buildForm(fields, null, () => {}, '確認する') : el('div', { className: 'hint', style: 'margin-top:12px' }, '表示する項目がありません'));
  return box;
}

// ---------- 会員登録フォーム (下書き → 「保存」で一括反映) ----------
// 画面での変更は、まず手元の下書きにだけ反映され、プレビューも下書きの内容を表示する。
// 「保存」を押すと、まとめて1回で反映する(途中で失敗したら全部取り消し)。保存前に別のタブへ移るときは確認する。
let formDraft = null; // { tenant, version, orig, fields, master, templates, interest, seq }
const ATTRS = ['field_name', 'required', 'placeholder', 'purpose_text', 'user_editable', 'visibility', 'allow_other', 'consent_target'];
const visVals = (f) => visibleOpts(f).map((o) => o.value);
const sameAttrs = (a, b) => ATTRS.every((k) => (a[k] ?? '') === (b[k] ?? '')) && JSON.stringify(visVals(a)) === JSON.stringify(visVals(b)) && !!a.enabled === !!b.enabled;
const formDirty = () => !!formDraft && buildOps(formDraft).length > 0;

// 下書きと、サーバー上の内容の差分を、一括保存の操作の並び(追加 → 更新 → 表示切替 → 並び順)にする
function buildOps(d) {
  const orig = new Map(d.orig.map((f) => [f.field_id, f])), ops = [];
  const pick = (f) => ({ field_name: f.field_name, required: !!f.required, placeholder: f.placeholder ?? '', purpose_text: f.purpose_text ?? '', user_editable: f.user_editable !== false, visibility: f.visibility, allow_other: !!f.allow_other, consent_target: f.consent_target || null });
  const news = d.fields.filter((f) => f._new);
  for (const f of news) {
    const attrs = pick(f);
    if (f.master_key) ops.push({ op: 'add', tempId: f.field_id, masterKey: f.master_key, overrides: { ...attrs, options: f.options.map((o) => ({ ...o })) } });
    else ops.push({ op: 'add', tempId: f.field_id, field: { ...attrs, field_type: f.field_type, options: visVals(f) } });
  }
  for (const f of d.fields.filter((x) => !x._new)) {
    const o = orig.get(f.field_id); const patch = {};
    for (const k of ATTRS) if ((f[k] ?? '') !== (o[k] ?? '')) patch[k] = f[k];
    if (JSON.stringify(visVals(f)) !== JSON.stringify(visVals(o))) patch.options = visVals(f);
    if (Object.keys(patch).length) ops.push({ op: 'update', id: f.field_id, patch });
  }
  for (const f of d.fields) if ((f._new && !f.enabled) || (!f._new && !!f.enabled !== !!orig.get(f.field_id).enabled)) ops.push({ op: 'enable', id: f.field_id, enabled: !!f.enabled });
  const expected = [...d.orig.map((f) => f.field_id), ...news.map((f) => f.field_id)];
  if (JSON.stringify(expected) !== JSON.stringify(d.fields.map((f) => f.field_id))) ops.push({ op: 'order', ids: d.fields.map((f) => f.field_id) });
  return ops;
}
async function loadFormDraft() {
  const [g, { master }] = await Promise.all([api('/form'), api('/master')]);
  formDraft = { tenant: ST.tenant, version: g.version, orig: structuredClone(g.fields), fields: structuredClone(g.fields), master, templates: g.templates, interest: g.interest, seq: 0 };
}
const discardFormDraft = () => { formDraft = null; };
// 下書きに、標準項目を追加 (すでにあれば再表示するだけ)
function draftAddMaster(d, key, required = false) {
  const ex = d.fields.find((f) => f.master_key === key);
  if (ex) { ex.enabled = true; return ex; }
  const m = d.master.find((x) => x.key === key); if (!m) return null;
  const f = { field_id: `tmp_${++d.seq}`, _new: true, master_key: key, field_name: m.label, field_type: m.field_type, options: structuredClone(m.options ?? []), purpose_text: m.purpose_text ?? '', sensitivity: m.sensitivity,
    consent_target: m.consent_target || null, required: m.consent_target ? false : required, enabled: true, placeholder: '', user_editable: true, visibility: 'USER', allow_other: false };
  d.fields.push(f); return f;
}
function draftApplyTemplate(d, name) { // サーバーの applyTemplate と同じ規則
  const tpl = d.templates[name]; if (!tpl) return;
  for (const { key, required } of tpl.fields) {
    if (key === '__interest') {
      if (!d.fields.some((f) => f.field_name === d.interest.field_name)) d.fields.push({ field_id: `tmp_${++d.seq}`, _new: true, master_key: null, field_name: d.interest.field_name, field_type: d.interest.field_type, options: d.interest.options.map((v, i) => ({ value: v, label: v, order: i + 1 })), purpose_text: '', sensitivity: 'PERSONAL', consent_target: null, required: false, enabled: true, placeholder: '', user_editable: true, visibility: 'USER', allow_other: false });
    } else draftAddMaster(d, key, required);
  }
}

async function formView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  if (!(formDraft && formDraft.tenant === ST.tenant && formDirty())) await loadFormDraft(); // 未保存の変更があれば、下書きを保ったまま描き直す
  const d = formDraft, canEdit = can('FORM_EDIT');
  ST.fields = d.fields; ST.master = d.master;
  const err = el('div', { className: 'err' }), ok = el('div', { className: 'ok' });
  const redraw = () => { ST.fields = d.fields; return formView(); };
  const orig = new Map(d.orig.map((f) => [f.field_id, f]));
  const changed = (f) => f._new || !sameAttrs(f, orig.get(f.field_id));
  const list = el('div');
  let dragId = null;
  d.fields.forEach((f) => {
    const row = el('div', { className: `field ${f.enabled ? '' : 'off'}`, draggable: canEdit });
    row.addEventListener('dragstart', () => { dragId = f.field_id; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); row.classList.remove('drag');
      if (!dragId || dragId === f.field_id) return;
      const moved = d.fields.find((x) => x.field_id === dragId); d.fields = d.fields.filter((x) => x !== moved);
      d.fields.splice(d.fields.indexOf(f), 0, moved); redraw();   // 下書きの並びだけを変える(保存するまで反映されない)
    });
    const badges = el('div', {}, el('span', { className: 'badge' }, TYPES[f.field_type]), f.master_key ? el('span', { className: 'badge int' }, '標準') : el('span', { className: 'badge' }, 'カスタム'),
      f.visibility !== 'USER' ? el('span', { className: 'badge warn' }, VIS[f.visibility]) : null, !f.user_editable ? el('span', { className: 'badge' }, '店舗のみ変更可') : null,
      f.sensitivity !== 'NORMAL' ? el('span', { className: 'badge' }, f.sensitivity) : null, changed(f) ? el('span', { className: 'badge warn' }, f._new ? '新規(未保存)' : '変更あり(未保存)') : null);
    const req = el('input', { type: 'checkbox', checked: f.required, disabled: !canEdit || f.visibility !== 'USER' || !!f.consent_target, onchange: () => { f.required = req.checked; redraw(); } });
    row.append(el('span', { className: 'handle', title: 'ドラッグで並び替え' }, '☰'), el('div', { className: 'name' }, el('b', {}, f.field_name), badges), el('label', { className: 'hint' }, req, ' 必須'));
    if (canEdit) row.append(btn(f.enabled ? '表示中' : '非表示', () => { f.enabled = !f.enabled; redraw(); }, 'sm'), btn('編集', () => fieldDialog(f, d, redraw), 'sm'));
    list.append(row);
  });
  const used = new Set(d.fields.filter((f) => f.enabled).map((f) => f.master_key));
  const tplSel = el('select', { style: 'width:auto' }, Object.entries(d.templates).map(([v, t]) => el('option', { value: v }, t.label)));
  const bar = canEdit ? el('div', { className: 'row', style: 'margin-bottom:12px' },
    btn('＋ 標準項目を追加', () => masterDialog(d.master.filter((m) => !used.has(m.key)), d, redraw), 'pri'), btn('＋ カスタム項目を追加', () => fieldDialog(null, d, redraw)),
    el('span', { className: 'sp', style: 'flex:1' }), tplSel, btn('テンプレート適用', () => { if (confirm('テンプレートの項目を、下書きに追加します(既存項目は変更されません)。保存するまで反映されません。')) { draftApplyTemplate(d, tplSel.value); redraw(); } })) : null;

  // 配信への同意 (チェックボックス): 表示するとチェックを入れた会員にだけ配信される
  const CONSENTS = [['LINE', 'LINE配信', 'consent_line', 'お知らせ・クーポンをLINEで配信するための同意'], ['EMAIL', 'メール配信', 'consent_email', 'お知らせをメールで配信するための同意'], ['MARKETING', 'キャンペーン案内', 'consent_marketing', 'キャンペーン情報などの案内のための同意']];
  const consentCard = el('div', { className: 'card' }, el('h2', {}, '配信への同意(チェックボックス)'),
    el('div', { className: 'hint', style: 'margin-bottom:10px' }, '会員登録の画面に、同意のチェックボックスを出せます。チェックを入れた会員にだけ配信できます(メールアドレスや電話番号を登録しただけでは、同意したことになりません)。同意は必須にできません。既存の会員は、会員証の画面から、あとで同意できます。'),
    CONSENTS.map(([target, title, key, desc]) => {
      const f = d.fields.find((x) => x.consent_target === target);
      const on = !!(f && f.enabled);
      return el('div', { className: `field ${on ? '' : 'off'}` }, el('div', { className: 'name' }, el('b', {}, title), el('span', { className: 'hint' }, desc), f ? el('span', { className: 'hint' }, `表示文言: ${f.field_name}`) : null),
        el('span', { className: `badge ${on ? 'int' : ''}` }, on ? '表示中' : (f ? '非表示' : '未設定')),
        canEdit ? [f ? btn('文言を編集', () => fieldDialog(f, d, redraw), 'sm') : null,
          btn(on ? '非表示にする' : '表示する', () => { if (f) f.enabled = !on; else draftAddMaster(d, key); redraw(); }, on ? 'sm' : 'sm pri')] : null);
    }));

  // 保存 / 破棄 (画面の上部に固定)
  const ops = buildOps(d), n = ops.length;
  const save = run(err, async () => {
    err.textContent = ''; ok.textContent = '';
    const r = await api('/form', { method: 'PUT', body: { baseVersion: d.version, ops } });
    d.version = r.version; d.orig = structuredClone(r.fields); d.fields = structuredClone(r.fields); d.seq = 0;
    await redraw(); const o2 = el('div', { className: 'ok' }, `保存しました(会員の登録画面に反映されます / v${r.version})`); document.querySelector('main')?.prepend(o2); setTimeout(() => o2.remove(), 4000);
  });
  const discard = () => { if (confirm('未保存の変更を、すべて破棄します。よろしいですか?')) { discardFormDraft(); render(); } };
  const bar2 = canEdit ? el('div', { className: 'card', style: 'position:sticky;top:0;z-index:5;border-color:' + (n ? '#e0a100' : 'var(--line)') },
    el('div', { className: 'row' }, el('b', { style: n ? 'color:#8a6100' : '' }, n ? `未保存の変更があります(${n}件)` : '変更はありません'), el('span', { className: 'sp', style: 'flex:1' }),
      btn('変更を破棄', discard, n ? 'dng' : ''), btn('保存', save, n ? 'pri' : '')), err,
    el('div', { className: 'hint' }, '変更は「保存」を押すまで反映されません。プレビューは、保存前の内容を表示します。')) : null;
  if (bar2) { const sv = bar2.querySelectorAll('button'); sv[0].disabled = !n; sv[1].disabled = !n; }

  layout(el('div', { className: 'grid' }, el('div', {}, bar2, consentCard, el('div', { className: 'card' }, el('h2', {}, '会員登録項目'), bar, list,
    el('div', { className: 'hint' }, '項目は削除ではなく「非表示」にし、過去の会員データは保持されます。保存すると、変更履歴(バージョン)と監査ログに記録されます。'))),
    el('div', { className: 'card' }, el('h2', {}, 'スマホプレビュー(保存前の内容)'), previewNode())));
}

// 標準項目を、下書きに追加
function masterDialog(list, d, redraw) {
  const sel = el('select', {}, list.map((m) => el('option', { value: m.key }, `${m.label} (${TYPES[m.field_type]})`)));
  const dlg = el('dialog', {}, el('h2', {}, '標準項目を追加'), list.length ? lab('項目', sel) : el('div', {}, '追加できる標準項目はありません。'),
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('閉じる', () => dlg.close()),
      list.length ? btn('追加', () => { draftAddMaster(d, sel.value); dlg.close(); redraw(); }, 'pri') : null));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}

// 追加(f=null) / 編集(f) 共用。下書きにだけ反映する(サーバーの検証は、保存のときに行われる)
function fieldDialog(f, d, redraw) {
  const isNew = !f, err = el('div', { className: 'err' });
  const name = el('input', { type: 'text', value: f?.field_name ?? '', maxLength: 50 });
  const type = el('select', { disabled: !isNew }, Object.entries(TYPES).map(([k, v]) => el('option', { value: k, selected: k === (f?.field_type ?? 'TEXT') }, v)));
  const ph = el('input', { type: 'text', value: f?.placeholder ?? '' });
  const purpose = el('input', { type: 'text', value: f?.purpose_text ?? '', placeholder: '例: お誕生日特典の提供に利用します' });
  const required = el('input', { type: 'checkbox', checked: f?.required ?? false });
  const editable = el('input', { type: 'checkbox', checked: f?.user_editable ?? true });
  const vis = el('select', {}, Object.entries(VIS).filter(([k]) => ST.me.role === 'OPERATOR' || k !== 'OPERATOR').map(([k, v]) => el('option', { value: k, selected: k === (f?.visibility ?? 'USER') }, v)));
  const other = el('input', { type: 'checkbox', checked: f?.allow_other ?? false });
  const opts = el('textarea', { value: f ? visibleOpts(f).map((o) => o.value).join('\n') : '', placeholder: '1行に1つ。行の順番が表示順になります' });
  const consent = el('select', {}, [['', 'なし'], ['EMAIL', 'メール配信への同意'], ['LINE', 'LINE配信への同意'], ['MARKETING', 'マーケティング利用への同意']].map(([v, t]) => el('option', { value: v, selected: v === (f?.consent_target ?? '') }, t)));
  const choiceBox = el('div', {}, lab('選択肢', opts, '「その他」を含めると自由入力欄を設定できます。削除した選択肢は新規入力から外れ、既存データは保持されます。'), el('label', { className: 'lb' }, other, ' 「その他」選択時に自由入力欄を表示'));
  const consentBox = lab('同意項目の種別', consent, '配信同意はこの項目でのみ付与されます(メールアドレス登録だけでは同意扱いになりません)。');
  const sync = () => {
    choiceBox.style.display = CHOICE.includes(type.value) ? '' : 'none'; consentBox.style.display = type.value === 'CHECKBOX' ? '' : 'none';
    const isConsent = type.value === 'CHECKBOX' && !!consent.value; // 配信の同意は必須にできない
    if (isConsent) required.checked = false; required.disabled = isConsent;
  };
  type.addEventListener('change', sync); consent.addEventListener('change', sync); sync();
  const apply = () => {
    const lines = opts.value.split('\n').map((x) => x.trim()).filter(Boolean), t = f?.field_type ?? type.value, choice = CHOICE.includes(t);
    if (!name.value.trim()) throw new Error('表示名を入力してください');
    if (/<[^>]*>/.test(name.value + ph.value + purpose.value + opts.value)) throw new Error('HTMLは使用できません');
    if (choice && !lines.length) throw new Error('選択式の項目には、選択肢が必要です');
    if (new Set(lines).size !== lines.length) throw new Error('選択肢が重複しています');
    const vals = { field_name: name.value.trim(), placeholder: ph.value, purpose_text: purpose.value, required: required.checked, user_editable: editable.checked, visibility: vis.value, allow_other: other.checked && choice };
    if (t === 'CHECKBOX') vals.consent_target = consent.value || null;
    // 選択肢: 並びは行の順。消した選択肢は「非表示」として残す(既存データを守る。サーバーも同じ扱い)
    const optionObjs = lines.map((v, i) => ({ value: v, label: v, order: i + 1 }));
    const hidden = (f?.options ?? []).filter((o) => !lines.includes(o.value)).map((o, i) => ({ ...o, hidden: true, order: lines.length + i + 1 }));
    if (isNew) d.fields.push({ field_id: `tmp_${++d.seq}`, _new: true, master_key: null, field_type: t, sensitivity: 'PERSONAL', enabled: true, consent_target: null, ...vals, options: choice ? optionObjs : [] });
    else { Object.assign(f, vals); if (choice) f.options = [...optionObjs, ...hidden]; }
    dlg.close(); redraw();
  };
  const dlg = el('dialog', {}, el('h2', {}, isNew ? 'カスタム項目を追加' : `項目を編集: ${f.field_name}`),
    lab('表示名', name, f && f.master_key ? '内部ID(field_id)は変わりません。表示名のみ変更されます。' : null), lab('入力形式', type), choiceBox, consentBox,
    lab('プレースホルダー', ph), lab('利用目的(会員に表示)', purpose), lab('表示範囲', vis),
    el('label', { className: 'lb' }, required, ' 必須'), el('label', { className: 'lb' }, editable, ' ユーザー自身が変更できる'), lab('付与からの有効日数(任意)', days, '会員に届いてからの日数です(例: 誕生日クーポンで30)。有効期限と両方ある場合は早い方が優先。空欄なら制限なし。'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('キャンセル', () => dlg.close()), btn(isNew ? '下書きに追加' : '下書きに反映', run(err, async () => apply()), 'pri'),
    ), el('div', { className: 'hint', style: 'text-align:right' }, '「保存」ボタンを押すまで、会員には反映されません。'));
  document.body.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}

// ---------- 会員証デザイン ----------
// 画像は端末側で縮小・圧縮してからアップロードする (サーバ上限 400KB)。
async function compressImage(file, { maxSide, types }) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    for (const type of types) for (const q of [0.9, 0.8, 0.7, 0.55, 0.4]) {
      const blob = await new Promise((r) => c.toBlob(r, type, q));
      if (blob && blob.type === type && blob.size <= 380_000) return blob;
      if (type === 'image/png' && blob && blob.type === type) break; // PNGは品質指定が効かないので1回だけ
    }
    throw new Error('画像が大きすぎます。解像度の低い画像を選んでください');
  } finally { URL.revokeObjectURL(url); }
}
const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('画像を読み込めません')); r.readAsDataURL(blob); });

async function cardView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  await loadScript('/vendor/qrcode.min.js');
  const server = await api('/card');
  let design = structuredClone(server.design), dirty = false;
  const images = {}, urls = {}; // assetId -> Image / blob URL (プレビューの画像用)
  const getImage = async (id) => { if (!id) return null; if (!images[id]) { try { urls[id] = URL.createObjectURL(await api(`/card/assets/${id}`, { blob: true })); images[id] = await loadImage(urls[id]); } catch { images[id] = null; } } return images[id]; };
  const sample = { shop: server.tenantName, name: '山田 太郎', nameParts: { family: '山田', given: '太郎' }, memberNumber: '000123', registeredAt: '2026-04-01T00:00:00Z', lastVisitAt: new Date().toISOString(), visitCount: 12 };
  const qr = makeQr('PREVIEW-SAMPLE', 190);
  const canvas = document.createElement('canvas'); // 「カード画像をダウンロード」用 (画面には出さない)
  // プレビューは、会員が実際に見る画面(/app?preview=1)をそのまま埋め込む。同じコードで描くので、見た目が必ず一致する
  const frame = el('iframe', { src: '/app?preview=1', title: '会員画面のプレビュー', style: 'width:390px;height:780px;border:0;background:transparent;transform:scale(.76);transform-origin:top left' }); // 実機(約390px幅)の表示を縮小して見せる
  const phone = el('div', { className: 'phone', style: 'padding:0;overflow:hidden;max-height:none;height:593px' }, frame);
  const err = el('div', { className: 'err' }), ok = el('div', { className: 'ok' }), state = el('span', { className: 'hint' }, '');
  let frameReady = false;
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === 'preview-ready') { frameReady = true; redraw(); } });
  const rankCfg = featOn('rank') && can('CARD_DESIGN') ? await api('/ranks') : null;
  const sampleRank = () => { // 設定中のランクのうち、来店12回のときのもの (会員画面と同じ計算)
    if (!rankCfg?.enabled) return null;
    let idx = 0; rankCfg.ranks.forEach((r, i) => { if (12 >= r.min_visits) idx = i; });
    const r = rankCfg.ranks[idx], nx = rankCfg.ranks[idx + 1];
    return { title: r.title, stars: idx + 1, starColor: r.star_color, color1: r.card_color1 || '', color2: r.card_color2 || '', next: nx ? { title: nx.title, remaining: nx.min_visits - 12 } : null };
  };
  const redraw = async () => {
    const [logo, bg] = await Promise.all([getImage(design.logo.imageId), getImage(design.background.imageId)]);
    const rank = sampleRank();
    drawCard(canvas, design, { ...sample, rank }, { logo, bg, qr: design.qr === 'inside' ? qr : null });
    if (!frameReady || !frame.contentWindow) return;
    const me = { registered: true, shop: server.tenantName, member_number: '000123', last_visit_at: new Date().toISOString(), visit_count: 12, registered_at: sample.registeredAt,
      items: [{ field_id: 'a', label: '氏名', value: '山田 太郎' }, { field_id: 'b', label: '電話番号', value: '090XXXXXXXX' }], consents: { LINE: true }, prefs: { news: true, coupon: true, birthday: true },
      rank, card: design, card_data: { name: '山田 太郎', parts: sample.nameParts, registered_at: sample.registeredAt }, shopcardUrl: 'https://line.me/', notice: null, sampleCoupon: featOn('coupons') };
    frame.contentWindow.postMessage({ type: 'preview', me, assetUrls: urls }, location.origin);
  };
  const touch = (custom = true) => { if (custom) design.template = 'custom'; dirty = true; state.textContent = '未保存の変更があります'; ok.textContent = ''; redraw(); };

  // ---- 入力部品 ----
  const bindColor = (get, set) => { const i = el('input', { type: 'color', value: get(), oninput: () => { set(i.value); touch(); } }); return i; };
  const bindSelect = (opts, get, set) => { const s = el('select', { onchange: () => { set(s.value); touch(); redraw(); drawControls(); } }, opts.map(([v, t]) => el('option', { value: v, selected: v === get() }, t))); return s; };
  const bindCheck = (text, get, set) => { const i = el('input', { type: 'checkbox', checked: get(), onchange: () => { set(i.checked); touch(); } }); return el('label', { className: 'lb', style: 'font-weight:400' }, i, ` ${text}`); };
  const bindText = (get, set, ph, max, key) => { const i = el('input', { type: 'text', value: get(), placeholder: ph ?? '', maxLength: max, oninput: () => { set(i.value); touch(); } }); if (key) i.dataset.key = key; return i; };
  const bindRange = (min, max, step, get, set, unit = '') => { const lab2 = el('span', { className: 'hint' }, ` ${get()}${unit}`); const i = el('input', { type: 'range', min, max, step, value: get(), oninput: () => { set(Number(i.value)); lab2.textContent = ` ${i.value}${unit}`; touch(); } }); return el('div', {}, i, lab2); };

  // 画像のアップロード (kind: logo | background)
  const uploadBox = (kind, get, set) => {
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
    const note = el('span', { className: 'hint' }, get() ? 'アップロード済み' : '未設定');
    file.onchange = run(err, async () => {
      const f = file.files[0]; if (!f) return; err.textContent = ''; note.textContent = '処理中...';
      const blob = await compressImage(f, kind === 'logo' ? { maxSide: 600, types: ['image/webp', 'image/png'] } : { maxSide: 1400, types: ['image/jpeg'] });
      const r = await api('/card/assets', { method: 'POST', body: { kind, mime: blob.type, data: await blobToBase64(blob) } });
      images[r.id] = await loadImage(URL.createObjectURL(blob));
      set(r.id); note.textContent = `アップロード済み(${Math.round(blob.size / 1000)}KB)`; touch(); drawControls();
    });
    return el('div', { className: 'row' }, btn(get() ? '画像を変更' : '画像を選ぶ', () => file.click()), get() ? btn('画像を外す', () => { set(null); touch(); drawControls(); }, 'sm') : null, note, file);
  };

  const controls = el('div');
  function drawControls() {
    const bg = design.background;
    const sec = (title, ...kids) => el('div', { style: 'margin-bottom:18px' }, el('h2', { style: 'margin-top:0' }, title), ...kids);
    controls.replaceChildren(
      sec('テンプレート', el('div', { className: 'row' }, Object.entries(PRESETS).map(([k, p]) => btn(p.label, () => {
        const d = p.design, pg = { ...design.page, ...d.page };
        design = { ...design, ...d, background: { ...design.background, ...d.background }, page: pg, template: k };
        if (k === 'photo' && !design.background.imageId) design.background.type = 'gradient'; // 画像が無い間は色の背景にしておく
        touch(false); drawControls();
      }, design.template === k ? 'pri' : ''))), el('div', { className: 'hint' }, 'テンプレートを選んだあと、色や文字を自由に変えられます。')),
      sec('背景', lab('種類', bindSelect([['solid', '単色'], ['gradient', 'グラデーション'], ['image', '画像']], () => bg.type, (v) => { bg.type = v; })),
        bg.type !== 'image' ? lab(bg.type === 'solid' ? '色' : '色1', bindColor(() => bg.color1, (v) => { bg.color1 = v; })) : null,
        bg.type === 'gradient' ? [lab('色2', bindColor(() => bg.color2, (v) => { bg.color2 = v; })), lab('角度', bindRange(0, 360, 15, () => bg.angle, (v) => { bg.angle = v; }, '°'))] : null,
        bg.type === 'image' ? [lab('背景画像', uploadBox('background', () => bg.imageId, (v) => { bg.imageId = v; }), '横長の画像がおすすめです(自動で縮小されます)。'), lab('暗さ(文字を読みやすくします)', bindRange(0, 80, 5, () => bg.overlay, (v) => { bg.overlay = v; }, '%'))] : null),
      sec('文字と色', lab('文字の色', bindColor(() => design.textColor, (v) => { design.textColor = v; })), lab('アクセント色(線など)', bindColor(() => design.accentColor, (v) => { design.accentColor = v; })),
        lab('書体', bindSelect([['sans', 'ゴシック'], ['serif', '明朝']], () => design.font, (v) => { design.font = v; })), lab('カードの角', bindSelect([['large', '丸い'], ['small', '少し丸い'], ['none', '角ばった']], () => design.radius, (v) => { design.radius = v; }))),
      sec('ロゴ', lab('ロゴ画像', uploadBox('logo', () => design.logo.imageId, (v) => { design.logo.imageId = v; }), '背景が透明なPNGがきれいです(自動で縮小されます)。'),
        lab('位置', bindSelect([['top-left', '左上'], ['top-center', '中央'], ['top-right', '右上']], () => design.logo.position, (v) => { design.logo.position = v; })),
        lab('大きさ', bindSelect([['S', '小'], ['M', '中'], ['L', '大']], () => design.logo.size, (v) => { design.logo.size = v; }))),
      sec('文言', bindCheck('店舗名を表示する', () => design.shopName.show, (v) => { design.shopName.show = v; }),
        lab('カードに表示する店舗名', bindText(() => design.shopName.text, (v) => { design.shopName.text = v; }, server.tenantName, 30, 'shop'), `カードと、会員画面の見出しに表示されます。空欄のときは、登録されている店舗名「${server.tenantName}」を使います。`),
        lab('店舗名の大きさ', bindSelect([['S', '小'], ['M', '中'], ['L', '大']], () => design.shopName.size, (v) => { design.shopName.size = v; })),
        lab('店舗名の位置', bindSelect([['left', '左'], ['center', '中央']], () => design.shopName.align, (v) => { design.shopName.align = v; })),
        lab('カードのタイトル', bindText(() => design.title, (v) => { design.title = v; }, 'MEMBER CARD', 24, 'title'))),
      sec('カードに表示する項目', el('div', { className: 'hint' }, '会員番号は常に表示されます。'), bindCheck('氏名', () => design.fields.name, (v) => { design.fields.name = v; }),
        lab('氏名の並び順', bindSelect([['asis', '登録されたとおり(例: 山田 太郎)'], ['swap', '姓と名を入れ替える(例: 太郎 山田)']], () => design.fields.nameOrder ?? 'asis', (v) => { design.fields.nameOrder = v; }), '姓と名が別の項目(マスタの「姓」「名」)のときは、その2項目を並べ替えて表示します。1つの氏名項目のときは、姓と名の間に空白があるときだけ入れ替わります。'), bindCheck('登録日', () => design.fields.registeredAt, (v) => { design.fields.registeredAt = v; }),
        bindCheck('最終来店日', () => design.fields.lastVisit, (v) => { design.fields.lastVisit = v; }), bindCheck('来店回数', () => design.fields.visitCount, (v) => { design.fields.visitCount = v; }),
        lab('QRコードの位置', bindSelect([['below', 'カードの下'], ['inside', 'カードの中(右下)']], () => design.qr, (v) => { design.qr = v; }), 'カードの中に入れると、画像として保存したカードにはQRは含まれません(QRは5分で失効するため)。')),
      sec('会員画面の見た目', lab('ボタンの色', bindColor(() => design.page.accentColor, (v) => { design.page.accentColor = v; }), '丸いボタンの枠・アイコンと、主なボタンの色です。'), lab('画面の背景色', bindColor(() => design.page.backgroundColor, (v) => { design.page.backgroundColor = v; })),
        lab('メッセージ(カードの下に表示)', bindText(() => design.page.welcomeText, (v) => { design.page.welcomeText = v; }, '例: ご来店ありがとうございます', 120)),
        bindCheck('「登録情報」(折りたたみの一覧)を表示する', () => design.page.showInfoList, (v) => { design.page.showInfoList = v; }), bindCheck('公式LINEのショップカードのボタンを表示する(URLを設定した場合)', () => design.page.showShopcard, (v) => { design.page.showShopcard = v; }),
        bindCheck('「お知らせ」ボタン(LINEのお知らせの受け取り設定)を表示する', () => design.page.showNotice, (v) => { design.page.showNotice = v; })),
    );
  }

  const save = run(err, async () => {
    err.textContent = ''; ok.textContent = '';
    const r = await api('/card', { method: 'PUT', body: { design } });
    design = r.design; dirty = false; state.textContent = ''; ok.textContent = `保存しました(会員の画面に反映されます / v${r.version})`; drawControls(); redraw();
  });
  const reset = () => { if (!confirm('デザインを初期状態に戻します(保存するまで反映されません)。')) return; design = { ...structuredClone(PRESETS.classic.design), template: 'classic', background: { ...PRESETS.classic.design.background, imageId: null }, logo: { imageId: null, position: 'top-left', size: 'M' },
      shopName: { show: true, text: '', size: 'M', align: 'left' }, title: 'MEMBER CARD', fields: { name: true, nameOrder: 'asis', registeredAt: false, lastVisit: true, visitCount: true }, qr: 'below', page: { ...PRESETS.classic.design.page, welcomeText: '', showInfoList: true, showShopcard: true, showNotice: true } }; touch(false); drawControls(); };
  const download = () => canvas.toBlob((b) => { const a = el('a', { href: URL.createObjectURL(b), download: 'member-card.png' }); document.body.append(a); a.click(); a.remove(); }, 'image/png');

  drawControls(); await redraw();
  layout(el('div', { className: 'grid' },
    el('div', { className: 'card' }, el('h2', {}, '会員証デザイン'), el('div', { className: 'hint', style: 'margin-bottom:12px' }, '右のプレビューを見ながら調整し、「保存」を押すと、会員のスマホの会員証に反映されます。'), controls, err, ok,
      el('div', { className: 'row', style: 'margin-top:8px' }, btn('保存', save, 'pri'), btn('カード画像をダウンロード', download), btn('初期状態に戻す', reset, 'dng'), state)),
    el('div', { className: 'card', style: 'position:sticky;top:12px;align-self:start' }, el('h2', {}, 'プレビュー(会員のスマホ画面と同じ表示)'), phone, el('div', { className: 'hint', style: 'margin-top:6px' }, 'サンプルのデータ(来店12回・クーポンあり)です。ショップカードのボタンは、店舗のURLを設定している場合に表示されます。'))));
}

// ---------- 会員 ----------
const loadRankTitles = async () => { try { ST.rankTitles = featOn('rank') ? (await api('/ranks/titles')).titles : []; } catch { ST.rankTitles = []; } };
const BUILTIN_BASE = [['days_since_last_visit', '最終来店からの日数', 'num'], ['visit_count', '来店回数', 'num'], ['days_until_birthday', '誕生日までの日数', 'num'], ['registered_at', '登録日', 'date']];
const OPS = [['eq', '＝'], ['ne', '≠'], ['contains', '含む'], ['gte', '以上'], ['lte', '以下'], ['empty', '未登録'], ['notEmpty', '登録あり']];
const builtin = () => [...BUILTIN_BASE, ...(ST.rankTitles?.length ? [['rank', '会員ランク', 'text']] : [])]; // ランクが有効なときだけ「会員ランク」で絞り込める
let sortSel = { field: 'registered_at', dir: 'desc' };
const memberState = { conds: [], logic: 'AND', status: 'ACTIVE' };
const msgState = { conds: [], logic: 'AND' };

// 絞り込み条件エディタ (会員検索とメッセージ配信のセグメントで共用)。AND/OR を切り替えられる。
function condBuilder(state) {
  const fieldOpts = [...builtin().map(([k, t]) => [k, t]), ...ST.fields.map((f) => [f.field_id, f.field_name])];
  const numeric = (k) => builtin().find((b) => b[0] === k)?.[2] === 'num' || ST.fields.find((f) => f.field_id === k)?.field_type === 'NUMBER';
  const list = el('div');
  const draw = () => list.replaceChildren(...state.conds.map((c, i) => {
    const fs = el('select', { onchange: () => { c.field = fs.value; c.value = ''; draw(); } }, fieldOpts.map(([k, t]) => el('option', { value: k, selected: k === c.field }, t)));
    const os = el('select', { onchange: () => { c.op = os.value; } }, OPS.map(([k, t]) => el('option', { value: k, selected: k === c.op }, t)));
    const v = c.field === 'rank' ? el('select', { onchange: () => { c.value = v.value; } }, (ST.rankTitles ?? []).map((t) => el('option', { value: t, selected: t === c.value }, t))) : el('input', { type: 'text', value: c.value ?? '', placeholder: '値', oninput: () => { c.value = v.value; } });
    if (c.field === 'rank' && !c.value) c.value = ST.rankTitles?.[0] ?? '';
    return el('div', { className: 'cond' }, fs, os, v, btn('×', () => { state.conds.splice(i, 1); draw(); }, 'sm'));
  }));
  const logic = el('select', { style: 'width:auto;flex:0 0 auto', onchange: () => { state.logic = logic.value; } },
    [['AND', 'すべての条件に一致 (AND)'], ['OR', 'いずれかの条件に一致 (OR)']].map(([k, t]) => el('option', { value: k, selected: k === state.logic }, t)));
  draw();
  return {
    node: el('div', {}, list, el('div', { className: 'row' }, btn('＋ 条件を追加', () => { state.conds.push({ field: fieldOpts[0][0], op: 'eq', value: '' }); draw(); }), logic)),
    where: () => (state.conds.length ? { logic: state.logic, conditions: state.conds.map((c) => ({ field: c.field, op: c.op, value: ['empty', 'notEmpty'].includes(c.op) ? undefined : (numeric(c.field) ? Number(c.value) : c.value) })) } : undefined),
  };
}

// 一覧の表示項目 (標準項目 + 会員登録フォームの全項目)。選択と並び順は、この端末のブラウザに保存される。
const BUILTIN_COLS = [['member_number', '会員番号'], ['status', '状態'], ['registered_at', '登録日'], ['visit_count', '来店回数'], ['last_visit_at', '最終来店']];
const colStoreKey = () => `mc:${ST.tenant ?? ST.me.tenantId}:${ST.me.id}`;
const prefs = {
  load() { try { return JSON.parse(localStorage.getItem(colStoreKey()) ?? 'null'); } catch { return null; } },
  save(v) { try { v ? localStorage.setItem(colStoreKey(), JSON.stringify(v)) : localStorage.removeItem(colStoreKey()); } catch { /* 保存できなくても動作する */ } },
};
const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const jstDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const dt = (iso, withTime) => (iso && !Number.isNaN(Date.parse(iso)) ? (withTime ? jst : jstDay).format(new Date(iso)) : '-');
const PAGE_SIZES = [20, 50, 100];
const listState = { page: 0, size: 20, cols: null };

async function membersView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields; await loadRankTitles();
  const fieldCols = ST.fields.map((f) => [f.field_id, f.field_name + (f.enabled ? '' : '(非表示中)')]);
  const allCols = [...BUILTIN_COLS, ...fieldCols], label = (id) => allCols.find(([k]) => k === id)?.[1] ?? id;
  const isField = (id) => ST.fields.some((f) => f.field_id === id);
  const defaults = () => ['member_number', ...ST.fields.filter((f) => f.enabled).slice(0, 4).map((f) => f.field_id), 'registered_at', 'visit_count', 'last_visit_at', 'status'];
  const saved = prefs.load();
  if (saved?.size && PAGE_SIZES.includes(saved.size)) listState.size = saved.size;
  const valid = (list) => (list ?? []).filter((id) => allCols.some(([k]) => k === id));
  listState.cols = valid(listState.cols ?? saved?.cols);
  if (!listState.cols.length) listState.cols = defaults();
  const persist = () => prefs.save({ cols: listState.cols, size: listState.size });

  const cb = condBuilder(memberState);
  const out = el('div'), err = el('div', { className: 'err' });
  const cell = (m, id) => {
    if (id === 'member_number') return m.member_number;
    if (id === 'status') return m.status === 'WITHDRAWN' ? '退会済み' : '有効';
    if (id === 'registered_at') return dt(m.registered_at, false);
    if (id === 'visit_count') return String(m.visit_count ?? 0);
    if (id === 'last_visit_at') return dt(m.last_visit_at, true);
    return m.values?.[id] || '-';
  };
  const sortBy = (id) => { sortSel = sortSel.field === id ? { field: id, dir: sortSel.dir === 'asc' ? 'desc' : 'asc' } : { field: id, dir: ['registered_at', 'visit_count', 'last_visit_at'].includes(id) ? 'desc' : 'asc' }; listState.page = 0; search(); };

  const pager = (total) => {
    const pages = Math.max(1, Math.ceil(total / listState.size)), cur = Math.min(listState.page, pages - 1);
    const go = (n) => { listState.page = Math.min(Math.max(n, 0), pages - 1); search(); };
    const from = total ? cur * listState.size + 1 : 0, to = Math.min(total, (cur + 1) * listState.size);
    const nums = []; for (let i = Math.max(0, cur - 2); i <= Math.min(pages - 1, cur + 2); i++) nums.push(i);
    const size = el('select', { style: 'width:auto;flex:0 0 auto', onchange: () => { listState.size = Number(size.value); listState.page = 0; persist(); search(); } },
      PAGE_SIZES.map((n) => el('option', { value: n, selected: n === listState.size }, `${n}件ずつ`)));
    return el('div', { className: 'row', style: 'margin:8px 0;justify-content:space-between' }, el('span', { className: 'hint' }, `${total}件中 ${from}〜${to}件`),
      el('div', { className: 'row' }, btn('« 最初', () => go(0), 'sm'), btn('‹ 前へ', () => go(cur - 1), 'sm'),
        ...nums.map((i) => btn(String(i + 1), () => go(i), i === cur ? 'sm pri' : 'sm')), btn('次へ ›', () => go(cur + 1), 'sm'), btn('最後 »', () => go(pages - 1), 'sm'), size));
  };

  async function search() {
    err.textContent = '';
    try {
      const fieldIds = listState.cols.filter(isField);
      const r = await api('/members/search', { method: 'POST', body: { where: cb.where(), sort: sortSel, limit: listState.size, offset: listState.page * listState.size, status: memberState.status, columns: fieldIds } });
      if (r.members.length === 0 && r.total > 0 && listState.page > 0) { listState.page = Math.max(0, Math.ceil(r.total / listState.size) - 1); return search(); } // 件数が減って、最後のページが空になった場合
      const arrow = (id) => (sortSel.field === id ? (sortSel.dir === 'asc' ? ' ▲' : ' ▼') : '');
      out.replaceChildren(pager(r.total), el('div', { style: 'overflow-x:auto' }, el('table', {}, el('tr', {}, listState.cols.map((id) => el('th', { style: 'cursor:pointer;white-space:nowrap', title: 'クリックで並び替え', onclick: () => sortBy(id) }, label(id) + arrow(id)))),
        r.members.map((m) => el('tr', { className: 'click', onclick: () => memberDialog(m.member_id) }, listState.cols.map((id) => el('td', {}, cell(m, id)))))),
      r.total === 0 ? el('div', { className: 'hint', style: 'padding:12px' }, '該当する会員がいません') : null), pager(r.total));
    } catch (e) { err.className = 'err'; err.textContent = errText(e); }
  }

  // 表示項目の設定: 表示する/しない・並び順 (▲▼)
  const colsDialog = () => {
    let order = [...listState.cols, ...allCols.map(([k]) => k).filter((k) => !listState.cols.includes(k))];
    let chosen = new Set(listState.cols);
    const list = el('div');
    const draw = () => list.replaceChildren(...order.map((id, i) => el('div', { className: 'field', style: 'padding:6px 10px' },
      el('input', { type: 'checkbox', checked: chosen.has(id), onchange: (e) => { e.target.checked ? chosen.add(id) : chosen.delete(id); } }),
      el('div', { className: 'name' }, label(id)),
      btn('▲', () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }, 'sm'), btn('▼', () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }, 'sm'))));
    draw();
    const e2 = el('div', { className: 'err' });
    const d = el('dialog', {}, el('h2', {}, '一覧の表示項目'), el('div', { className: 'hint' }, 'チェックを入れた項目が表示されます。▲▼で並び順を変えられます。この設定は、このブラウザに保存されます。'), list, e2,
      el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('初期設定に戻す', () => { order = [...defaults(), ...allCols.map(([k]) => k).filter((k) => !defaults().includes(k))]; chosen = new Set(defaults()); draw(); }, 'sm'), btn('キャンセル', () => d.close()),
        btn('適用', () => { const cols = order.filter((id) => chosen.has(id)); if (!cols.length) { e2.textContent = '1つ以上の項目を選んでください'; return; } listState.cols = cols; persist(); d.close(); search(); }, 'pri')));
    document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
  };

  const stS = el('select', { style: 'width:auto;flex:0 0 auto', onchange: () => { memberState.status = stS.value; } }, [['ACTIVE', '有効な会員'], ['WITHDRAWN', '退会済みの会員'], ['ALL', 'すべて']].map(([k, t]) => el('option', { value: k, selected: k === memberState.status }, t)));
  const cards = [el('div', { className: 'card' }, el('h2', {}, '絞り込み'), cb.node,
    el('div', { className: 'row', style: 'margin-top:8px' }, stS, el('span', { className: 'sp', style: 'flex:1' }), btn('表示項目を設定', colsDialog), btn('検索', () => { listState.page = 0; search(); }, 'pri')), err),
    el('div', { className: 'card' }, out)];
  if (can('EXPORT_MEMBERS')) cards.push(exportCard(cb.where));
  layout(el('div', {}, cards));
  search();
}

function exportCard(where) {
  const cols = [['member_number', '会員番号'], ['registered_at', '登録日'], ['status', 'ステータス'],
    ...(can('EXPORT_PERSONAL_DATA') ? [['user_id', 'LINEユーザーID']] : []), ...(can('EXPORT_VISITS') ? [['last_visit_at', '最終来店日'], ['visit_count', '来店回数']] : []),
    ...ST.fields.filter((f) => f.sensitivity === 'NORMAL' || can('EXPORT_PERSONAL_DATA')).map((f) => [f.field_id, f.field_name])];
  const checks = cols.map(([k, t]) => ({ k, t, cb: el('input', { type: 'checkbox', checked: ['member_number'].includes(k) || ST.fields.some((f) => f.field_id === k && f.enabled) }) }));
  const err = el('div', { className: 'err' });
  const fmt = el('select', { style: 'width:auto' }, el('option', { value: 'xlsx' }, 'Excel (.xlsx)'), el('option', { value: 'csv' }, 'CSV'));
  const go = run(err, async () => {
    const columns = checks.filter((c) => c.cb.checked).map((c) => c.k);
    if (!columns.length) throw new Error('出力する項目を選択してください');
    const blob = await api('/export', { method: 'POST', blob: true, body: { format: fmt.value, columns, where: where(), sort: sortSel, status: memberState.status } });
    const a = el('a', { href: URL.createObjectURL(blob), download: `members-${new Date().toISOString().slice(0, 10)}.${fmt.value}` });
    document.body.append(a); a.click(); a.remove();
  });
  return el('div', { className: 'card' }, el('h2', {}, 'Excel出力'), el('div', { className: 'cols' }, checks.map((c) => el('label', {}, c.cb, ` ${c.t}`))),
    err, el('div', { className: 'row', style: 'margin-top:8px' }, fmt, btn('出力', go, 'pri'), el('span', { className: 'hint' }, '現在の絞り込み条件・状態・並び順で出力します。個人情報を含むため取り扱いに注意してください。')));
}

async function memberDialog(id) {
  const p = await api(`/members/${id}`);
  const err = el('div', { className: 'err' });
  const editFields = ST.fields.filter((f) => f.enabled);
  const init = Object.fromEntries(p.items.map((i) => [i.field_id, i.raw]));
  const form = can('MEMBER_EDIT') && p.member.status !== 'WITHDRAWN' ? buildForm(editFields, init, run(err, async (values) => { await api(`/members/${id}`, { method: 'PATCH', body: { values } }); d.close(); render(); }), '保存') : null;
  const dl = el('table', {}, p.items.map((i) => el('tr', {}, el('th', {}, i.label), el('td', { className: i.registered ? '' : 'hint' }, i.value))));
  const withdrawn = p.member.status === 'WITHDRAWN';
  const statusBtn = can('MEMBER_STATUS') ? (withdrawn
    ? btn('会員に復帰', run(err, async () => { if (confirm('この会員を有効に戻します。配信同意は復元されません。')) { await api(`/members/${id}/restore`, { method: 'POST' }); d.close(); render(); } }))
    : btn('退会処理', run(err, async () => { const reason = prompt('退会の理由(任意)', ''); if (reason !== null) { await api(`/members/${id}/withdraw`, { method: 'POST', body: { reason } }); d.close(); render(); } }), 'dng')) : null;
  const d = el('dialog', {}, el('h2', {}, `会員 ${p.member.member_number}`), withdrawn ? el('div', { className: 'badge warn' }, `退会済み(${(p.member.withdrawn_at || '').slice(0, 10)})${p.member.withdraw_reason ? ' 理由: ' + p.member.withdraw_reason : ''}`) : null, p.notice ? el('div', { className: 'badge warn' }, `${p.notice}(未入力の必須項目あり)`) : null,
    el('div', { className: 'hint' }, `配信同意: LINE ${p.consents.LINE ? '○' : '×'} / メール ${p.consents.EMAIL ? '○' : '×'} / マーケティング ${p.consents.MARKETING ? '○' : '×'}`), dl,
    form ? el('h2', { style: 'margin-top:16px' }, '情報を編集') : null, form, err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, statusBtn, can('MEMBER_EDIT') && !withdrawn ? btn('来店を記録', run(err, async () => { await api(`/members/${id}/visit`, { method: 'POST' }); d.close(); render(); })) : null, btn('閉じる', () => d.close())));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}

// ---------- 登録URL ----------
async function urlsView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const { urls } = await api('/registration-url');
  const err = el('div', { className: 'err' });
  layout(el('div', { className: 'card' }, el('h2', {}, 'リッチメニュー用 登録URL'),
    el('div', { className: 'hint' }, 'LINE公式アカウントのリッチメニュー(リンク)に設定してください。URLが漏えいした場合は無効化して再発行します。'),
    urls.map((u) => el('div', { className: 'field' }, el('div', { className: 'name' }, el('b', { style: 'word-break:break-all' }, u.url ?? `(LIFF_ID未設定) token=${u.token}`)),
      u.url ? btn('コピー', run(err, async () => { await navigator.clipboard.writeText(u.url); })) : null,
      can('FORM_EDIT') ? btn('無効化', run(err, async () => { if (confirm('このURLを無効化します。リッチメニューのリンクが使えなくなります。')) { await api(`/registration-url/${u.token}`, { method: 'DELETE' }); render(); } }), 'dng') : null)),
    err, can('FORM_EDIT') ? btn('URLを発行', run(err, async () => { await api('/registration-url', { method: 'POST' }); render(); }), 'pri') : null));
}

// ---------- 監査ログ ----------
async function auditView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  if (ST.me.role === 'STAFF') return layout(el('div', { className: 'card' }, '権限がありません。'));
  const { logs } = await api('/audit');
  layout(el('div', { className: 'card' }, el('h2', {}, '監査ログ(新しい順・最大200件)'), el('table', {}, el('tr', {}, ['日時', '操作者', '操作', '対象', '詳細'].map((h) => el('th', {}, h))),
    logs.slice(-200).reverse().map((l) => el('tr', {}, [l.created_at.replace('T', ' ').slice(0, 19), l.actor.slice(0, 8), l.action, l.target, JSON.stringify(l.detail)].map((x) => el('td', { style: 'word-break:break-all' }, x)))))));
}

// ---------- 補助 ----------
const scripts = {};
const loadScript = (src) => (scripts[src] ??= new Promise((res, rej) => { const n = el('script', { src, onload: res, onerror: () => rej(new Error('ライブラリを読み込めません')) }); document.head.append(n); }));
const fullUrl = (path) => `${location.origin}${path}`;
function infoDialog(title, lines, copyText) {
  const d = el('dialog', {}, el('h2', {}, title), ...lines.map((l) => el('p', { style: 'word-break:break-all' }, l)),
    el('div', { className: 'row', style: 'margin-top:12px;justify-content:flex-end' }, copyText ? btn('コピー', () => navigator.clipboard?.writeText(copyText)) : null, btn('閉じる', () => d.close())));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}

// 管理者一覧 (運営=全員 / 店舗管理者=自店舗)。再設定リンク発行・2FAリセットは権限のある行だけ
function adminsCard(admins, err, onChange) {
  const mine = ST.me.id;
  const manageable = (a) => a.admin_id !== mine && (ST.me.role === 'OPERATOR' || (ST.me.role === 'STORE_ADMIN' && a.role === 'STAFF'));
  return el('table', {}, el('tr', {}, ['メール', 'ロール', '店舗', '状態', '2FA', ''].map((h) => el('th', {}, h))),
    admins.map((a) => el('tr', {}, el('td', {}, a.email), el('td', {}, a.role), el('td', {}, a.tenant_id ?? '-'), el('td', {}, a.enabled ? '有効' : '無効'), el('td', {}, a.totp_enabled ? '有効' : '-'),
      el('td', {}, el('div', { className: 'row' }, ...(manageable(a) ? [
        btn('再設定リンク', run(err, async () => { const r = await api(`/admins/${a.admin_id}/reset-link`, { method: 'POST' }); const u = fullUrl(r.path); infoDialog('パスワード再設定リンク', ['本人に安全な方法で渡してください。1時間・1回限り有効です。', u], u); }), 'sm'),
        a.totp_enabled ? btn('2FAリセット', run(err, async () => { if (confirm(`${a.email} の二段階認証を解除します。`)) { await api(`/admins/${a.admin_id}/reset-2fa`, { method: 'POST' }); onChange(); } }), 'sm') : null,
        ST.me.role === 'OPERATOR' ? btn(a.enabled ? '無効化' : '有効化', run(err, async () => { await api(`/admins/${a.admin_id}/${a.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); onChange(); }), 'sm') : null] : []))))));
}

// ---------- 来店スキャン ----------
let scanStop = () => {};
const rewardText = (r) => { const ok = (r?.rewards ?? []).filter((x) => x.status === 'SENT'); return ok.length ? ` / 来店特典を送信: ${ok.map((x) => x.rule).join('、')}` : ''; };
async function scanView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const status = el('div', { style: 'font-size:16px;min-height:24px;margin:8px 0' }), video = el('video', { playsInline: true, muted: true, style: 'width:100%;max-width:420px;border-radius:10px;background:#000;display:none' });
  const list = el('div'), manual = el('input', { type: 'text', placeholder: '会員番号 (例: 000001)' });
  const { coupons: activeCoupons } = featOn('coupons') ? await api('/coupons/active') : { coupons: [] };
  const cSel = el('select', {}, activeCoupons.map((c) => el('option', { value: c.coupon_id }, `${c.title}${c.benefit ? ` (${c.benefit})` : ''}`))), cNum = el('input', { type: 'text', placeholder: '会員番号 (例: 000001)' });
  const couponManual = activeCoupons.length ? el('div', {}, el('div', { className: 'hint' }, '会員のQRが読み取れないときに使います。会員の画面で、クーポンの内容を確認してから、押してください。'),
    el('div', { className: 'row', style: 'margin-top:8px' }, cSel, cNum, btn('使用済みにする', run(status, async () => {
      const r = await api('/coupons/redeem', { method: 'POST', body: { couponId: cSel.value, memberNumber: cNum.value } });
      status.className = 'ok'; status.textContent = `✓ クーポン「${r.title}」を使用済みにしました(会員 ${r.member_number})`; cNum.value = '';
    })))) : el('div', { className: 'hint' }, '使えるクーポンがありません。');
  const loadList = async () => {
    const { visits } = await api('/visits');
    list.replaceChildren(el('table', {}, el('tr', {}, ['日時', '会員番号', '氏名', '方法'].map((h) => el('th', {}, h))),
      visits.map((v) => el('tr', {}, [v.visited_at.replace('T', ' ').slice(0, 16), v.member_number, v.name, v.method === 'QR' ? 'QR' : '手動'].map((x) => el('td', {}, x))))));
  };
  const submit = async (code) => { // 会員証のQR(来店 MC1.)と、クーポンのQR(MCP1.)の両方を読み取れる
    try {
      if (code.startsWith('MCP1.')) { const r = await api('/coupons/redeem', { method: 'POST', body: { code } }); status.className = 'ok'; status.textContent = `✓ クーポン「${r.title}」${r.benefit ? `(${r.benefit})` : ''}を使用済みにしました(会員 ${r.member_number})`; }
      else { const r = await api('/visits/scan', { method: 'POST', body: { code } }); status.className = 'ok'; status.textContent = `✓ 会員 ${r.member_number} の来店を記録しました(${r.visit_count}回目)${rewardText(r)}`; await loadList(); }
    } catch (e) { status.className = 'err'; status.textContent = e.message; }
  };
  const start = run(status, async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザはカメラに対応していません。QRコードの文字列を入力してください。');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream; video.style.display = ''; await video.play();
    let detect;
    if ('BarcodeDetector' in window) { const bd = new BarcodeDetector({ formats: ['qr_code'] }); detect = async () => (await bd.detect(video))[0]?.rawValue; }
    else {
      await loadScript('/vendor/jsQR.js');
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      detect = async () => { cv.width = video.videoWidth; cv.height = video.videoHeight; cx.drawImage(video, 0, 0); return window.jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)?.data; };
    }
    let running = true, last = '', lastAt = 0;
    scanStop = () => { running = false; stream.getTracks().forEach((t) => t.stop()); scanStop = () => {}; };
    status.className = 'hint'; status.textContent = '会員証のQR、またはクーポンのQRを、カメラにかざしてください';
    (async function loop() {
      while (running) {
        try { const v = await detect(); if (v && (v.startsWith('MC1.') || v.startsWith('MCP1.')) && !(v === last && Date.now() - lastAt < 4000)) { last = v; lastAt = Date.now(); await submit(v); } } catch { /* 読み取り失敗は継続 */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
  });
  layout(el('div', {}, el('div', { className: 'card' }, el('h2', {}, '会員証QRで来店を記録'), el('div', { className: 'hint' }, '会員がミニアプリの会員証を開き、表示されたQRコードを読み取ります。QRは5分で期限切れになり、1回しか使えません。同じ会員の連続記録は30分間抑止されます。'),
    status, video, el('div', { className: 'row', style: 'margin-top:8px' }, btn('カメラを起動', start, 'pri'), btn('停止', () => scanStop()))),
    el('div', { className: 'card' }, el('h2', {}, '会員番号で記録(カメラが使えないとき)'), el('div', { className: 'hint' }, '会員証の画面に表示されている会員番号を入力します(QRの確認なしの手動記録のため、本人確認は店頭で行ってください)。QRの文字列(MC1.…)を貼り付けても記録できます。'),
      el('div', { className: 'row', style: 'margin-top:8px' }, manual, btn('記録', run(status, async () => {
        const v = manual.value.trim().replace(/\s+/g, '');
        if (!v) return;
        if (v.startsWith('MC1.') || v.startsWith('MCP1.')) await submit(v);
        else {
          const r = await api('/members/search', { method: 'POST', body: { where: { logic: 'AND', conditions: [{ field: 'member_number', op: 'eq', value: v }] }, limit: 2 } });
          if (r.members.length !== 1) throw new Error('その会員番号の有効な会員が見つかりません');
          const m = r.members[0]; const res = await api(`/members/${m.member_id}/visit`, { method: 'POST' });
          status.className = 'ok'; status.textContent = `✓ 会員 ${m.member_number} の来店を記録しました(手動)${rewardText(res)}`; await loadList();
        }
        manual.value = '';
      })))),
    el('div', { className: 'card' }, el('h2', {}, 'クーポンを会員番号で使用済みにする(QRが使えないとき)'), couponManual),
    el('div', { className: 'card' }, el('h2', {}, '最近の来店'), list)));
  loadList();
}

// ---------- クーポン ----------
const WINDOW_LABEL = { active: '有効', expired: '期限切れ', not_started: '開始前', archived: '終了' };
const dayText = (d) => (d ? d.replaceAll('-', '/') : '');
function couponDialog(c, done) {
  const err = el('div', { className: 'err' });
  const title = el('input', { type: 'text', value: c?.title ?? '', maxLength: 40, placeholder: '例: 来店感謝クーポン' }), benefit = el('input', { type: 'text', value: c?.benefit ?? '', maxLength: 60, placeholder: '例: ドリンク1杯無料 / 全品10%OFF' });
  const desc = el('textarea', { value: c?.description ?? '', maxLength: 300, placeholder: '例: 他の割引との併用はできません。お会計時にスタッフへご提示ください。' });
  const from = el('input', { type: 'date', value: c?.valid_from ?? '' }), until = el('input', { type: 'date', value: c?.valid_until ?? '' });
  const days = el('input', { type: 'number', min: 1, max: 365, value: c?.valid_days ?? '', placeholder: '例: 30' });
  const save = run(err, async () => {
    const body = { title: title.value, benefit: benefit.value, description: desc.value, valid_from: from.value, valid_until: until.value, valid_days: days.value };
    if (c) await api(`/coupons/${c.coupon_id}`, { method: 'PUT', body }); else await api('/coupons', { method: 'POST', body });
    d.close(); done();
  });
  const d = el('dialog', {}, el('h2', {}, c ? 'クーポンを編集' : 'クーポンを作成'), lab('クーポン名(必須)', title), lab('特典の内容', benefit, 'メッセージのカードと、会員の画面に大きく表示されます。'), lab('利用条件・説明', desc),
    lab('利用開始日(任意)', from), lab('有効期限(任意)', until, '日本時間で、その日の終わりまで使えます。空欄なら期限なし。'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('キャンセル', () => d.close()), btn('保存', save, 'pri')));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}
async function couponsView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const { coupons } = await api('/coupons'), err = el('div', { className: 'err' });
  layout(el('div', { className: 'card' }, el('h2', {}, 'クーポン'),
    el('div', { className: 'hint', style: 'margin-bottom:10px' }, 'クーポンを作り、「メッセージ配信」で添付して送ります。メッセージが届いた会員にだけ配布され、1人1回使えます。会員が「クーポンを使う」で出したQRを、「来店スキャン」で読み取ると、使用済みになります。'),
    el('div', { className: 'row', style: 'margin-bottom:10px' }, btn('＋ クーポンを作成', () => couponDialog(null, render), 'pri')),
    coupons.length ? el('div', { style: 'overflow-x:auto' }, el('table', {}, el('tr', {}, ['クーポン名', '特典', '期間', '配布', '使用', '状態', ''].map((h) => el('th', {}, h))),
      coupons.map((c) => el('tr', {}, el('td', {}, c.title), el('td', {}, c.benefit || '-'), el('td', {}, (c.valid_from || c.valid_until ? `${dayText(c.valid_from)}〜${dayText(c.valid_until)}` : '期限なし') + (c.valid_days ? ` / 付与から${c.valid_days}日` : '')), el('td', {}, String(c.granted)), el('td', {}, String(c.redeemed)),
        el('td', {}, el('span', { className: `badge ${c.window === 'active' ? 'int' : ''}` }, WINDOW_LABEL[c.window])),
        el('td', {}, el('div', { className: 'row' }, btn('編集', () => couponDialog(c, render), 'sm'),
          btn(c.status === 'ARCHIVED' ? '再開' : '終了', run(err, async () => { await api(`/coupons/${c.coupon_id}/${c.status === 'ARCHIVED' ? 'restore' : 'archive'}`, { method: 'POST' }); render(); }), 'sm'))))))) : el('div', { className: 'hint' }, 'クーポンはまだありません。'), err));
}

// ---------- 予約メッセージ(定期) ----------
const KIND_LABEL = { ONCE: '1回だけ', DAILY: '毎日', WEEKLY: '毎週', MONTHLY: '毎月' }, DOW = ['日', '月', '火', '水', '木', '金', '土'];
const whenText = (s) => `${{ ONCE: `${dayText(s.run_date)} `, DAILY: '毎日 ', WEEKLY: `毎週${DOW[Number(s.weekday)]}曜 `, MONTHLY: Number(s.day_of_month) === 0 ? '毎月末 ' : `毎月${s.day_of_month}日 ` }[s.kind]}${s.time}`;
function scheduleDialog(s, offerable, done) {
  const err = el('div', { className: 'err' });
  const state = { logic: s?.where?.logic ?? 'AND', conds: (s?.where?.conditions ?? []).map((c) => ({ field: c.field, op: c.op, value: c.value ?? '' })) };
  const cb = condBuilder(state);
  const name = el('input', { type: 'text', value: s?.name ?? '', maxLength: 40, placeholder: '例: 毎週金曜のお知らせ' });
  const kind = el('select', { onchange: () => sync() }, Object.entries(KIND_LABEL).map(([k, t]) => el('option', { value: k, selected: k === (s?.kind ?? 'WEEKLY') }, t)));
  const date = el('input', { type: 'date', value: s?.run_date ?? '' });
  const dow = el('select', {}, DOW.map((t, i) => el('option', { value: i, selected: i === Number(s?.weekday ?? 5) }, `${t}曜日`)));
  const dom = el('select', {}, [...Array.from({ length: 28 }, (_, i) => [i + 1, `${i + 1}日`]), [0, '月末']].map(([v, t]) => el('option', { value: v, selected: v === Number(s?.day_of_month ?? 1) }, t)));
  const time = el('input', { type: 'time', value: s?.time ?? '12:00', style: 'max-width:130px' });
  const slot = el('div', { className: 'row' });
  const sync = () => { slot.replaceChildren(...{ ONCE: [date], DAILY: [], WEEKLY: [dow], MONTHLY: [dom] }[kind.value], time); };
  sync();
  const text = el('textarea', { maxLength: 5000, style: 'min-height:90px', value: s?.message_text ?? '' });
  const sel = el('select', {}, el('option', { value: '' }, '添付しない'), offerable.map((c) => el('option', { value: c.coupon_id, selected: c.coupon_id === s?.coupon_id }, `${c.title}${c.benefit ? ` (${c.benefit})` : ''}`)));
  if (s?.coupon_id && !offerable.some((c) => c.coupon_id === s.coupon_id)) sel.append(el('option', { value: s.coupon_id, selected: true }, '(設定済みのクーポン: 現在は無効または期限切れ)'));
  const days = el('input', { type: 'number', min: 1, max: 365, value: s?.coupon_days ?? '', placeholder: '例: 30', style: 'max-width:140px' });
  const save = run(err, async () => {
    const body = { name: name.value, kind: kind.value, run_date: date.value, weekday: dow.value, day_of_month: dom.value, time: time.value, message_text: text.value, coupon_id: sel.value, coupon_days: days.value, where: cb.where() ?? null };
    if (s) await api(`/schedules/${s.schedule_id}`, { method: 'PUT', body }); else await api('/schedules', { method: 'POST', body });
    d.close(); done();
  });
  const couponOk = can('COUPON_MANAGE') && featOn('coupons');
  const d = el('dialog', {}, el('h2', {}, s ? '予約を編集' : '予約メッセージを作成'), lab('予約名(必須)', name), lab('くり返し・送る日時', el('div', {}, kind, slot), '日本時間です。時刻になると自動で送ります(最大10分ほど遅れることがあります)。'),
    lab('メッセージ', text), couponOk ? lab('クーポンを添付(任意)', sel) : null, couponOk ? lab('クーポンの有効日数(届いてから何日間・任意)', days) : null,
    lab('配信先の絞り込み(任意)', cb.node, '空欄なら、LINE配信に同意した有効な会員全員に送ります。'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('キャンセル', () => d.close()), btn('保存', save, 'pri')));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}
async function scheduleView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields; await loadRankTitles();
  const { schedules } = await api('/schedules'), err = el('div', { className: 'err' });
  const { coupons: offerable } = (can('COUPON_MANAGE') && featOn('coupons')) ? await api('/coupons/active') : { coupons: [] };
  const result = (s) => { const r = s.last_result; return !r ? '-' : r.error ? `エラー: ${r.error}` : `${(r.at || '').replace('T', ' ').slice(0, 16)} 送信${r.sent}人${r.failed ? `(失敗${r.failed})` : ''}`; };
  layout(el('div', { className: 'card' }, el('h2', {}, '予約メッセージ(定期)'),
    el('div', { className: 'hint', style: 'margin-bottom:10px' }, '日時を決めて、メッセージ(とクーポン)を自動で配信します。1回だけ・毎日・毎週・毎月から選べます。送るのは、LINE配信に同意した有効な会員だけです。自動実行には、Cloud Scheduler の設定が必要です(手順書を参照)。'),
    el('div', { className: 'row', style: 'margin-bottom:10px' }, btn('＋ 予約を作成', () => scheduleDialog(null, offerable, render), 'pri')),
    schedules.length ? el('div', { style: 'overflow-x:auto' }, el('table', {}, el('tr', {}, ['予約名', '送る日時', '内容', '前回の結果', '状態', ''].map((h) => el('th', {}, h))),
      schedules.map((s) => el('tr', {}, el('td', {}, s.name), el('td', {}, whenText(s)), el('td', {}, [s.message_text ? s.message_text.slice(0, 20) : '', s.coupon_id ? '[クーポン]' : ''].filter(Boolean).join(' ')), el('td', {}, result(s)),
        el('td', {}, el('span', { className: `badge ${s.enabled ? 'int' : ''}` }, s.enabled ? '有効' : '停止中')),
        el('td', {}, el('div', { className: 'row' }, btn('編集', () => scheduleDialog(s, offerable, render), 'sm'),
          btn(s.enabled ? '停止' : '再開', run(err, async () => { await api(`/schedules/${s.schedule_id}`, { method: 'PUT', body: { enabled: !s.enabled } }); render(); }), 'sm'),
          btn('今すぐ送る', run(err, async () => { if (!confirm(`「${s.name}」を、今すぐ配信します。取り消しはできません。よろしいですか？`)) return; const r = await api(`/schedules/${s.schedule_id}/run`, { method: 'POST' }); alert(r.error ? `エラー: ${r.error}` : `送信 ${r.sent}人 / 失敗 ${r.failed}人`); render(); }), 'sm'),
          btn('削除', run(err, async () => { if (!confirm(`予約「${s.name}」を削除します。よろしいですか？`)) return; await api(`/schedules/${s.schedule_id}`, { method: 'DELETE' }); render(); }), 'sm'))))))) : el('div', { className: 'hint' }, '予約はまだありません。'), err));
}

// ---------- 会員ランク ----------
async function rankView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const cfg = await api('/ranks'), err = el('div', { className: 'err' }), ok = el('div', { className: 'ok' });
  const DEFAULTS = [['レギュラー', 0, '#cd7f32'], ['シルバー', 5, '#b0b7c3'], ['ゴールド', 15, '#f5b301'], ['プラチナ', 30, '#7fd3e6']];
  const st = { enabled: cfg.enabled, ranks: structuredClone(cfg.ranks) };
  const list = el('div');
  const draw = () => list.replaceChildren(...st.ranks.map((r, i) => {
    const t = el('input', { type: 'text', value: r.title, maxLength: 12, placeholder: '称号', style: 'width:110px;flex:none;padding:5px 8px', oninput: () => { r.title = t.value; sw(); } });
    const n = el('input', { type: 'number', min: 0, value: r.min_visits, disabled: i === 0, style: 'width:70px;flex:none;padding:5px 8px', oninput: () => { r.min_visits = Number(n.value); } });
    const sc = el('input', { type: 'color', value: r.star_color, title: '☆の色', style: 'width:34px;height:28px;padding:0;flex:none;border:1px solid #cfd4dc;border-radius:6px;background:none', oninput: () => { r.star_color = sc.value; sw(); } });
    const on = el('input', { type: 'checkbox', checked: !!r.card_color1, style: 'width:auto;margin:0', title: 'このランクのカード色を変える', onchange: () => { if (on.checked) { r.card_color1 = c1.value; r.card_color2 = c2.value; } else { r.card_color1 = ''; r.card_color2 = ''; } c1.disabled = c2.disabled = !on.checked; sw(); } });
    const c1 = el('input', { type: 'color', value: r.card_color1 || '#222222', disabled: !r.card_color1, title: 'カードの色1', style: 'width:34px;height:28px;padding:0;flex:none;border:1px solid #cfd4dc;border-radius:6px;background:none', oninput: () => { r.card_color1 = c1.value; sw(); } });
    const c2 = el('input', { type: 'color', value: r.card_color2 || r.card_color1 || '#444444', disabled: !r.card_color1, title: 'カードの色2', style: 'width:34px;height:28px;padding:0;flex:none;border:1px solid #cfd4dc;border-radius:6px;background:none', oninput: () => { r.card_color2 = c2.value; sw(); } });
    const swatch = el('span', { style: 'display:inline-block;min-width:96px;padding:3px 8px;border-radius:6px;font-size:13px;line-height:1.3;border:1px solid #cfd4dc;white-space:nowrap' });
    const sw = () => {
      swatch.style.background = r.card_color1 ? `linear-gradient(135deg,${r.card_color1},${r.card_color2 || r.card_color1})` : '#f1f3f6';
      swatch.style.color = r.card_color1 ? '#fff' : '#333'; swatch.replaceChildren(el('span', { style: `color:${r.star_color};text-shadow:0 0 1px rgba(0,0,0,.5)` }, '★'.repeat(i + 1)), ` ${r.title}`);
    };
    sw();
    return el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0;border-top:1px solid #eceff3' }, el('b', { style: 'width:18px' }, String(i + 1)), t, n, el('span', { className: 'hint' }, '回以上'), el('span', { className: 'hint' }, '☆'), sc, el('label', { className: 'hint', style: 'display:inline-flex;align-items:center;gap:3px' }, on, 'カード色'), c1, c2, swatch,
      i === 0 ? null : btn('×', () => { st.ranks.splice(i, 1); draw(); }, 'sm'));
  }));
  draw();
  const enabled = el('input', { type: 'checkbox', checked: st.enabled, style: 'width:auto;margin:0', onchange: () => { st.enabled = enabled.checked; } });
  const add = () => { if (st.ranks.length >= 10) return; const last = st.ranks.at(-1); st.ranks.push({ title: `ランク${st.ranks.length + 1}`, min_visits: (last?.min_visits ?? 0) + 10, star_color: '#f5b301', card_color1: '', card_color2: '' }); draw(); };
  const save = run(err, async () => { ok.textContent = ''; const r = await api('/ranks', { method: 'PUT', body: { enabled: st.enabled, ranks: st.ranks.map((x) => ({ ...x, min_visits: Number(x.min_visits) })) } }); st.ranks = structuredClone(r.ranks); draw(); ok.textContent = '保存しました'; });
  layout(el('div', { className: 'card' }, el('h2', {}, '会員ランク'),
    el('div', { className: 'hint', style: 'margin-bottom:8px' }, '来店回数に応じて、会員証に称号と★(ランクが上がるごとに1つ増える)が出ます。ランクごとに★の色と、カードの色も変えられます(背景が画像のカードは色が変わりません)。'),
    el('label', { style: 'display:inline-flex;align-items:center;gap:8px;margin:4px 0 8px;cursor:pointer' }, el('span', { style: 'display:inline-flex' }, enabled), el('b', {}, '会員ランクを有効にする')),
    list, el('div', { className: 'row', style: 'margin-top:8px' }, btn('＋ ランクを追加', add, 'sm'), btn('初期値に戻す', () => { st.ranks = DEFAULTS.map(([title, min_visits, star_color]) => ({ title, min_visits, star_color, card_color1: '', card_color2: '' })); draw(); }, 'sm'), el('span', { className: 'sp' }), btn('保存', save, 'pri')), err, ok));
}

// ---------- 運営: 店舗ごとの機能設定 ----------
async function featuresDialog(t) {
  const { features, labels } = await api(`/tenants/${t.tenant_id}/features`), err = el('div', { className: 'err' });
  const boxes = Object.entries(labels).map(([k, label]) => { const i = el('input', { type: 'checkbox', checked: features[k], style: 'width:auto;margin:0' }); return [k, i, el('label', { style: 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer' }, i, label)]; });
  const save = run(err, async () => { await api(`/tenants/${t.tenant_id}/features`, { method: 'PUT', body: Object.fromEntries(boxes.map(([k, i]) => [k, i.checked])) }); d.close(); render(); });
  const d = el('dialog', {}, el('h2', {}, `${t.name} の機能`), el('div', { className: 'hint', style: 'margin-bottom:8px' }, 'オフにした機能は、この店舗の管理者・スタッフの画面に表示されず、使えなくなります(運営は常に使えます)。'), ...boxes.map((b) => b[2]), err,
    el('div', { className: 'row', style: 'margin-top:12px;justify-content:flex-end' }, btn('キャンセル', () => d.close()), btn('保存', save, 'pri')));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}

// ---------- 来店回数配信 ----------
const RULE_STATUS = { SENT: '送信', FAILED: '失敗', SKIPPED: '未送信' };
function ruleDialog(r, offerable, done) {
  const err = el('div', { className: 'err' });
  const name = el('input', { type: 'text', value: r?.name ?? '', maxLength: 40, placeholder: '例: 5回目の来店特典' });
  const visits = el('input', { type: 'number', min: 1, max: 1000, value: r?.visits ?? 5, style: 'max-width:120px' });
  const repeat = el('select', {}, el('option', { value: '0', selected: !r?.repeat }, 'ちょうどN回目の1回だけ'), el('option', { value: '1', selected: !!r?.repeat }, 'N回ごと(5回目、10回目、15回目…)'));
  const text = el('textarea', { maxLength: 1000, style: 'min-height:100px', value: r?.message_text ?? '', placeholder: '例: {名前}さん、{回数}回目のご来店ありがとうございます!' });
  const sel = el('select', {}, el('option', { value: '' }, '添付しない'), offerable.map((c) => el('option', { value: c.coupon_id, selected: c.coupon_id === r?.coupon_id }, `${c.title}${c.benefit ? ` (${c.benefit})` : ''}`)));
  if (r?.coupon_id && !offerable.some((c) => c.coupon_id === r.coupon_id)) sel.append(el('option', { value: r.coupon_id, selected: true }, '(設定済みのクーポン: 現在は無効または期限切れ)'));
  const days = el('input', { type: 'number', min: 1, max: 365, value: r?.coupon_days ?? '', placeholder: '例: 30', style: 'max-width:140px' });
  const from = el('input', { type: 'date', value: r?.valid_from ?? '' }), until = el('input', { type: 'date', value: r?.valid_until ?? '' });
  const save = run(err, async () => {
    const body = { name: name.value, visits: Number(visits.value), repeat: repeat.value === '1', message_text: text.value, coupon_id: sel.value, coupon_days: days.value, valid_from: from.value, valid_until: until.value };
    if (r) await api(`/visit-rules/${r.rule_id}`, { method: 'PUT', body }); else await api('/visit-rules', { method: 'POST', body });
    d.close(); done();
  });
  const d = el('dialog', {}, el('h2', {}, r ? '来店回数ルールを編集' : '来店回数ルールを作成'), lab('ルール名(必須)', name), lab('何回目の来店で送るか', visits, '来店が記録された(QR読み取り・手動記録)ときに、来店回数がこの数になった会員へ送ります。'), lab('くり返し', repeat),
    lab('メッセージ', text, '{名前} と {回数} は、会員の名前と来店回数に置き換わります。空欄にするとクーポンだけを送ります。'),
    (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンを添付(任意)', sel) : null, (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンの有効日数(届いてから何日間・任意)', days) : null,
    lab('いつから(任意)', from, '予約: この日から有効になります。'), lab('いつまで(任意)', until, 'この日を過ぎると送りません(日本時間)。'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('キャンセル', () => d.close()), btn('保存', save, 'pri')));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}
async function visitRulesView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const { rules } = await api('/visit-rules'), err = el('div', { className: 'err' });
  const { coupons: offerable } = (can('COUPON_MANAGE') && featOn('coupons')) ? await api('/coupons/active') : { coupons: [] };
  layout(el('div', { className: 'card' }, el('h2', {}, '来店回数でメッセージ・クーポンを送る'),
    el('div', { className: 'hint', style: 'margin-bottom:10px' }, '「5回目の来店」などの条件を、あらかじめ予約しておきます。来店が記録された直後に、条件を満たした会員へ自動で送ります。同じ会員に同じ来店回数で重複して送ることはありません。送るのは、LINE配信に同意した会員だけです。'),
    el('div', { className: 'row', style: 'margin-bottom:10px' }, btn('＋ ルールを作成', () => ruleDialog(null, offerable, render), 'pri')),
    rules.length ? el('div', { style: 'overflow-x:auto' }, el('table', {}, el('tr', {}, ['ルール名', '条件', '内容', '期間', '送信', '状態', ''].map((h) => el('th', {}, h))),
      rules.map((r) => el('tr', {}, el('td', {}, r.name), el('td', {}, r.repeat ? `${r.visits}回ごと` : `${r.visits}回目`), el('td', {}, [r.message_text ? 'メッセージ' : '', r.coupon_id ? 'クーポン' : ''].filter(Boolean).join('+')),
        el('td', {}, r.valid_from || r.valid_until ? `${dayText(r.valid_from)}〜${dayText(r.valid_until)}` : '常時'), el('td', {}, `${r.sent}人${r.failed ? `(失敗${r.failed})` : ''}`),
        el('td', {}, el('span', { className: `badge ${r.enabled ? 'int' : ''}` }, r.enabled ? '有効' : '停止中')),
        el('td', {}, el('div', { className: 'row' }, btn('編集', () => ruleDialog(r, offerable, render), 'sm'),
          btn(r.enabled ? '停止' : '再開', run(err, async () => { await api(`/visit-rules/${r.rule_id}`, { method: 'PUT', body: { enabled: !r.enabled } }); render(); }), 'sm'),
          btn('削除', run(err, async () => { if (!confirm(`ルール「${r.name}」を削除します。よろしいですか？`)) return; await api(`/visit-rules/${r.rule_id}`, { method: 'DELETE' }); render(); }), 'sm'))))))) : el('div', { className: 'hint' }, 'ルールはまだありません。'), err));
}

// ---------- 誕生日配信 ----------
async function birthdayView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const cfg = await api('/birthday');
  const { coupons: offerable } = (can('COUPON_MANAGE') && featOn('coupons')) ? await api('/coupons/active') : { coupons: [] };
  const err = el('div', { className: 'err' }), info = el('div', { className: 'hint', style: 'font-size:14px;margin:8px 0' });
  const enabled = el('input', { type: 'checkbox', checked: cfg.enabled, style: 'width:auto;margin:0' }), days = el('input', { type: 'number', min: 0, max: 60, value: cfg.days_before });
  const text = el('textarea', { maxLength: 1000, style: 'min-height:120px', value: cfg.message_text });
  const cdays = el('input', { type: 'number', min: 1, max: 365, value: cfg.coupon_days ?? '', placeholder: '例: 30', style: 'max-width:140px' });
  const sel = el('select', {}, el('option', { value: '' }, '添付しない'), offerable.map((c) => el('option', { value: c.coupon_id, selected: c.coupon_id === cfg.coupon_id }, `${c.title}${c.benefit ? ` (${c.benefit})` : ''}`)));
  if (cfg.coupon_id && !offerable.some((c) => c.coupon_id === cfg.coupon_id)) sel.append(el('option', { value: cfg.coupon_id, selected: true }, '(設定済みのクーポン: 現在は無効または期限切れ)'));
  const show = (p) => { info.textContent = `現在の対象: 誕生日が${days.value}日以内の会員 ${p.matched}人 → 送信予定 ${p.willSend}人(LINE配信に未同意 ${p.skipped.notConsented}人 / 今年送信済み ${p.skipped.alreadySent}人)`; };
  show(cfg.preview);
  const body = () => ({ enabled: enabled.checked, days_before: Number(days.value), message_text: text.value, coupon_id: sel.value, coupon_days: cdays.value });
  const save = run(err, async () => { const r = await api('/birthday', { method: 'PUT', body: body() }); show(r.preview); alert('保存しました'); });
  const runNow = run(err, async () => {
    if (!confirm(`保存済みの設定で、対象の会員(送信予定の人数)へ今すぐ送信します。取り消しはできません。よろしいですか？\n※先に「保存」を押していない変更は反映されません。`)) return;
    const r = await api('/birthday/run', { method: 'POST' });
    alert(`送信 ${r.sent}人 / 失敗 ${r.failed}人${r.granted ? ` / クーポン配布 ${r.granted}人` : ''}${r.deferred ? `\n(上限のため ${r.deferred}人は次回に送ります)` : ''}${r.errors.length ? '\n' + r.errors.join('\n') : ''}`); render();
  });
  const lr = cfg.last_result;
  layout(el('div', {}, el('div', { className: 'card' }, el('h2', {}, '誕生日メッセージ・クーポン'),
    el('div', { className: 'hint', style: 'margin-bottom:10px' }, '誕生日が近づいた会員に、メッセージ(とクーポン)を自動で送ります。同じ会員には1年に1回だけ送ります。対象は、有効な会員でLINE配信に同意した会員だけです。会員登録フォームに「生年月日」項目が必要です。'),
    cfg.hasBirthdayField ? null : el('div', { className: 'err' }, '会員登録フォームに「生年月日」の項目がありません。「会員登録フォーム」タブで追加してください。'),
    el('label', { style: 'display:inline-flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer' }, el('span', { style: 'display:inline-flex' }, enabled), el('b', {}, '誕生日配信を有効にする(毎日自動で実行)')),
    lab('誕生日の何日前から送るか', days, '0=誕生日当日。例: 7 → 誕生日の7日前〜当日に入った会員へ、その日のうちに送ります。'),
    lab('メッセージ', text, '{名前} は会員の名前に置き換わります。空欄にするとクーポンだけを送ります。'),
    (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンを添付(任意)', sel) : null,
    (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンの有効日数(配信から何日間)', cdays, '例: 30 → 受け取ってから30日間使えます。空欄のときは、クーポン自体の設定(有効期限など)に従います。クーポンに有効期限がある場合は、早い方が優先されます。') : null,
    info, err, el('div', { className: 'row' }, btn('保存', save, 'pri'), btn('今すぐ実行', runNow))),
    el('div', { className: 'card' }, el('h2', {}, '前回の実行'), lr ? el('div', {}, `${(cfg.last_run_at || '').replace('T', ' ').slice(0, 16)} UTC — ${lr.error ? `エラー: ${lr.error}` : `送信 ${lr.sent}人 / 失敗 ${lr.failed}人 / クーポン配布 ${lr.granted}人${lr.deferred ? ` / 持ち越し ${lr.deferred}人` : ''}`}`) : el('div', { className: 'hint' }, 'まだ実行されていません。'))));
}

// ---------- メッセージ配信 ----------
async function messagesView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields; await loadRankTitles();
  const { messages } = await api('/messages');
  const { coupons: offerable } = (can('COUPON_MANAGE') && featOn('coupons')) ? await api('/coupons/active') : { coupons: [] };
  const cb = condBuilder(msgState);
  const couponSel = el('select', {}, el('option', { value: '' }, '添付しない'), offerable.map((c) => el('option', { value: c.coupon_id }, `${c.title}${c.benefit ? ` (${c.benefit})` : ''}`)));
  const text = el('textarea', { maxLength: 5000, style: 'min-height:140px', placeholder: '配信するメッセージ(テキスト)' });
  const mdays = el('input', { type: 'number', min: 1, max: 365, placeholder: '例: 30', style: 'max-width:140px' });
  const count = el('div', { style: 'font-size:16px;margin:8px 0' }), err = el('div', { className: 'err' });
  let expected = null;
  const sendBtn = btn('送信', run(err, async () => {
    if (expected === null) throw new Error('先に「対象人数を確認」を押してください');
    if (!text.value.trim() && !couponSel.value) throw new Error('メッセージを入力するか、クーポンを添付してください');
    if (!confirm(`${expected}人にメッセージ${couponSel.value ? '(クーポン付き)' : ''}を送信します。取り消しはできません。よろしいですか？`)) return;
    const r = await api('/messages/send', { method: 'POST', body: { text: text.value, where: cb.where(), expectedCount: expected, couponId: couponSel.value || undefined, couponDays: mdays.value } });
    alert(`送信結果: ${r.status}(成功 ${r.sent}人 / 失敗 ${r.failed}人${couponSel.value ? ` / クーポン配布 ${r.granted}人` : ''})${r.errors.length ? '\n' + r.errors.join('\n') : ''}`); render();
  }), 'pri');
  const preview = btn('対象人数を確認', run(err, async () => {
    const r = await api('/messages/preview', { method: 'POST', body: { where: cb.where(), couponId: couponSel.value || undefined } });
    expected = r.audience; count.textContent = `配信対象: ${r.audience}人(条件に一致した有効会員 ${r.matched}人のうち、LINE配信に同意している会員)`;
  }));
  layout(el('div', {}, el('div', { className: 'card' }, el('h2', {}, 'LINEメッセージ配信'),
    el('div', { className: 'hint' }, '配信できるのは、有効な会員のうちLINE配信に同意した会員だけです(退会済み・未同意の会員には送られません)。送信にはLINE連携タブでチャネルアクセストークンの登録が必要です。'),
    lab('メッセージ', text), (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンを添付(任意)', couponSel, offerable.length ? 'メッセージの下に、クーポンのカード(「クーポンを使う」ボタン付き)が付きます。届いた会員にだけ配布されます。' : '有効なクーポンがありません。「クーポン」タブで作成してください。') : null,
    (can('COUPON_MANAGE') && featOn('coupons')) ? lab('クーポンの有効日数(配信から何日間・任意)', mdays, '例: 30 → 届いてから30日間使えます。空欄のときは、クーポン自体の設定に従います。') : null, el('h2', { style: 'margin-top:16px' }, '配信先の絞り込み(任意)'), cb.node, count, err, el('div', { className: 'row' }, preview, sendBtn)),
    el('div', { className: 'card' }, el('h2', {}, '配信履歴'), el('table', {}, el('tr', {}, ['日時', '内容', '対象', '成功', '失敗', '状態'].map((h) => el('th', {}, h))),
      messages.map((m) => el('tr', {}, [m.created_at.replace('T', ' ').slice(0, 16), m.text.slice(0, 40), m.audience, m.sent, m.failed, m.status].map((x) => el('td', {}, String(x)))))))));
}

// ---------- LINE連携 ----------
async function lineView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const c = await api('/line-settings');
  const err = el('div', { className: 'err' }), ok = el('div', { className: 'ok' });
  const liff = el('input', { type: 'text', value: c.liffId, placeholder: c.usingDefaults.liffId ? '(共通設定を使用中)' : '例: 1234567890-AbcdEfgh' });
  const ch = el('input', { type: 'text', value: c.loginChannelId, placeholder: c.usingDefaults.loginChannelId ? '(共通設定を使用中)' : '例: 1234567890' });
  const tok = el('input', { type: 'password', autocomplete: 'off', placeholder: c.hasMessagingToken ? '登録済み(変更する場合のみ入力)' : 'チャネルアクセストークン(長期)' });
  const shop = el('input', { type: 'text', value: c.shopcardUrl, placeholder: 'https://lin.ee/xxxx または https://line.me/...' });
  // 会員登録の条件: 公式アカウントの友だち追加 (確認にはメッセージ用トークンが必要。LINEのサーバーに問い合わせて確かめる)
  const rfInit = c.requireFriend ? 'on' : 'off';
  const rf = el('select', {}, [['on', '必須にする(推奨)'], ['off', '必須にしない']].map(([v, t]) => el('option', { value: v, selected: v === rfInit }, t)));
  const fu = el('input', { type: 'text', value: c.friendUrl, placeholder: '空欄なら自動(公式アカウントのベーシックIDから作成)  例: https://lin.ee/xxxx' });
  const save = run(err, async () => {
    ok.textContent = '';
    const body = { liffId: liff.value, loginChannelId: ch.value, shopcardUrl: shop.value, friendUrl: fu.value }; if (tok.value) body.messagingToken = tok.value;
    if (rf.value !== rfInit) body.requireFriend = rf.value === 'on'; // 変更したときだけ送る(未設定の「トークンがあれば有効」を保つため)
    await api('/line-settings', { method: 'PUT', body }); ok.textContent = '保存しました'; tok.value = '';
  });
  const test = run(err, async () => { ok.textContent = ''; const r = await api('/line-settings/test', { method: 'POST' }); ok.textContent = `接続OK: ${r.displayName} (${r.basicId ?? ''})`; });
  layout(el('div', { className: 'card' }, el('h2', {}, 'LINE連携設定'),
    el('div', { className: 'hint' }, '別法人の店舗では、店舗のLINE公式アカウントと同じプロバイダー内にLINEログインチャネル/LIFFを作成し、その値を設定してください(プロバイダーが異なるとメッセージ配信のユーザーIDが一致しません)。'),
    lab('LIFF ID(ミニアプリ)', liff, 'リッチメニューのURLに使われます。空欄なら共通設定を使用します。'), lab('LINEログインチャネルID', ch, '会員のLINEログイン(IDトークン)の検証に使われます。'),
    lab('メッセージ用 チャネルアクセストークン', tok, '暗号化して保存され、画面には表示されません。配信に使います。'),
    lab('友だち追加を、会員登録の条件にする', rf, c.hasMessagingToken ? '友だち追加していない人は、会員登録できません(LINEのサーバーに問い合わせて確認します)。ユーザーIDと公式アカウントが同じプロバイダーでないと、友だちでも確認できず、登録できなくなります。' : '確認には、上のメッセージ用チャネルアクセストークンの登録が必要です(未登録の間は確認しません)。'),
    lab('友だち追加のURL(任意)', fu, '登録画面の「友だち追加する」ボタンの移動先です。'),
    lab('公式LINE ショップカードのURL', shop, '会員証の画面に「ショップカードを開く」ボタンが表示されます。LINEのURLのみ設定できます。'),
    err, ok, el('div', { className: 'row', style: 'margin-top:12px' }, btn('保存', save, 'pri'), c.hasMessagingToken ? btn('接続テスト', test) : null)));
}

// ---------- アカウント (パスワード / 二段階認証 / スタッフ) ----------
async function accountView() {
  const sec = await api('/security');
  const e1 = el('div', { className: 'err' }), o1 = el('div', { className: 'ok' }), e2 = el('div', { className: 'err' });
  const cur = el('input', { type: 'password', autocomplete: 'current-password' }), nw = el('input', { type: 'password', autocomplete: 'new-password' });
  const pwCard = el('div', { className: 'card' }, el('h2', {}, 'パスワードの変更'), lab('現在のパスワード', cur), lab('新しいパスワード(10文字以上)', nw), e1, o1,
    el('div', { className: 'row', style: 'margin-top:8px' }, btn('変更する', run(e1, async () => { o1.textContent = ''; const r = await api('/security/password', { method: 'POST', body: { current: cur.value, next: nw.value } }); store.set(r.token); cur.value = nw.value = ''; o1.textContent = '変更しました(他の端末はログアウトされます)'; }), 'pri')));
  const box = el('div');
  const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'パスワード' }), code = el('input', { type: 'text', inputMode: 'numeric', placeholder: '6桁のコード' });
  if (sec.totp) {
    box.append(el('p', { className: 'ok' }, '二段階認証は有効です。'), lab('パスワード', pw), lab('認証コード または 回復コード', code), e2,
      el('div', { className: 'row', style: 'margin-top:8px' }, btn('無効にする', run(e2, async () => { await api('/security/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } }); render(); }), 'dng')));
  } else {
    box.append(el('p', { className: 'hint' }, '認証アプリ(Google Authenticator 等)でログイン時に6桁のコードを求めます。パスワード漏えい時の不正ログインを防げます。'), lab('パスワードを入力して開始', pw), e2,
      el('div', { className: 'row', style: 'margin-top:8px' }, btn('設定を開始', run(e2, async () => {
        const r = await api('/security/2fa/setup', { method: 'POST', body: { password: pw.value } });
        await loadScript('/vendor/qrcode.min.js');
        const q = el('div', { style: 'margin:12px 0' }); new window.QRCode(q, { text: r.uri, width: 180, height: 180 });
        const c2 = el('input', { type: 'text', inputMode: 'numeric', placeholder: '6桁のコード' }), e3 = el('div', { className: 'err' });
        box.replaceChildren(el('p', {}, '認証アプリでQRコードを読み取り(または秘密鍵を入力)、表示された6桁のコードを入力してください。'), q, el('div', { className: 'hint', style: 'word-break:break-all' }, `秘密鍵: ${r.secret}`), lab('確認コード', c2), e3,
          el('div', { className: 'row', style: 'margin-top:8px' }, btn('有効にする', run(e3, async () => {
            const en = await api('/security/2fa/enable', { method: 'POST', body: { code: c2.value } });
            box.replaceChildren(el('p', { className: 'ok' }, '二段階認証を有効にしました。'), el('p', {}, '回復コード(認証アプリを使えない時に1回ずつ使えます)。今だけ表示されます。安全な場所に保管してください。'),
              el('pre', { style: 'background:#f4f5f7;padding:12px;border-radius:8px' }, en.recoveryCodes.join('\n')), btn('コピー', () => navigator.clipboard?.writeText(en.recoveryCodes.join('\n'))));
          }), 'pri')));
      }), 'pri')));
  }
  // パスキー (アプリ不要: 指紋・顔・端末の画面ロックで承認)
  const e5 = el('div', { className: 'err' }), o5 = el('div', { className: 'ok' });
  const pkPw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'パスワード' }), pkName = el('input', { type: 'text', placeholder: '名前(例: 事務所のPC、私のiPhone)', maxLength: 40 });
  const pkCard = el('div', { className: 'card' }, el('h2', {}, 'パスキー(指紋・顔認証・画面ロックでログイン)'),
    el('div', { className: 'hint' }, 'アプリのインストールは不要です。端末の指紋認証・顔認証・画面ロック解除を、ログイン時の二段階目として使えます。パスワード漏えい時の不正ログインを防げます。登録した端末ごとに設定してください。同じURL(アドレス)で開いたときだけ使えます。'),
    sec.passkeys.map((k) => el('div', { className: 'field' }, el('div', { className: 'name' }, el('b', {}, k.name), el('span', { className: 'hint' }, `登録: ${k.created_at.slice(0, 10)} / 最終使用: ${k.last_used_at ? k.last_used_at.slice(0, 10) : '-'}`)),
      btn('削除', run(e5, async () => { if (!pkPw.value) throw new Error('下のパスワード欄にパスワードを入力してください'); if (confirm(`「${k.name}」を削除します。`)) { await api('/security/passkeys/delete', { method: 'POST', body: { id: k.credential_id, password: pkPw.value } }); render(); } }), 'dng'))),
    lab('パスワード(登録・削除の確認)', pkPw), lab('このパスキーの名前', pkName), e5, o5,
    el('div', { className: 'row', style: 'margin-top:8px' }, btn('この端末にパスキーを登録', run(e5, async () => {
      o5.textContent = '';
      if (!passkeySupported()) throw new Error('このブラウザはパスキーに対応していません');
      const opt = await api('/security/passkeys/options', { method: 'POST', body: { password: pkPw.value } });
      let credential; try { credential = await createPasskey(opt); } catch (e) { throw passkeyError(e); }
      await api('/security/passkeys/register', { method: 'POST', body: { token: opt.token, credential, name: pkName.value } });
      render();
    }), 'pri')));
  // LINEでコードを受け取る (アプリ不要): 管理者のLINEアカウントを連携し、ログイン時に6桁のコードをLINEへ送る
  const e6 = el('div', { className: 'err' }), lineInfo = el('div'), lpw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'パスワード' });
  if (sec.line.linked) {
    lineInfo.append(el('p', { className: 'ok' }, 'LINEを連携済みです。ログイン時に、LINEへ認証コードが届きます。'), lab('パスワード(解除の確認)', lpw), e6,
      el('div', { className: 'row', style: 'margin-top:8px' }, btn('連携を解除', run(e6, async () => { await api('/security/line/unlink', { method: 'POST', body: { password: lpw.value } }); render(); }), 'dng')));
  } else {
    lineInfo.append(el('p', { className: 'hint' }, sec.line.available ? 'ご自身のLINEアカウントを連携します。連携したあとは、ログインのたびに、LINEへ6桁のコードが届きます(認証アプリは不要です)。公式アカウントを友だち追加していないと、コードが届きません。'
      : (ST.me.role === 'OPERATOR' ? 'システムのLINE送信設定(環境変数 LINE_SYSTEM_MESSAGING_TOKEN)がないため、利用できません。' : '先に「LINE連携」タブで、メッセージ用のチャネルアクセストークンと LIFF ID を設定してください。')), e6);
    if (sec.line.available) lineInfo.append(btn('LINEアカウントを連携する', run(e6, async () => {
      const r = await api('/security/line/start', { method: 'POST' });
      await loadScript('/vendor/qrcode.min.js');
      const q = el('div', { style: 'margin:12px 0;background:#fff;display:inline-block;padding:12px;border-radius:10px' }); new window.QRCode(q, { text: r.url, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.L }); // URLが長いので誤り訂正を下げて収める
      lineInfo.replaceChildren(el('p', {}, 'スマホのLINEで、次のQRコードを読み取る(またはリンクを開く)と、連携が完了します。10分間有効です。'), q,
        el('div', { className: 'hint', style: 'word-break:break-all' }, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'スマホで開く')), el('p', { className: 'hint' }, '連携が終わると、この画面が自動で更新されます。'));
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => { try { if ((await api('/security')).line.linked) { clearInterval(pollTimer); render(); } } catch { clearInterval(pollTimer); } if (Date.now() > r.expiresAt) clearInterval(pollTimer); }, 3000);
    }), 'pri'));
  }
  const lineCard = el('div', { className: 'card' }, el('h2', {}, 'LINEでコードを受け取る'), lineInfo);
  const cards = [pwCard, pkCard, lineCard, el('div', { className: 'card' }, el('h2', {}, `認証アプリ(6桁のコード・${sec.email})`), box)];
  if (ST.me.role === 'STORE_ADMIN') {
    const { admins } = await api('/admins'); const e4 = el('div', { className: 'err' });
    cards.push(el('div', { className: 'card' }, el('h2', {}, 'スタッフのアカウント'), el('div', { className: 'hint' }, 'パスワードを忘れたスタッフには「再設定リンク」を発行して本人に渡してください。'), adminsCard(admins, e4, render), e4));
  }
  layout(el('div', {}, cards));
}

// ---------- 運営 ----------
async function opsView() {
  const [{ tenants }, { admins }, { terms }, { master }] = await Promise.all([api('/tenants'), api('/admins'), api('/banned-terms'), api('/master')]);
  ST.tenants = tenants;
  const e1 = el('div', { className: 'err' }), e2 = el('div', { className: 'err' }), e3 = el('div', { className: 'err' }), e4 = el('div', { className: 'err' }), o4 = el('div', { className: 'ok' });
  const tid = el('input', { type: 'text', placeholder: '店舗ID (例: SHOP001)' }), tname = el('input', { type: 'text', placeholder: '店舗名' });
  const aemail = el('input', { type: 'email', placeholder: 'メールアドレス' }), apw = el('input', { type: 'password', placeholder: 'パスワード(10文字以上)', autocomplete: 'new-password' });
  const arole = el('select', {}, [['STORE_ADMIN', '店舗管理者'], ['STAFF', '店舗スタッフ'], ['OPERATOR', '運営管理者']].map(([k, t]) => el('option', { value: k }, t)));
  const atenant = el('select', {}, tenants.map((t) => el('option', { value: t.tenant_id }, `${t.name} (${t.tenant_id})`)));
  const mk = el('input', { type: 'text', placeholder: 'key (英小文字/数字/_ 例: favorite_item)' }), ml = el('input', { type: 'text', placeholder: '項目名 (例: 好きな商品)' });
  const mt = el('select', {}, Object.entries(TYPES).map(([k, v]) => el('option', { value: k }, v)));
  const ms = el('select', {}, [['NORMAL', 'NORMAL(通常)'], ['PERSONAL', 'PERSONAL(個人情報)'], ['SENSITIVE', 'SENSITIVE(要配慮)']].map(([k, v]) => el('option', { value: k }, v)));
  const mp = el('input', { type: 'text', placeholder: '利用目的(任意)' }), mo = el('textarea', { placeholder: '選択式の場合: 選択肢を1行に1つ' });
  const bt = el('textarea', { value: terms.join('\n'), style: 'min-height:140px' });
  layout(el('div', {},
    el('div', { className: 'card' }, el('h2', {}, '店舗'), tenants.map((t) => el('div', { className: 'field' }, el('div', { className: 'name' }, el('b', {}, t.name), el('span', { className: 'hint' }, t.tenant_id), el('span', { className: 'hint' }, Object.values(t.features).some((v) => !v) ? `制限あり(${Object.values(t.features).filter((v) => !v).length}機能オフ)` : ''), btn('機能設定', () => featuresDialog(t), 'sm')))),
      el('div', { className: 'row' }, tid, tname, btn('店舗を作成', run(e1, async () => { const r = await api('/tenants', { method: 'POST', body: { tenantId: tid.value.trim(), name: tname.value.trim() } }); infoDialog('店舗を作成しました', [`登録token: ${r.registrationToken}`]); render(); }), 'pri')), e1),
    el('div', { className: 'card' }, el('h2', {}, '管理者アカウント'), adminsCard(admins, e2, render),
      el('div', { className: 'row', style: 'margin-top:12px' }, aemail, apw, arole, atenant, btn('作成', run(e2, async () => { await api('/admins', { method: 'POST', body: { email: aemail.value, password: apw.value, role: arole.value, tenantId: arole.value === 'OPERATOR' ? undefined : atenant.value } }); render(); }), 'pri')), e2),
    el('div', { className: 'card' }, el('h2', {}, '標準項目マスタ'), el('div', { className: 'hint' }, `登録済み: ${master.map((m) => m.label).join('、')}`),
      el('div', { className: 'row', style: 'margin-top:8px' }, mk, ml, mt, ms), mp, mo, e3,
      el('div', { className: 'row', style: 'margin-top:8px' }, btn('標準項目を追加', run(e3, async () => {
        await api('/master', { method: 'POST', body: { key: mk.value.trim(), label: ml.value.trim(), field_type: mt.value, sensitivity: ms.value, purpose_text: mp.value, options: CHOICE.includes(mt.value) ? mo.value.split('\n').map((x) => x.trim()).filter(Boolean).map((v, i) => ({ value: v, label: v, order: i + 1 })) : [] } });
        render();
      }), 'pri'))),
    el('div', { className: 'card' }, el('h2', {}, '店舗が追加できない項目(禁止語)'), el('div', { className: 'hint' }, '項目名・説明・選択肢にこれらの語を含むカスタム項目は、店舗管理者が追加できません(医療・思想・金融などの高リスク情報)。1行に1語。'),
      bt, e4, o4, el('div', { className: 'row', style: 'margin-top:8px' }, btn('保存', run(e4, async () => { o4.textContent = ''; await api('/banned-terms', { method: 'PUT', body: { terms: bt.value.split('\n').map((x) => x.trim()).filter(Boolean) } }); o4.textContent = '保存しました'; }), 'pri')))));
}

// ---------- ルーティング ----------
const VIEWS = { form: formView, card: cardView, coupons: couponsView, members: membersView, scan: scanView, messages: messagesView, birthday: birthdayView, visitrules: visitRulesView, schedule: scheduleView, rank: rankView, line: lineView, urls: urlsView, audit: auditView, account: accountView, ops: opsView };
// 描画は1つずつ直列に実行し、実行中に再要求があれば終了後にもう一度だけ描き直す。
// (画面を素早く切り替えたとき、遅れて終わった前の画面が今の画面を上書きしないようにする)
let rendering = false, renderAgain = false, pollTimer = null;
async function doRender() {
  scanStop(); // 別タブへ移動したらカメラを止める
  clearInterval(pollTimer);
  if (!ST.me) return loginView();
  try { await VIEWS[ST.tab](); } catch (e) { if (ST.me) layout(el('div', { className: 'card err' }, errText(e))); }
}
async function render() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try { do { renderAgain = false; await doRender(); } while (renderAgain); } finally { rendering = false; }
}
async function boot() {
  ST.me = await api('/me');
  if (ST.me.role === 'OPERATOR') ST.tenants = (await api('/tenants')).tenants; else ST.tenant = ST.me.tenantId;
  render();
}
window.addEventListener('hashchange', () => { if (!ST.me) render(); });
window.addEventListener('beforeunload', (e) => { if (formDirty()) { e.preventDefault(); e.returnValue = ''; } }); // 未保存のまま閉じようとしたら確認
(store.get() && !location.hash.startsWith('#reset=')) ? boot().catch(() => { store.set(null); render(); }) : render();
