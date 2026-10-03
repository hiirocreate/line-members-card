// 管理画面 (SPA)。DOM は textContent / プロパティ代入のみで組み立て、HTML文字列は使わない。
import { el, buildForm, collect, control } from './formkit.js';

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
const errText = (e) => [e.message, ...(e.details ?? [])].join('\n');
const can = (p) => ST.me?.perms.includes(p);
const btn = (text, onclick, cls = '') => el('button', { className: `btn ${cls}`, type: 'button', onclick }, text);
const lab = (text, node, hint) => el('div', {}, el('label', { className: 'lb' }, text), node, hint ? el('div', { className: 'hint' }, hint) : null);
const run = (box, fn) => async (...a) => { try { box && (box.textContent = ''); await fn(...a); } catch (e) { if (box) { box.className = 'err'; box.textContent = errText(e); } else alert(errText(e)); } };

// ---------- ログイン ----------
function loginView() {
  if (location.hash.startsWith('#reset=')) return resetView(location.hash.slice('#reset='.length));
  const err = el('div', { className: 'err' });
  const email = el('input', { type: 'email', autocomplete: 'username' }), pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const code = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '6桁のコード または 回復コード' });
  const codeBox = lab('認証コード(二段階認証)', code, '認証アプリのコードを入力してください。'); codeBox.style.display = 'none';
  const go = run(err, async () => {
    const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value, code: code.value || undefined } });
    if (r.requires2fa) { codeBox.style.display = ''; code.focus(); err.textContent = ''; return; }
    store.set(r.token); await boot();
  });
  for (const i of [pw, code]) i.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  root.replaceChildren(el('div', { className: 'login card' }, el('h2', {}, '管理画面ログイン'), lab('メールアドレス', email), lab('パスワード', pw), codeBox, err,
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
const TABS = [['form', '会員登録フォーム'], ['members', '会員'], ['scan', '来店スキャン'], ['messages', 'メッセージ配信'], ['line', 'LINE連携'], ['urls', '登録URL'], ['audit', '監査ログ'], ['account', 'アカウント']];
function layout(content) {
  const tabs = [...TABS.filter(([k]) => (k === 'messages' ? can('MESSAGE_SEND') : k === 'line' ? can('LINE_SETTINGS') : true)), ...(ST.me.role === 'OPERATOR' ? [['ops', '運営']] : [])];
  const head = el('header', {}, el('h1', {}, '会員管理'), el('span', { className: 'hint' }, ST.me.tenantName ?? ''), el('span', { className: 'sp' }));
  if (ST.me.role === 'OPERATOR') {
    const sel = el('select', { style: 'width:auto', onchange: () => { ST.tenant = sel.value || null; render(); } }, el('option', { value: '' }, '店舗を選択'),
      ST.tenants.map((t) => el('option', { value: t.tenant_id, selected: t.tenant_id === ST.tenant }, `${t.name} (${t.tenant_id})`)));
    head.append(sel);
  }
  head.append(el('span', { className: 'hint' }, ST.me.role), btn('ログアウト', () => { store.set(null); ST.me = null; render(); }));
  root.replaceChildren(head, el('nav', {}, tabs.map(([k, t]) => el('button', { className: ST.tab === k ? 'on' : '', onclick: () => { ST.tab = k; render(); } }, t))), el('main', {}, content));
}

// ---------- フォーム設定 ----------
const visibleOpts = (f) => (f.options ?? []).filter((o) => !o.hidden).sort((a, b) => a.order - b.order);

function previewNode() {
  const fields = ST.fields.filter((f) => f.enabled && f.visibility === 'USER');
  const box = el('div', { className: 'phone' }, el('h3', {}, ST.me.tenantName ?? ST.tenant ?? '店舗'), el('div', { className: 'hint' }, '会員登録'));
  box.append(fields.length ? buildForm(fields, null, () => {}, '確認する') : el('div', { className: 'hint', style: 'margin-top:12px' }, '表示する項目がありません'));
  return box;
}

async function formView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const [{ fields }, { master }] = await Promise.all([api('/form'), api('/master')]);
  ST.fields = fields; ST.master = master;
  const canEdit = can('FORM_EDIT');
  const list = el('div');
  let dragId = null;
  fields.forEach((f) => {
    const row = el('div', { className: `field ${f.enabled ? '' : 'off'}`, draggable: canEdit });
    row.addEventListener('dragstart', () => { dragId = f.field_id; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag'));
    row.addEventListener('drop', run(null, async (e) => {
      e.preventDefault(); row.classList.remove('drag');
      if (!dragId || dragId === f.field_id) return;
      const ids = fields.map((x) => x.field_id).filter((i) => i !== dragId);
      ids.splice(ids.indexOf(f.field_id), 0, dragId);
      await api('/form/order', { method: 'PUT', body: { fieldIds: ids } }); render();
    }));
    const badges = el('div', {}, el('span', { className: 'badge' }, TYPES[f.field_type]), f.master_key ? el('span', { className: 'badge int' }, '標準') : el('span', { className: 'badge' }, 'カスタム'),
      f.visibility !== 'USER' ? el('span', { className: 'badge warn' }, VIS[f.visibility]) : null, !f.user_editable ? el('span', { className: 'badge' }, '店舗のみ変更可') : null,
      f.sensitivity !== 'NORMAL' ? el('span', { className: 'badge' }, f.sensitivity) : null);
    const req = el('input', { type: 'checkbox', checked: f.required, disabled: !canEdit || f.visibility !== 'USER', onchange: run(null, async () => { await api(`/form/fields/${f.field_id}`, { method: 'PATCH', body: { required: req.checked } }); render(); }) });
    row.append(el('span', { className: 'handle', title: 'ドラッグで並び替え' }, '☰'), el('div', { className: 'name' }, el('b', {}, f.field_name), badges),
      el('label', { className: 'hint' }, req, ' 必須'));
    if (canEdit) row.append(btn(f.enabled ? '表示中' : '非表示', run(null, async () => { await api(`/form/fields/${f.field_id}/${f.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); render(); }), 'sm'), btn('編集', () => fieldDialog(f), 'sm'));
    list.append(row);
  });
  const used = new Set(fields.filter((f) => f.enabled).map((f) => f.master_key));
  const tplSel = el('select', { style: 'width:auto' }, [['basic', '基本'], ['standard', '標準顧客情報'], ['marketing', '店舗マーケティング'], ['detailed', '詳細']].map(([v, t]) => el('option', { value: v }, t)));
  const bar = canEdit ? el('div', { className: 'row', style: 'margin-bottom:12px' },
    btn('＋ 標準項目を追加', () => masterDialog(master.filter((m) => !used.has(m.key))), 'pri'), btn('＋ カスタム項目を追加', () => fieldDialog(null)),
    el('span', { className: 'sp', style: 'flex:1' }), tplSel, btn('テンプレート適用', run(null, async () => { if (confirm('テンプレートの項目を追加します(既存項目は変更されません)。')) { await api('/form/template', { method: 'POST', body: { name: tplSel.value } }); render(); } }))) : null;
  layout(el('div', { className: 'grid' }, el('div', { className: 'card' }, el('h2', {}, '会員登録項目'), bar, list,
    el('div', { className: 'hint' }, '変更は保存ボタン不要で即時反映されます(変更履歴はバージョン管理・監査ログに記録)。項目は削除ではなく「非表示」にし、過去の会員データは保持されます。')),
    el('div', { className: 'card' }, el('h2', {}, 'スマホプレビュー'), previewNode())));
}

function masterDialog(list) {
  const sel = el('select', {}, list.map((m) => el('option', { value: m.key }, `${m.label} (${TYPES[m.field_type]})`)));
  const err = el('div', { className: 'err' });
  const d = el('dialog', {}, el('h2', {}, '標準項目を追加'), list.length ? lab('項目', sel) : el('div', {}, '追加できる標準項目はありません。'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('閉じる', () => d.close()),
      list.length ? btn('追加', run(err, async () => { await api('/form/fields', { method: 'POST', body: { masterKey: sel.value } }); d.close(); render(); }), 'pri') : null));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}

// 追加(f=null) / 編集(f) 共用
function fieldDialog(f) {
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
  const sync = () => { choiceBox.style.display = CHOICE.includes(type.value) ? '' : 'none'; consentBox.style.display = type.value === 'CHECKBOX' ? '' : 'none'; };
  type.addEventListener('change', sync); sync();
  const save = run(err, async () => {
    const lines = opts.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const common = { field_name: name.value.trim(), placeholder: ph.value, purpose_text: purpose.value, required: required.checked, user_editable: editable.checked, visibility: vis.value, allow_other: other.checked && CHOICE.includes(type.value) };
    if (isNew) await api('/form/fields', { method: 'POST', body: { field: { ...common, field_type: type.value, options: CHOICE.includes(type.value) ? lines : [], consent_target: type.value === 'CHECKBOX' && consent.value ? consent.value : null } } });
    else await api(`/form/fields/${f.field_id}`, { method: 'PATCH', body: { ...common, ...(CHOICE.includes(f.field_type) ? { options: lines } : {}), ...(f.field_type === 'CHECKBOX' ? { consent_target: consent.value || null } : {}) } });
    d.close(); render();
  });
  const d = el('dialog', {}, el('h2', {}, isNew ? 'カスタム項目を追加' : `項目を編集: ${f.field_name}`),
    lab('表示名', name, f && f.master_key ? '内部ID(field_id)は変わりません。表示名のみ変更されます。' : null), lab('入力形式', type), choiceBox, consentBox,
    lab('プレースホルダー', ph), lab('利用目的(会員に表示)', purpose), lab('表示範囲', vis),
    el('label', { className: 'lb' }, required, ' 必須'), el('label', { className: 'lb' }, editable, ' ユーザー自身が変更できる'), err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, btn('キャンセル', () => d.close()), btn('保存', save, 'pri')));
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
}

// ---------- 会員 ----------
const BUILTIN = [['days_since_last_visit', '最終来店からの日数', 'num'], ['visit_count', '来店回数', 'num'], ['registered_at', '登録日', 'date']];
const OPS = [['eq', '＝'], ['ne', '≠'], ['contains', '含む'], ['gte', '以上'], ['lte', '以下'], ['empty', '未登録'], ['notEmpty', '登録あり']];
let sortSel = { field: 'registered_at', dir: 'desc' };
const memberState = { conds: [], logic: 'AND', status: 'ACTIVE' };
const msgState = { conds: [], logic: 'AND' };

// 絞り込み条件エディタ (会員検索とメッセージ配信のセグメントで共用)。AND/OR を切り替えられる。
function condBuilder(state) {
  const fieldOpts = [...BUILTIN.map(([k, t]) => [k, t]), ...ST.fields.map((f) => [f.field_id, f.field_name])];
  const numeric = (k) => BUILTIN.find((b) => b[0] === k)?.[2] === 'num' || ST.fields.find((f) => f.field_id === k)?.field_type === 'NUMBER';
  const list = el('div');
  const draw = () => list.replaceChildren(...state.conds.map((c, i) => {
    const fs = el('select', { onchange: () => { c.field = fs.value; } }, fieldOpts.map(([k, t]) => el('option', { value: k, selected: k === c.field }, t)));
    const os = el('select', { onchange: () => { c.op = os.value; } }, OPS.map(([k, t]) => el('option', { value: k, selected: k === c.op }, t)));
    const v = el('input', { type: 'text', value: c.value ?? '', placeholder: '値', oninput: () => { c.value = v.value; } });
    return el('div', { className: 'cond' }, fs, os, v, btn('×', () => { state.conds.splice(i, 1); draw(); }, 'sm'));
  }));
  const logic = el('select', { style: 'width:auto', onchange: () => { state.logic = logic.value; } },
    [['AND', 'すべての条件に一致 (AND)'], ['OR', 'いずれかの条件に一致 (OR)']].map(([k, t]) => el('option', { value: k, selected: k === state.logic }, t)));
  draw();
  return {
    node: el('div', {}, list, el('div', { className: 'row' }, btn('＋ 条件を追加', () => { state.conds.push({ field: fieldOpts[0][0], op: 'eq', value: '' }); draw(); }), logic)),
    where: () => (state.conds.length ? { logic: state.logic, conditions: state.conds.map((c) => ({ field: c.field, op: c.op, value: ['empty', 'notEmpty'].includes(c.op) ? undefined : (numeric(c.field) ? Number(c.value) : c.value) })) } : undefined),
  };
}

async function membersView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields;
  const cb = condBuilder(memberState);
  const out = el('div'), err = el('div', { className: 'err' });
  const search = run(err, async () => {
    const r = await api('/members/search', { method: 'POST', body: { where: cb.where(), sort: sortSel, limit: 200, status: memberState.status } });
    out.replaceChildren(el('div', { className: 'hint' }, `${r.total}件`), el('table', {}, el('tr', {}, ['会員番号', '氏名', '電話番号', '登録日', '来店回数', '最終来店', '状態'].map((h) => el('th', {}, h))),
      r.members.map((m) => el('tr', { className: 'click', onclick: () => memberDialog(m.member_id) }, [m.member_number, m.name, m.phone, m.registered_at.slice(0, 10), m.visit_count, m.last_visit_at.slice(0, 10), m.status === 'WITHDRAWN' ? '退会済み' : '有効'].map((x) => el('td', {}, String(x ?? '')))))));
  });
  const sortS = el('select', { style: 'width:auto', onchange: () => { sortSel.field = sortS.value; } }, [['registered_at', '登録日'], ['visit_count', '来店回数'], ['last_visit_at', '最終来店'], ...ST.fields.map((f) => [f.field_id, f.field_name])].map(([k, t]) => el('option', { value: k, selected: k === sortSel.field }, t)));
  const dirS = el('select', { style: 'width:auto', onchange: () => { sortSel.dir = dirS.value; } }, [['desc', '降順'], ['asc', '昇順']].map(([k, t]) => el('option', { value: k, selected: k === sortSel.dir }, t)));
  const stS = el('select', { style: 'width:auto', onchange: () => { memberState.status = stS.value; } }, [['ACTIVE', '有効な会員'], ['WITHDRAWN', '退会済みの会員'], ['ALL', 'すべて']].map(([k, t]) => el('option', { value: k, selected: k === memberState.status }, t)));
  const cards = [el('div', { className: 'card' }, el('h2', {}, '絞り込み'), cb.node,
    el('div', { className: 'row', style: 'margin-top:8px' }, stS, el('span', { className: 'sp', style: 'flex:1' }), '並び順', sortS, dirS, btn('検索', search, 'pri')), err),
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
async function scanView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  const status = el('div', { style: 'font-size:16px;min-height:24px;margin:8px 0' }), video = el('video', { playsInline: true, muted: true, style: 'width:100%;max-width:420px;border-radius:10px;background:#000;display:none' });
  const list = el('div'), manual = el('input', { type: 'text', placeholder: '会員番号 (例: 000001)' });
  const loadList = async () => {
    const { visits } = await api('/visits');
    list.replaceChildren(el('table', {}, el('tr', {}, ['日時', '会員番号', '氏名', '方法'].map((h) => el('th', {}, h))),
      visits.map((v) => el('tr', {}, [v.visited_at.replace('T', ' ').slice(0, 16), v.member_number, v.name, v.method === 'QR' ? 'QR' : '手動'].map((x) => el('td', {}, x))))));
  };
  const submit = async (code) => {
    try { const r = await api('/visits/scan', { method: 'POST', body: { code } }); status.className = 'ok'; status.textContent = `✓ 会員 ${r.member_number} の来店を記録しました(${r.visit_count}回目)`; await loadList(); }
    catch (e) { status.className = 'err'; status.textContent = e.message; }
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
    status.className = 'hint'; status.textContent = '会員証のQRコードをカメラにかざしてください';
    (async function loop() {
      while (running) {
        try { const v = await detect(); if (v && v.startsWith('MC1.') && !(v === last && Date.now() - lastAt < 4000)) { last = v; lastAt = Date.now(); await submit(v); } } catch { /* 読み取り失敗は継続 */ }
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
        if (v.startsWith('MC1.')) await submit(v);
        else {
          const r = await api('/members/search', { method: 'POST', body: { where: { logic: 'AND', conditions: [{ field: 'member_number', op: 'eq', value: v }] }, limit: 2 } });
          if (r.members.length !== 1) throw new Error('その会員番号の有効な会員が見つかりません');
          const m = r.members[0]; const res = await api(`/members/${m.member_id}/visit`, { method: 'POST' });
          status.className = 'ok'; status.textContent = `✓ 会員 ${m.member_number} の来店を記録しました(手動)`; await loadList();
        }
        manual.value = '';
      })))),
    el('div', { className: 'card' }, el('h2', {}, '最近の来店'), list)));
  loadList();
}

// ---------- メッセージ配信 ----------
async function messagesView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields;
  const { messages } = await api('/messages');
  const cb = condBuilder(msgState);
  const text = el('textarea', { maxLength: 5000, style: 'min-height:140px', placeholder: '配信するメッセージ(テキスト)' });
  const count = el('div', { style: 'font-size:16px;margin:8px 0' }), err = el('div', { className: 'err' });
  let expected = null;
  const sendBtn = btn('送信', run(err, async () => {
    if (expected === null) throw new Error('先に「対象人数を確認」を押してください');
    if (!text.value.trim()) throw new Error('メッセージを入力してください');
    if (!confirm(`${expected}人にメッセージを送信します。取り消しはできません。よろしいですか？`)) return;
    const r = await api('/messages/send', { method: 'POST', body: { text: text.value, where: cb.where(), expectedCount: expected } });
    alert(`送信結果: ${r.status}(成功 ${r.sent}人 / 失敗 ${r.failed}人)${r.errors.length ? '\n' + r.errors.join('\n') : ''}`); render();
  }), 'pri');
  const preview = btn('対象人数を確認', run(err, async () => {
    const r = await api('/messages/preview', { method: 'POST', body: { where: cb.where() } });
    expected = r.audience; count.textContent = `配信対象: ${r.audience}人(条件に一致した有効会員 ${r.matched}人のうち、LINE配信に同意している会員)`;
  }));
  layout(el('div', {}, el('div', { className: 'card' }, el('h2', {}, 'LINEメッセージ配信'),
    el('div', { className: 'hint' }, '配信できるのは、有効な会員のうちLINE配信に同意した会員だけです(退会済み・未同意の会員には送られません)。送信にはLINE連携タブでチャネルアクセストークンの登録が必要です。'),
    lab('メッセージ', text), el('h2', { style: 'margin-top:16px' }, '配信先の絞り込み(任意)'), cb.node, count, err, el('div', { className: 'row' }, preview, sendBtn)),
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
  const save = run(err, async () => {
    ok.textContent = '';
    const body = { liffId: liff.value, loginChannelId: ch.value, shopcardUrl: shop.value }; if (tok.value) body.messagingToken = tok.value;
    await api('/line-settings', { method: 'PUT', body }); ok.textContent = '保存しました'; tok.value = '';
  });
  const test = run(err, async () => { ok.textContent = ''; const r = await api('/line-settings/test', { method: 'POST' }); ok.textContent = `接続OK: ${r.displayName} (${r.basicId ?? ''})`; });
  layout(el('div', { className: 'card' }, el('h2', {}, 'LINE連携設定'),
    el('div', { className: 'hint' }, '別法人の店舗では、店舗のLINE公式アカウントと同じプロバイダー内にLINEログインチャネル/LIFFを作成し、その値を設定してください(プロバイダーが異なるとメッセージ配信のユーザーIDが一致しません)。'),
    lab('LIFF ID(ミニアプリ)', liff, 'リッチメニューのURLに使われます。空欄なら共通設定を使用します。'), lab('LINEログインチャネルID', ch, '会員のLINEログイン(IDトークン)の検証に使われます。'),
    lab('メッセージ用 チャネルアクセストークン', tok, '暗号化して保存され、画面には表示されません。配信に使います。'),
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
  const cards = [pwCard, el('div', { className: 'card' }, el('h2', {}, `二段階認証(${sec.email})`), box)];
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
    el('div', { className: 'card' }, el('h2', {}, '店舗'), tenants.map((t) => el('div', { className: 'field' }, el('div', { className: 'name' }, el('b', {}, t.name), el('span', { className: 'hint' }, t.tenant_id)))),
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
const VIEWS = { form: formView, members: membersView, scan: scanView, messages: messagesView, line: lineView, urls: urlsView, audit: auditView, account: accountView, ops: opsView };
async function render() {
  scanStop(); // 別タブへ移動したらカメラを止める
  if (!ST.me) return loginView();
  try { await VIEWS[ST.tab](); } catch (e) { if (ST.me) layout(el('div', { className: 'card err' }, errText(e))); }
}
async function boot() {
  ST.me = await api('/me');
  if (ST.me.role === 'OPERATOR') ST.tenants = (await api('/tenants')).tenants; else ST.tenant = ST.me.tenantId;
  render();
}
window.addEventListener('hashchange', () => { if (!ST.me) render(); });
(store.get() && !location.hash.startsWith('#reset=')) ? boot().catch(() => { store.set(null); render(); }) : render();
