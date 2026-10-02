// 会員向け公開API (動的フォーム)。店舗はURL内tokenで特定し、サーバ側で有効性を検証する。
// 注意: userId は本番では LINE ID トークン(LIFF)を検証して得ること。ここでは検証フックのみ。
import http from 'node:http';
import { createApp } from './app.js';
import { renderForm } from './render.js';
import { ValidationError } from './sanitize.js';

export function createServer(app, { verifyUser = (req, body) => body.userId } = {}) {
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  return http.createServer(async (req, res) => {
    try {
      const m = /^\/t\/([0-9a-f]{32})(\/[a-z]+)?$/.exec(new URL(req.url, 'http://x').pathname);
      if (!m) return json(res, 404, { error: 'not found' });
      const tenantId = app.forms.resolveTenant(m[1]);
      const form = app.forms.getUserForm(tenantId);
      const shop = app.store.find('tenants', (t) => t.tenant_id === tenantId).name;
      if (req.method === 'GET' && !m[2]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" }); return res.end(renderForm({ shopName: shop, fields: form.fields })); }
      if (req.method === 'GET' && m[2] === '/form') return json(res, 200, { shop, version: form.version, fields: form.fields.map(({ tenant_id, ...f }) => f) });
      if (req.method === 'POST' && ['/confirm', '/register'].includes(m[2])) {
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 100_000) throw new ValidationError('too large'); }
        const body = JSON.parse(raw || '{}');
        if (m[2] === '/confirm') return json(res, 200, app.members.confirmRegistration(tenantId, body.values ?? {}));
        const userId = verifyUser(req, body);
        const member = app.members.register(tenantId, userId, body.values ?? {}, { confirmed: body.confirmed === true });
        return json(res, 201, { member_id: member.member_id, member_number: member.member_number });
      }
      json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (e instanceof ValidationError) return json(res, 400, { error: e.message, details: e.details });
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid json' });
      console.error(e); json(res, 500, { error: 'internal error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(process.env.DATA_FILE ?? null);
  createServer(app).listen(process.env.PORT ?? 3000);
}
