// HTTP サーバ: 会員向け(LIFF/ミニアプリ)API・管理API・静的ファイル。
// 店舗の特定: 会員側は URL 内 token (サーバ検証)、管理側はログインした管理者の tenant_id (リクエスト値は信用しない)。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SheetsStore } from './sheetsStore.js';
import { renderForm } from './render.js';
import { ValidationError } from './sanitize.js';
import { Forbidden } from './permissions.js';
import { login, verifySession, verifyLineIdToken, createAdmin, setAdminEnabled, bootstrapOperator, LoginLimiter } from './auth.js';
import { addMasterField, setBannedTerms, listMaster } from './master.js';
import { listAudit } from './audit.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC = { '/app': ['app.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const APP_CSP = "default-src 'none'; script-src 'self' https://static.line-scdn.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://*.line.me https://*.line-apps.com https://*.line-scdn.net; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'";

export function createServer(app, { lineChannelId = process.env.LINE_LOGIN_CHANNEL_ID, liffId = process.env.LIFF_ID,
  sessionSecret = process.env.SESSION_SECRET, verifyLine = verifyLineIdToken, fetchImpl = fetch } = {}) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET (32文字以上) が必要です');
  const limiter = new LoginLimiter();
  // 応答は即送らず保留し、永続化(flush)が終わってから返す
  const pending = new WeakMap();
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => pending.set(res, () => {
    res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  });
  const readBody = async (req) => {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 200_000) throw new ValidationError('リクエストが大きすぎます'); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new ValidationError('JSONが不正です'); }
  };
  const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

  async function publicApi(req, res, url, tenantToken, rest) {
    const tenantId = app.forms.resolveTenant(tenantToken);
    const form = app.forms.getUserForm(tenantId);
    const shop = app.store.find('tenants', (t) => t.tenant_id === tenantId).name;
    const strip = ({ tenant_id, ...f }) => f;
    if (req.method === 'GET' && !rest) return send(res, 200, renderForm({ shopName: shop, fields: form.fields }), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    if (req.method === 'GET' && rest === 'form') return send(res, 200, { shop, version: form.version, fields: form.fields.map(strip) });
    if (req.method === 'POST' && rest === 'confirm') return send(res, 200, app.members.confirmRegistration(tenantId, (await readBody(req)).values ?? {}));
    if (rest === 'register' || rest === 'me') {
      const userId = await verifyLine(bearer(req), lineChannelId, fetchImpl); // 本番は必ずLINEのIDトークンから userId を得る
      if (req.method === 'POST' && rest === 'register') {
        const body = await readBody(req);
        const m = app.members.register(tenantId, userId, body.values ?? {}, { confirmed: body.confirmed === true });
        return send(res, 201, { member_id: m.member_id, member_number: m.member_number });
      }
      const member = app.members.findByUser(tenantId, userId);
      if (req.method === 'GET' && rest === 'me') {
        if (!member) return send(res, 200, { registered: false });
        const p = app.members.profile(null, tenantId, member.member_id);
        return send(res, 200, { registered: true, shop, member_number: member.member_number, items: p.items.map(({ field_id, label, value, raw, registered }) => ({ field_id, label, value, raw, registered })),
          notice: p.notice, consents: p.consents });
      }
      if (req.method === 'PATCH' && rest === 'me') {
        if (!member) throw new ValidationError('会員登録がありません');
        app.members.updateByUser(tenantId, userId, (await readBody(req)).values ?? {});
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  async function adminApi(req, res, url, path) {
    if (req.method === 'POST' && path === '/login') {
      const b = await readBody(req);
      return send(res, 200, { token: login(app.store, { email: b.email, password: b.password, secret: sessionSecret, limiter, ip: req.socket.remoteAddress }) });
    }
    const actor = verifySession(app.store, bearer(req), sessionSecret);
    if (!actor) return send(res, 401, { error: '認証が必要です' });
    const isOp = actor.role === 'OPERATOR';
    // 店舗管理者/スタッフは自分の tenant_id に固定。運営のみ ?tenant= で対象店舗を指定できる。
    const tenant = isOp ? url.searchParams.get('tenant') : actor.tenantId;
    const needTenant = () => { if (!tenant) throw new ValidationError('tenant を指定してください'); return tenant; };
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const f = app.forms, mm = app.members;
    let m;
    const ok = (obj = { ok: true }, code = 200) => send(res, code, obj);

    // 運営管理者専用
    if (path === '/tenants' && req.method === 'POST') { const token = f.createTenant(actor, body.tenantId, body.name); return ok({ tenantId: body.tenantId, registrationToken: token }, 201); }
    if (path === '/admins' && req.method === 'POST') return ok(createAdmin(app.store, actor, body), 201);
    if ((m = /^\/admins\/([\w-]+)\/(enable|disable)$/.exec(path)) && req.method === 'POST') { setAdminEnabled(app.store, actor, m[1], m[2] === 'enable'); return ok(); }
    if (path === '/master' && req.method === 'POST') return ok(addMasterField(app.store, actor, body), 201);
    if (path === '/banned-terms' && req.method === 'PUT') { setBannedTerms(app.store, actor, body.terms ?? []); return ok(); }
    if ((m = /^\/form\/fields\/(\w+)$/.exec(path)) && req.method === 'DELETE') { f.hardDeleteField(actor, needTenant(), m[1]); return ok(); } // 完全削除(運営のみ)
    if ((m = /^\/form\/fields\/(\w+)\/sensitivity$/.exec(path)) && req.method === 'PUT') { f.setSensitivity(actor, needTenant(), m[1], body.sensitivity); return ok(); }

    // 登録フォーム設定
    if (path === '/master' && req.method === 'GET') return ok({ master: listMaster(app.store) });
    if (path === '/form' && req.method === 'GET') return ok({ fields: f.fields(needTenant(), { includeDisabled: true }), versions: f.versions(tenant).map(({ version, created_by, created_at }) => ({ version, created_by, created_at })) });
    if (path === '/form/preview' && req.method === 'GET') {
      const t = app.store.find('tenants', (x) => x.tenant_id === needTenant());
      return send(res, 200, renderForm({ shopName: t.name, fields: f.fields(tenant) }), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    }
    if (path === '/form/fields' && req.method === 'POST') {
      return ok(body.masterKey ? f.addFromMaster(actor, needTenant(), body.masterKey, body.overrides ?? {}) : f.addCustomField(actor, needTenant(), body.field ?? {}), 201);
    }
    if ((m = /^\/form\/fields\/(\w+)$/.exec(path)) && req.method === 'PATCH') return ok(f.updateField(actor, needTenant(), m[1], body));
    if ((m = /^\/form\/fields\/(\w+)\/(enable|disable)$/.exec(path)) && req.method === 'POST') return ok(f.setEnabled(actor, needTenant(), m[1], m[2] === 'enable'));
    if ((m = /^\/form\/fields\/(\w+)\/options\/order$/.exec(path)) && req.method === 'PUT') { f.reorderOptions(actor, needTenant(), m[1], body.values ?? []); return ok(); }
    if (path === '/form/order' && req.method === 'PUT') { f.reorder(actor, needTenant(), body.fieldIds ?? []); return ok(); }
    if (path === '/form/template' && req.method === 'POST') return ok({ added: f.applyTemplate(actor, needTenant(), body.name) });
    if (path === '/registration-url' && req.method === 'POST') { // 登録URL(リッチメニュー用)の発行
      const token = f.issueRegistrationUrl(actor, needTenant());
      return ok({ token, url: liffId ? `https://miniapp.line.me/${liffId}?t=${token}` : null }, 201);
    }
    if (path === '/registration-url' && req.method === 'GET') {
      const tokens = app.store.select('tenant_urls', (u) => u.tenant_id === needTenant() && u.enabled).map((u) => ({ token: u.token, url: liffId ? `https://miniapp.line.me/${liffId}?t=${u.token}` : null }));
      return ok({ urls: tokens });
    }
    if ((m = /^\/registration-url\/(\w+)$/.exec(path)) && req.method === 'DELETE') { // 無効化 (URL漏えい時)
      app.store.update('tenant_urls', (u) => u.token === m[1] && u.tenant_id === needTenant(), { enabled: false }); return ok();
    }

    // 会員
    if (path === '/members/search' && req.method === 'POST') { const r = mm.search(actor, needTenant(), body); return ok({ total: r.total, members: r.members }); }
    if ((m = /^\/members\/(\w+)$/.exec(path)) && req.method === 'GET') { const { member, items, notice, consents } = mm.profile(actor, needTenant(), m[1]); return ok({ member, items, notice, consents }); }
    if ((m = /^\/members\/(\w+)$/.exec(path)) && req.method === 'PATCH') { mm.updateByStaff(actor, needTenant(), m[1], body.values ?? {}); return ok(); }
    if ((m = /^\/members\/(\w+)\/visit$/.exec(path)) && req.method === 'POST') { mm.recordVisit(actor, needTenant(), m[1]); return ok(); }
    if (path === '/export' && req.method === 'POST') {
      const opts = { columns: body.columns ?? [], where: body.where, sort: body.sort };
      const stamp = new Date().toISOString().slice(0, 10);
      if (body.format === 'csv') return send(res, 200, mm.exportCsv(actor, needTenant(), opts), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="members-${stamp}.csv"` });
      return send(res, 200, mm.exportXlsx(actor, needTenant(), opts), XLSX, { 'content-disposition': `attachment; filename="members-${stamp}.xlsx"` });
    }
    if (path === '/audit' && req.method === 'GET') { if (!isOp && actor.role !== 'STORE_ADMIN') throw new Forbidden('権限がありません'); return ok({ logs: listAudit(app.store, needTenant()) }); }
    return send(res, 404, { error: 'not found' });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/app/config.json') return send(res, 200, { liffId: liffId ?? '' });
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, await readFile(PUBLIC_DIR + file), type, { 'content-security-policy': APP_CSP });
    }
    let m;
    if ((m = /^\/t\/([0-9a-f]{32})(?:\/([a-z]+))?$/.exec(p))) await publicApi(req, res, url, m[1], m[2]);
    else if (p.startsWith('/api/admin/')) await adminApi(req, res, url, p.slice('/api/admin'.length));
    else return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') await app.store.flush?.(); // Sheets への書き込み完了後に応答
  }

  return http.createServer(async (req, res) => {
    try { await route(req, res); } catch (e) {
      if (e instanceof ValidationError) send(res, 400, { error: e.message, details: e.details });
      else if (e instanceof Forbidden) send(res, 403, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'internal error' }); }
    }
    pending.get(res)?.();
  });
}
