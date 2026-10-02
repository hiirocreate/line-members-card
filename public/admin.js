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
  const err = el('div', { className: 'err' });
  const email = el('input', { type: 'email', autocomplete: 'username' }), pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const go = run(err, async () => { const { token } = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } }); store.set(token); await boot(); });
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  root.replaceChildren(el('div', { className: 'login card' }, el('h2', {}, '管理画面ログイン'), lab('メールアドレス', email), lab('パスワード', pw), err, el('div', { className: 'row', style: 'margin-top:12px' }, btn('ログイン', go, 'pri'))));
}

// ---------- 共通レイアウト ----------
const TABS = [['form', '会員登録フォーム'], ['members', '会員'], ['urls', '登録URL'], ['audit', '監査ログ']];
function layout(content) {
  const tabs = [...TABS, ...(ST.me.role === 'OPERATOR' ? [['ops', '運営']] : [])];
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
let conds = [], sortSel = { field: 'registered_at', dir: 'desc' };

async function membersView() {
  if (ST.me.role === 'OPERATOR' && !ST.tenant) return layout(el('div', { className: 'card' }, '上部で店舗を選択してください。'));
  ST.fields = (await api('/form')).fields;
  const fieldOpts = [...BUILTIN.map(([k, t]) => [k, t]), ...ST.fields.map((f) => [f.field_id, f.field_name])];
  const numeric = (k) => BUILTIN.find((b) => b[0] === k)?.[2] === 'num' || ST.fields.find((f) => f.field_id === k)?.field_type === 'NUMBER';
  const condBox = el('div'), out = el('div'), err = el('div', { className: 'err' });
  const drawConds = () => {
    condBox.replaceChildren(...conds.map((c, i) => {
      const fs = el('select', { onchange: () => { c.field = fs.value; } }, fieldOpts.map(([k, t]) => el('option', { value: k, selected: k === c.field }, t)));
      const os = el('select', { onchange: () => { c.op = os.value; } }, OPS.map(([k, t]) => el('option', { value: k, selected: k === c.op }, t)));
      const v = el('input', { type: 'text', value: c.value ?? '', placeholder: '値', oninput: () => { c.value = v.value; } });
      return el('div', { className: 'cond' }, fs, os, v, btn('×', () => { conds.splice(i, 1); drawConds(); }, 'sm'));
    }));
  };
  const where = () => ({ logic: 'AND', conditions: conds.map((c) => ({ field: c.field, op: c.op, value: ['empty', 'notEmpty'].includes(c.op) ? undefined : (numeric(c.field) ? Number(c.value) : c.value) })) });
  const search = run(err, async () => {
    const r = await api('/members/search', { method: 'POST', body: { where: conds.length ? where() : undefined, sort: sortSel, limit: 200 } });
    out.replaceChildren(el('div', { className: 'hint' }, `${r.total}件`), el('table', {}, el('tr', {}, ['会員番号', '氏名', '電話番号', '登録日', '来店回数', '最終来店'].map((h) => el('th', {}, h))),
      r.members.map((m) => el('tr', { className: 'click', onclick: () => memberDialog(m.member_id) }, [m.member_number, m.name, m.phone, m.registered_at.slice(0, 10), m.visit_count, m.last_visit_at.slice(0, 10)].map((x) => el('td', {}, String(x ?? '')))))));
  });
  const sortS = el('select', { style: 'width:auto', onchange: () => { sortSel.field = sortS.value; } }, [['registered_at', '登録日'], ['visit_count', '来店回数'], ['last_visit_at', '最終来店'], ...ST.fields.map((f) => [f.field_id, f.field_name])].map(([k, t]) => el('option', { value: k, selected: k === sortSel.field }, t)));
  const dirS = el('select', { style: 'width:auto', onchange: () => { sortSel.dir = dirS.value; } }, [['desc', '降順'], ['asc', '昇順']].map(([k, t]) => el('option', { value: k, selected: k === sortSel.dir }, t)));
  drawConds();
  const cards = [el('div', { className: 'card' }, el('h2', {}, '絞り込み(すべての条件に一致)'), condBox,
    el('div', { className: 'row' }, btn('＋ 条件を追加', () => { conds.push({ field: fieldOpts[0][0], op: 'eq', value: '' }); drawConds(); }), el('span', { className: 'sp', style: 'flex:1' }), '並び順', sortS, dirS, btn('検索', search, 'pri')), err),
    el('div', { className: 'card' }, out)];
  if (can('EXPORT_MEMBERS')) cards.push(exportCard(where, () => conds.length));
  layout(el('div', {}, cards));
  search();
}

function exportCard(where, hasConds) {
  const cols = [['member_number', '会員番号'], ['registered_at', '登録日'], ['status', 'ステータス'],
    ...(can('EXPORT_PERSONAL_DATA') ? [['user_id', 'LINEユーザーID']] : []), ...(can('EXPORT_VISITS') ? [['last_visit_at', '最終来店日'], ['visit_count', '来店回数']] : []),
    ...ST.fields.filter((f) => f.sensitivity === 'NORMAL' || can('EXPORT_PERSONAL_DATA')).map((f) => [f.field_id, f.field_name])];
  const checks = cols.map(([k, t]) => ({ k, t, cb: el('input', { type: 'checkbox', checked: ['member_number'].includes(k) || ST.fields.some((f) => f.field_id === k && f.enabled) }) }));
  const err = el('div', { className: 'err' });
  const fmt = el('select', { style: 'width:auto' }, el('option', { value: 'xlsx' }, 'Excel (.xlsx)'), el('option', { value: 'csv' }, 'CSV'));
  const go = run(err, async () => {
    const columns = checks.filter((c) => c.cb.checked).map((c) => c.k);
    if (!columns.length) throw new Error('出力する項目を選択してください');
    const blob = await api('/export', { method: 'POST', blob: true, body: { format: fmt.value, columns, where: hasConds() ? where() : undefined, sort: sortSel } });
    const a = el('a', { href: URL.createObjectURL(blob), download: `members-${new Date().toISOString().slice(0, 10)}.${fmt.value}` });
    document.body.append(a); a.click(); a.remove();
  });
  return el('div', { className: 'card' }, el('h2', {}, 'Excel出力'), el('div', { className: 'cols' }, checks.map((c) => el('label', {}, c.cb, ` ${c.t}`))),
    err, el('div', { className: 'row', style: 'margin-top:8px' }, fmt, btn('出力', go, 'pri'), el('span', { className: 'hint' }, '現在の絞り込み条件・並び順で出力します。個人情報を含むため取り扱いに注意してください。')));
}

async function memberDialog(id) {
  const p = await api(`/members/${id}`);
  const err = el('div', { className: 'err' });
  const editFields = ST.fields.filter((f) => f.enabled);
  const init = Object.fromEntries(p.items.map((i) => [i.field_id, i.raw]));
  const form = can('MEMBER_EDIT') ? buildForm(editFields, init, run(err, async (values) => { await api(`/members/${id}`, { method: 'PATCH', body: { values } }); d.close(); render(); }), '保存') : null;
  const dl = el('table', {}, p.items.map((i) => el('tr', {}, el('th', {}, i.label), el('td', { className: i.registered ? '' : 'hint' }, i.value))));
  const d = el('dialog', {}, el('h2', {}, `会員 ${p.member.member_number}`), p.notice ? el('div', { className: 'badge warn' }, `${p.notice}(未入力の必須項目あり)`) : null,
    el('div', { className: 'hint' }, `配信同意: LINE ${p.consents.LINE ? '○' : '×'} / メール ${p.consents.EMAIL ? '○' : '×'} / マーケティング ${p.consents.MARKETING ? '○' : '×'}`), dl,
    form ? el('h2', { style: 'margin-top:16px' }, '情報を編集') : null, form, err,
    el('div', { className: 'row', style: 'margin-top:16px;justify-content:flex-end' }, can('MEMBER_EDIT') ? btn('来店を記録', run(err, async () => { await api(`/members/${id}/visit`, { method: 'POST' }); d.close(); render(); })) : null, btn('閉じる', () => d.close())));
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

// ---------- 運営 ----------
async function opsView() {
  const [{ tenants }, { admins }] = await Promise.all([api('/tenants'), api('/admins')]);
  ST.tenants = tenants;
  const e1 = el('div', { className: 'err' }), e2 = el('div', { className: 'err' });
  const tid = el('input', { type: 'text', placeholder: '店舗ID (例: SHOP001)' }), tname = el('input', { type: 'text', placeholder: '店舗名' });
  const aemail = el('input', { type: 'email', placeholder: 'メールアドレス' }), apw = el('input', { type: 'password', placeholder: 'パスワード(10文字以上)', autocomplete: 'new-password' });
  const arole = el('select', {}, [['STORE_ADMIN', '店舗管理者'], ['STAFF', '店舗スタッフ'], ['OPERATOR', '運営管理者']].map(([k, t]) => el('option', { value: k }, t)));
  const atenant = el('select', {}, tenants.map((t) => el('option', { value: t.tenant_id }, `${t.name} (${t.tenant_id})`)));
  layout(el('div', {},
    el('div', { className: 'card' }, el('h2', {}, '店舗'), tenants.map((t) => el('div', { className: 'field' }, el('div', { className: 'name' }, el('b', {}, t.name), el('span', { className: 'hint' }, t.tenant_id)))),
      el('div', { className: 'row' }, tid, tname, btn('店舗を作成', run(e1, async () => { const r = await api('/tenants', { method: 'POST', body: { tenantId: tid.value.trim(), name: tname.value.trim() } }); alert(`作成しました。登録token: ${r.registrationToken}`); render(); }), 'pri')), e1),
    el('div', { className: 'card' }, el('h2', {}, '管理者アカウント'),
      el('table', {}, el('tr', {}, ['メール', 'ロール', '店舗', '状態', ''].map((h) => el('th', {}, h))),
        admins.map((a) => el('tr', {}, el('td', {}, a.email), el('td', {}, a.role), el('td', {}, a.tenant_id ?? '-'), el('td', {}, a.enabled ? '有効' : '無効'),
          el('td', {}, btn(a.enabled ? '無効化' : '有効化', run(e2, async () => { await api(`/admins/${a.admin_id}/${a.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); render(); }), 'sm'))))),
      el('div', { className: 'row', style: 'margin-top:12px' }, aemail, apw, arole, atenant, btn('作成', run(e2, async () => { await api('/admins', { method: 'POST', body: { email: aemail.value, password: apw.value, role: arole.value, tenantId: arole.value === 'OPERATOR' ? undefined : atenant.value } }); render(); }), 'pri')), e2)));
}

// ---------- ルーティング ----------
const VIEWS = { form: formView, members: membersView, urls: urlsView, audit: auditView, ops: opsView };
async function render() {
  if (!ST.me) return loginView();
  try { await VIEWS[ST.tab](); } catch (e) { if (ST.me) layout(el('div', { className: 'card err' }, errText(e))); }
}
async function boot() {
  ST.me = await api('/me');
  if (ST.me.role === 'OPERATOR') ST.tenants = (await api('/tenants')).tenants; else ST.tenant = ST.me.tenantId;
  render();
}
store.get() ? boot().catch(() => { store.set(null); render(); }) : render();
