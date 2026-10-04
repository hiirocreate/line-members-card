import { timingSafeEqual } from 'node:crypto';
import { OPS_HELP } from './opshelp.js';
import { FEATURES, featureOn, featureMap, setFeatures, featureForPath } from './features.js';
// HTTP サーバ: 会員向け(LIFF/ミニアプリ)API・管理API・静的ファイル。
// 店舗の特定: 会員側は URL 内 token (サーバ検証)、管理側はログインした管理者の tenant_id (リクエスト値は信用しない)。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SheetsStore } from './sheetsStore.js';
import { renderForm } from './render.js';
import { ValidationError, AuthError, FriendRequiredError } from './sanitize.js';
import { Forbidden, PERMS, can, require_ } from './permissions.js';
import { login, verifySession, renewSession, issueTempPassword, setUserPassword, verifyLineIdToken, createAdmin, setAdminEnabled, LoginLimiter, changePassword, setup2fa, enable2fa, disable2fa, resetTwoFactor, issueResetToken, consumeResetToken, listAdmins, listPasskeys, beginPasskeyRegistration, finishPasskeyRegistration, deletePasskey, sendLineCode, startLineLink, readLineLink, completeLineLink, unlinkLine, lineLinked } from './auth.js';
import { push, isFriend, friendAddUrl, botInfo } from './line.js';
import { resolveLine, publicLine, setLine, testMessaging } from './settings.js';
import { addMasterField, setBannedTerms, listMaster, getBannedTerms } from './master.js';
import { listAudit } from './audit.js';
import { TEMPLATES, INTEREST_FIELD } from './templates.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const JS = 'text/javascript; charset=utf-8';
const STATIC = { '/app': ['app.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', JS], '/formkit.js': ['formkit.js', JS],
  '/admin': ['admin.html', 'text/html; charset=utf-8'], '/admin.js': ['admin.js', JS], '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/cardkit.js': ['cardkit.js', JS], '/vendor/qrcode.min.js': ['vendor/qrcode.min.js', JS], '/vendor/jsQR.js': ['vendor/jsQR.js', JS] };
const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const APP_CSP = "default-src 'none'; script-src 'self' https://static.line-scdn.net; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://*.line.me https://*.line-apps.com https://*.line-scdn.net; img-src 'self' data: blob: https:; frame-ancestors 'self'; base-uri 'none'";

export function createServer(app, { lineChannelId = process.env.LINE_LOGIN_CHANNEL_ID, liffId = process.env.LIFF_ID,
  sessionSecret = process.env.SESSION_SECRET, publicOrigin = process.env.PUBLIC_ORIGIN, systemMessagingToken = process.env.LINE_SYSTEM_MESSAGING_TOKEN, verifyLine = verifyLineIdToken, cronSecret = process.env.CRON_SECRET, fetchImpl = app.fetchImpl ?? fetch } = {}) {
  const defaults = { liffId, loginChannelId: lineChannelId }; // 店舗が個別設定していない場合の既定値
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET (32文字以上) が必要です');
  const limiter = new LoginLimiter();
  // LINEでコードを受け取る二段階認証: 店舗の管理者は「店舗のLINE設定」、運営者は「共通(システム)の公式アカウント」で送る
  const adminLine = (a) => (a.tenant_id ? resolveLine(app.store, app.vault, a.tenant_id, defaults)
    : { liffId: defaults.liffId, loginChannelId: defaults.loginChannelId, messagingToken: systemMessagingToken || null });
  const lineAvailable = (a) => { try { return !!adminLine(a).messagingToken; } catch { return false; } };
  const sendToAdmin = async (a, text) => {
    const t = adminLine(a).messagingToken;
    if (!t) throw new ValidationError('LINEの送信設定がありません(管理画面の「LINE連携」でチャネルアクセストークンを登録してください)');
    await push(t, a.line_user_id, [{ type: 'text', text }], fetchImpl);
  };
  // パスキーの rpId / origin。PUBLIC_ORIGIN があればそれに固定、無ければアクセスされたホストから決める。
  // (rpId が違うと別のパスキーとして扱われるため、管理画面は常に同じURLで開くこと)
  const waOf = (req) => {
    if (publicOrigin) { const u = new URL(publicOrigin); return { origin: u.origin, rpId: u.hostname }; }
    const host = String(req.headers.host ?? '');
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return { origin: `${local ? 'http' : 'https'}://${host}`, rpId: host.replace(/:\d+$/, '') };
  };
  // 友だち追加の確認 (会員登録の条件)。店舗の設定が有効なとき、LINEのサーバーに問い合わせて確かめる(端末の申告は信用しない)。
  const basicIds = new Map(); // tenantId -> { id, at } (友だち追加URLの生成用。1時間キャッシュ)
  async function friendStatus(tenantId, userId) {
    const cfg = resolveLine(app.store, app.vault, tenantId, defaults);
    if (!cfg.requireFriend) return { required: false, friend: true };
    if (!cfg.messagingToken) throw new ValidationError('友だち追加の確認ができません(店舗の設定を確認してください)');
    const friend = await isFriend(cfg.messagingToken, userId, fetchImpl);
    let addUrl = cfg.friendUrl || null;
    if (!friend && !addUrl) {
      let c = basicIds.get(tenantId);
      if (!c || Date.now() - c.at > 3600_000) { try { c = { id: (await botInfo(cfg.messagingToken, fetchImpl)).basicId, at: Date.now() }; basicIds.set(tenantId, c); } catch { c = null; } }
      addUrl = friendAddUrl(c?.id);
    }
    return { required: true, friend, addUrl: friend ? null : addUrl };
  }
  // クーポン配信のリンク: 店舗のLIFF + 登録URLのtoken + クーポンID
  app.messaging.couponUrl = (actor, tenantId, couponId) => {
    const l = resolveLine(app.store, app.vault, tenantId, defaults);
    if (!l.liffId) return null;
    const tok = app.store.find('tenant_urls', (u) => u.tenant_id === tenantId && u.enabled)?.token ?? app.forms.issueRegistrationUrl(actor, tenantId);
    return `https://liff.line.me/${l.liffId}?t=${tok}&coupon=${couponId}`;
  };

  // 店舗のQRの中身: 会員が自分のスマホのカメラで読み取ると、LINEでミニアプリが開き、来店が記録される
  app.messaging.visitUrl = (actor, tenantId, code) => {
    const l = resolveLine(app.store, app.vault, tenantId, defaults);
    if (!l.liffId) return null;
    const tok = app.store.find('tenant_urls', (u) => u.tenant_id === tenantId && u.enabled)?.token ?? app.forms.issueRegistrationUrl(actor, tenantId);
    return `https://liff.line.me/${l.liffId}?t=${tok}&visit=${code}`;
  };
  app.birthday.couponUrl = app.visitRules.couponUrl = app.messaging.couponUrl;

  // 会員に見せるデザイン: 運営が「カードの裏面にQR」をオフにした店舗では、通常の表示(カードの下)に戻す
  const memberDesign = (tenantId) => { const d = app.card.get(tenantId).design; return d.qr === 'flip' && !featureOn(app.store, tenantId, 'qrflip') ? { ...d, qr: 'below' } : d; };

  // 応答は即送らず保留し、永続化(flush)が終わってから返す
  const pending = new WeakMap();
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => pending.set(res, () => {
    res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  });
  const readBody = async (req, max = 200_000) => {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > max) throw new ValidationError('リクエストが大きすぎます'); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new ValidationError('JSONが不正です'); }
  };
  const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

  async function publicApi(req, res, url, tenantToken, rest, arg, sub) {
    const tenantId = app.forms.resolveTenant(tenantToken);
    const form = app.forms.getUserForm(tenantId);
    const shop = app.store.find('tenants', (t) => t.tenant_id === tenantId).name;
    const strip = ({ tenant_id, ...f }) => f;
    const line = resolveLine(app.store, app.vault, tenantId, defaults);
    if (req.method === 'GET' && !rest) return send(res, 200, renderForm({ shopName: shop, fields: form.fields }), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    if (req.method === 'GET' && rest === 'asset' && arg) { // 会員証の画像 (IDは推測不能・内容は不変なので長期キャッシュ)
      const a = app.card.getAsset(tenantId, arg);
      if (!a) return send(res, 404, { error: 'not found' });
      return send(res, 200, a.buffer, a.mime, { 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'" });
    }
    if (req.method === 'GET' && rest === 'form') return send(res, 200, { shop, version: form.version, fields: form.fields.map(strip) });
    if (req.method === 'POST' && rest === 'confirm') return send(res, 200, app.members.confirmRegistration(tenantId, (await readBody(req)).values ?? {}));
    if (['register', 'me', 'qr', 'withdraw', 'consent', 'prefs', 'visit', 'friend', 'coupons', 'coupon'].includes(rest)) {
      const userId = await verifyLine(bearer(req), line.loginChannelId, fetchImpl); // 必ずLINEのIDトークンから userId を得る(店舗ごとのチャネルで検証)
      if (req.method === 'GET' && rest === 'friend') return send(res, 200, await friendStatus(tenantId, userId)); // 登録前の確認(画面の案内用)
      if (req.method === 'POST' && rest === 'register') {
        const body = await readBody(req);
        const fs = await friendStatus(tenantId, userId); // 登録の条件(サーバー側で必ず確認)
        if (fs.required && !fs.friend) throw new FriendRequiredError(fs.addUrl);
        const m = app.members.register(tenantId, userId, body.values ?? {}, { confirmed: body.confirmed === true });
        return send(res, 201, { member_id: m.member_id, member_number: m.member_number });
      }
      const member = app.members.findByUser(tenantId, userId);
      if (req.method === 'GET' && rest === 'me') {
        if (!member) return send(res, 200, { registered: false, shop });
        if (member.status === 'WITHDRAWN') return send(res, 200, { registered: false, withdrawn: true, shop });
        const p = app.members.profile(null, tenantId, member.member_id);
        const rank = featureOn(app.store, tenantId, 'rank') ? app.ranks.forVisits(tenantId, member.visit_count, member.last_visit_at) : null;
        return send(res, 200, { registered: true, shop, member_number: member.member_number, shopcardUrl: line.shopcardUrl || null,
          last_visit_at: member.last_visit_at || null, visit_count: Number(member.visit_count) || 0, registered_at: member.registered_at || null, items: p.items.map(({ field_id, label, value, raw, registered }) => ({ field_id, label, value, raw, registered })),
          notice: p.notice, consents: p.consents,
          scan_mode: app.members.scanMode(tenantId), card: memberDesign(tenantId), prefs: app.members.prefsOf(member), rank, card_data: { name: app.members.cardName(tenantId, member), parts: app.members.cardNameParts(tenantId, member), reading: app.members.cardReading(tenantId, member), member_number: member.member_number, registered_at: member.registered_at || null } });
      }
      if (req.method === 'GET' && rest === 'qr') return send(res, 200, app.members.issueVisitCode(tenantId, userId));
      if (rest === 'coupons' || rest === 'coupon') { // クーポン (会員本人・有効な会員のみ)
        if (!featureOn(app.store, tenantId, 'coupons')) return send(res, 403, { error: 'クーポンはご利用できません' });
        const mem = app.members.findByUser(tenantId, userId);
        if (!mem || mem.status === 'WITHDRAWN') throw new ValidationError('会員登録が必要です');
        if (req.method === 'GET' && rest === 'coupons') return send(res, 200, { coupons: app.coupons.memberList(tenantId, mem.member_id) });
        if (req.method === 'GET' && rest === 'coupon' && arg && !sub) return send(res, 200, app.coupons.memberCoupon(tenantId, mem.member_id, arg));
        if (req.method === 'POST' && rest === 'coupon' && arg && sub === 'code') return send(res, 200, app.coupons.issueRedeemCode(tenantId, mem.member_id, arg));
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST' && rest === 'consent') {
        const b = await readBody(req);
        app.members.setConsentByUser(tenantId, userId, b.channel, b.granted);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && rest === 'visit') { // 店舗のQRを読み取って来店を記録 (STORE_QR方式の店舗のみ)
        if (!featureOn(app.store, tenantId, 'scan')) return send(res, 403, { error: 'この機能はご利用できません' });
        const r = app.members.visitByStoreCode(tenantId, userId, (await readBody(req)).code);
        return send(res, 200, { visit_count: r.visit_count, rewards: await app.visitRules.onVisit(tenantId, r.member_id) });
      }
      if (req.method === 'POST' && rest === 'prefs') return send(res, 200, { prefs: app.members.setPrefsByUser(tenantId, userId, await readBody(req)) });
      if (req.method === 'POST' && rest === 'withdraw') {
        app.members.withdrawByUser(tenantId, userId, (await readBody(req)).reason);
        return send(res, 200, { ok: true });
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
      return send(res, 200, login(app.store, { email: b.email, password: b.password, code: b.code, lineCode: b.lineCode, lineAvailable, assertion: b.assertion, challenge: b.challenge, webauthn: waOf(req), secret: sessionSecret, remember: b.remember === true, limiter, ip: req.socket.remoteAddress, vault: app.vault }));
    }
    if (req.method === 'POST' && path === '/login/line-code') { // パスワード確認のうえ、連携済みのLINEへ6桁のコードを送る
      const b = await readBody(req);
      await sendLineCode(app.store, { email: b.email, password: b.password, limiter, ip: req.socket.remoteAddress, send: sendToAdmin, lineAvailable });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/line-link/complete') { // スマホのLINE(ミニアプリ画面)から呼ばれる。リンク+LINEのIDトークンで本人確認
      const b = await readBody(req);
      return send(res, 200, await completeLineLink(app.store, app.vault, { link: b.link, idToken: b.idToken, verifyLine: (tok, ch) => verifyLine(tok, ch, fetchImpl), channelIdFor: (a) => adminLine(a).loginChannelId, send: sendToAdmin }));
    }
    if (req.method === 'POST' && path === '/password-reset/consume') { // 再設定リンク(1回限り)からの新パスワード設定
      const b = await readBody(req);
      consumeResetToken(app.store, { token: b.token, password: b.password });
      return send(res, 200, { ok: true });
    }
    const actor = verifySession(app.store, bearer(req), sessionSecret);
    if (!actor) return send(res, 401, { error: '認証が必要です' });
    const isOp = actor.role === 'OPERATOR';
    // 店舗管理者/スタッフは自分の tenant_id に固定。運営のみ ?tenant= で対象店舗を指定できる。
    const tenant = isOp ? url.searchParams.get('tenant') : actor.tenantId;
    const needTenant = () => { if (!tenant) throw new ValidationError('tenant を指定してください'); return tenant; };
    const fk = featureForPath(path); // 運営が店舗ごとにオフにした機能は、その店舗の管理者・スタッフには使わせない
    if (fk && !isOp && !featureOn(app.store, actor.tenantId, fk)) throw new Forbidden('この機能は、ご契約の範囲に含まれていません');
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req, path === '/card/assets' ? 700_000 : 200_000) : {};
    const f = app.forms, mm = app.members;
    let m;
    const ok = (obj = { ok: true }, code = 200) => send(res, code, obj);
    const miniUrl = (tid, token) => { const id = resolveLine(app.store, app.vault, tid, defaults).liffId; return id ? `https://liff.line.me/${id}?t=${token}` : null; };

    // 仮パスワードでログインした直後は、パスワードを変更するまで他の操作はできない
    if (actor.mustChange && !(path === '/me' || path === '/security/password')) return send(res, 403, { error: '先にパスワードを変更してください', code: 'must_change' });
    if (path === '/me' && req.method === 'GET') {
      const t = actor.tenantId && app.store.find('tenants', (x) => x.tenant_id === actor.tenantId);
      return send(res, 200, { id: actor.id, role: actor.role, tenantId: actor.tenantId, tenantName: t?.name ?? null, perms: PERMS.filter((x) => can(actor, x)), mustChange: !!actor.mustChange, renew: renewSession(app.store, bearer(req), sessionSecret), features: isOp || !actor.tenantId ? featureMap(app.store, null) : featureMap(app.store, actor.tenantId) });
    }
    if (isOp && path === '/tenants' && req.method === 'GET') return ok({ tenants: app.store.select('tenants').map(({ tenant_id, name, status }) => ({ tenant_id, name, status, features: featureMap(app.store, tenant_id) })) });
    if (path === '/admins' && req.method === 'GET') return ok({ admins: listAdmins(app.store, actor) });
    if ((m = /^\/admins\/([\w-]+)\/reset-2fa$/.exec(path)) && req.method === 'POST') { resetTwoFactor(app.store, actor, m[1]); return ok(); }
    if ((m = /^\/admins\/([\w-]+)\/temp-password$/.exec(path)) && req.method === 'POST') return ok(issueTempPassword(app.store, actor, m[1]), 201);
    if ((m = /^\/admins\/([\w-]+)\/password$/.exec(path)) && req.method === 'PUT') { setUserPassword(app.store, actor, m[1], { password: body.password }); return ok(); }
    if ((m = /^\/admins\/([\w-]+)\/reset-link$/.exec(path)) && req.method === 'POST') { const r = issueResetToken(app.store, actor, m[1]); return ok({ ...r, path: `/admin#reset=${r.token}` }, 201); }

    // 自分のアカウント: パスワード変更 / 二段階認証
    if (path === '/security' && req.method === 'GET') return ok({ email: actor.email, totp: actor.totp, passkeys: listPasskeys(app.store, actor), line: { linked: lineLinked(app.store, actor), available: lineAvailable(app.store.find('admins', (x) => x.admin_id === actor.id)) } });
    if (path === '/security/line/start' && req.method === 'POST') {
      const a = app.store.find('admins', (x) => x.admin_id === actor.id), l = adminLine(a);
      if (!l.messagingToken) throw new ValidationError(a.tenant_id ? '先に「LINE連携」タブでメッセージ用チャネルアクセストークンを登録してください' : 'システムのLINE送信設定(LINE_SYSTEM_MESSAGING_TOKEN)がありません');
      if (!l.liffId) throw new ValidationError('LIFF IDが未設定です(「LINE連携」タブで設定してください)');
      const r = startLineLink(app.vault, actor);
      return ok({ url: `https://liff.line.me/${l.liffId}?link=${r.token}`, expiresAt: r.expiresAt });
    }
    if (path === '/security/line/unlink' && req.method === 'POST') { unlinkLine(app.store, actor, { password: body.password }); return ok(); }
    if (path === '/security/passkeys/options' && req.method === 'POST') return ok(beginPasskeyRegistration(app.store, app.vault, actor, { password: body.password, rpId: waOf(req).rpId }));
    if (path === '/security/passkeys/register' && req.method === 'POST') return ok(finishPasskeyRegistration(app.store, app.vault, actor, { token: body.token, credential: body.credential, name: body.name, ...waOf(req) }), 201);
    if (path === '/security/passkeys/delete' && req.method === 'POST') { deletePasskey(app.store, actor, { id: body.id, password: body.password }); return ok(); }
    if (path === '/security/password' && req.method === 'POST') return ok({ token: changePassword(app.store, actor, { current: body.current, next: body.next, secret: sessionSecret }) });
    if (path === '/security/2fa/setup' && req.method === 'POST') return ok(setup2fa(app.store, app.vault, actor, body));
    if (path === '/security/2fa/enable' && req.method === 'POST') return ok(enable2fa(app.store, app.vault, actor, body));
    if (path === '/security/2fa/disable' && req.method === 'POST') { disable2fa(app.store, app.vault, actor, body); return ok(); }

    // 運営管理者専用
    if (path === '/tenants' && req.method === 'POST') { const token = f.createTenant(actor, body.tenantId, body.name); return ok({ tenantId: body.tenantId, registrationToken: token }, 201); }
    if (path === '/admins' && req.method === 'POST') return ok(createAdmin(app.store, actor, body), 201);
    if ((m = /^\/admins\/([\w-]+)\/(enable|disable)$/.exec(path)) && req.method === 'POST') { setAdminEnabled(app.store, actor, m[1], m[2] === 'enable'); return ok(); }
    if (path === '/master' && req.method === 'POST') return ok(addMasterField(app.store, actor, body), 201);
    if (path === '/banned-terms' && req.method === 'GET') { require_(actor, 'POLICY_EDIT', actor.tenantId); return ok({ terms: getBannedTerms(app.store) }); }
    if (path === '/banned-terms' && req.method === 'PUT') { setBannedTerms(app.store, actor, body.terms ?? []); return ok(); }
    if ((m = /^\/form\/fields\/(\w+)$/.exec(path)) && req.method === 'DELETE') { f.hardDeleteField(actor, needTenant(), m[1]); return ok(); } // 完全削除(運営のみ)
    if ((m = /^\/form\/fields\/(\w+)\/sensitivity$/.exec(path)) && req.method === 'PUT') { f.setSensitivity(actor, needTenant(), m[1], body.sensitivity); return ok(); }

    // 登録フォーム設定
    if (path === '/master' && req.method === 'GET') return ok({ master: listMaster(app.store) });
    if (path === '/form' && req.method === 'PUT') return ok(f.applyBatch(actor, needTenant(), body)); // 下書きの一括保存(全部成功 or 全部取り消し)
    if (path === '/form' && req.method === 'GET') return ok({ version: f.version(needTenant()), templates: TEMPLATES, interest: INTEREST_FIELD, fields: f.fields(tenant, { includeDisabled: true }), versions: f.versions(tenant).map(({ version, created_by, created_at }) => ({ version, created_by, created_at })) });
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
      return ok({ token, url: miniUrl(tenant, token) }, 201);
    }
    if (path === '/registration-url' && req.method === 'GET') {
      const tokens = app.store.select('tenant_urls', (u) => u.tenant_id === needTenant() && u.enabled).map((u) => ({ token: u.token, url: miniUrl(tenant, u.token) }));
      return ok({ urls: tokens });
    }
    if ((m = /^\/registration-url\/(\w+)$/.exec(path)) && req.method === 'DELETE') { // 無効化 (URL漏えい時)
      app.store.update('tenant_urls', (u) => u.token === m[1] && u.tenant_id === needTenant(), { enabled: false }); return ok();
    }

    // クーポン (作成・編集・終了)。使用は、QR読み取り(来店スキャン)か会員番号で、スタッフも行える
    if (path === '/coupons' && req.method === 'GET') return ok({ coupons: app.coupons.list(actor, needTenant()) });
    if (path === '/coupons/active' && req.method === 'GET') return ok({ coupons: app.coupons.active(actor, needTenant()) });
    if (path === '/coupons' && req.method === 'POST') return ok(app.coupons.create(actor, needTenant(), body), 201);
    if (path === '/coupons/redeem' && req.method === 'POST') return ok(body.code ? app.coupons.redeemByCode(actor, needTenant(), body.code) : app.coupons.redeemManual(actor, needTenant(), body));
    if ((m = /^\/coupons\/([0-9a-f]{32})$/.exec(path)) && req.method === 'PUT') return ok(app.coupons.update(actor, needTenant(), m[1], body));
    if ((m = /^\/coupons\/([0-9a-f]{32})\/(archive|restore)$/.exec(path)) && req.method === 'POST') { app.coupons.setStatus(actor, needTenant(), m[1], m[2] === 'archive' ? 'ARCHIVED' : 'ACTIVE'); return ok(); }

    // 会員証デザイン (カード面・会員画面のテーマ・画像)
    if (path === '/card' && req.method === 'GET') { require_(actor, 'CARD_DESIGN', needTenant()); return ok({ ...app.card.get(tenant), assets: app.card.assets(tenant), tenantName: app.store.find('tenants', (x) => x.tenant_id === tenant)?.name ?? '' }); }
    if (path === '/card' && req.method === 'PUT') { const t = needTenant(); if (body.design?.qr === 'flip' && !featureOn(app.store, t, 'qrflip')) throw new ValidationError('「カードの裏面にQR」は、この店舗ではご利用できません'); return ok(app.card.save(actor, t, body.design)); }
    if (path === '/card/assets' && req.method === 'POST') return ok(app.card.addAsset(actor, needTenant(), body), 201);
    if ((m = /^\/card\/assets\/([0-9a-f]{32})$/.exec(path)) && req.method === 'GET') {
      require_(actor, 'CARD_DESIGN', needTenant());
      const a = app.card.getAsset(tenant, m[1]);
      return a ? send(res, 200, a.buffer, a.mime, { 'content-security-policy': "default-src 'none'" }) : send(res, 404, { error: 'not found' });
    }
    if ((m = /^\/card\/assets\/([0-9a-f]{32})$/.exec(path)) && req.method === 'DELETE') { app.card.deleteAsset(actor, needTenant(), m[1]); return ok(); }

    // LINE連携設定 (店舗ごと。秘密は書き込み専用)
    if (path === '/line-settings' && req.method === 'GET') { require_(actor, 'LINE_SETTINGS', needTenant()); return ok(publicLine(app.store, app.vault, tenant, defaults)); }
    if (path === '/line-settings' && req.method === 'PUT') { setLine(app.store, app.vault, actor, needTenant(), body); return ok(publicLine(app.store, app.vault, tenant, defaults)); }
    if (path === '/line-settings/test' && req.method === 'POST') return ok(await testMessaging(app.store, app.vault, actor, needTenant(), fetchImpl));

    // メッセージ配信 (LINE配信に同意した有効会員のみ)
    if (path === '/messages/preview' && req.method === 'POST') return ok(app.messaging.preview(actor, needTenant(), body.where, body.couponId));
    if (path === '/messages/send' && req.method === 'POST') return ok(await app.messaging.send(actor, needTenant(), body), 201);
    if (path === '/schedules' && req.method === 'GET') return ok({ schedules: app.schedules.list(actor, needTenant()) });
    if (path === '/schedules' && req.method === 'POST') return ok(app.schedules.create(actor, needTenant(), body), 201);
    if ((m = /^\/schedules\/([0-9a-f]{32})$/.exec(path)) && req.method === 'PUT') return ok(app.schedules.update(actor, needTenant(), m[1], body));
    if ((m = /^\/schedules\/([0-9a-f]{32})$/.exec(path)) && req.method === 'DELETE') { app.schedules.remove(actor, needTenant(), m[1]); return ok(); }
    if ((m = /^\/schedules\/([0-9a-f]{32})\/run$/.exec(path)) && req.method === 'POST') return ok(await app.schedules.runNow(actor, needTenant(), m[1]));
    if (path === '/ranks/titles' && req.method === 'GET') return ok({ titles: app.ranks.titles(actor, needTenant()) });
    if (path === '/ranks' && req.method === 'GET') { const t = needTenant(); return ok({ ...app.ranks.get(actor, t), design: app.card.get(t).design }); } // design: 色の確認用プレビューに使う
    if (path === '/ranks' && req.method === 'PUT') return ok(app.ranks.save(actor, needTenant(), body));
    if (isOp && (m = /^\/tenants\/([\w-]+)\/features$/.exec(path))) { if (req.method === 'GET') return ok({ features: featureMap(app.store, m[1]), labels: FEATURES }); if (req.method === 'PUT') return ok({ features: setFeatures(app.store, actor, m[1], body) }); }
    if (path === '/birthday' && req.method === 'GET') return ok({ ...app.birthday.get(actor, needTenant()), preview: app.birthday.preview(actor, needTenant()) });
    if (path === '/birthday' && req.method === 'PUT') { const t = needTenant(); const saved = app.birthday.save(actor, t, body); return ok({ ...saved, preview: app.birthday.preview(actor, t) }); }
    if (path === '/birthday/run' && req.method === 'POST') return ok(await app.birthday.run(actor, needTenant(), { force: true }));
    if (path === '/messages' && req.method === 'GET') return ok({ messages: app.messaging.history(actor, needTenant()) });

    // 来店 (QRスキャン / 履歴)
    if (path === '/visits/scan' && req.method === 'POST') { const t = needTenant(), r = app.members.scanVisit(actor, t, body.code); return ok({ ...r, rewards: await app.visitRules.onVisit(t, r.member_id) }); }
    if (isOp && path === '/ops-help' && req.method === 'GET') return ok({ help: OPS_HELP });
    if (path === '/scan-mode' && req.method === 'GET') return ok({ mode: app.members.scanMode(needTenant()) });
    if (path === '/scan-mode' && req.method === 'PUT') return ok({ mode: app.members.setScanMode(actor, needTenant(), body.mode) });
    if (path === '/visits/store-qr' && req.method === 'GET') { const t = needTenant(), r = app.members.issueStoreVisitCode(actor, t); return ok({ ...r, url: app.messaging.visitUrl(actor, t, r.code) }); }
    if (path === '/visit-rules' && req.method === 'GET') return ok({ rules: app.visitRules.list(actor, needTenant()) });
    if (path === '/visit-rules' && req.method === 'POST') return ok(app.visitRules.create(actor, needTenant(), body), 201);
    if ((m = /^\/visit-rules\/([0-9a-f]{32})$/.exec(path)) && req.method === 'PUT') return ok(app.visitRules.update(actor, needTenant(), m[1], body));
    if ((m = /^\/visit-rules\/([0-9a-f]{32})$/.exec(path)) && req.method === 'DELETE') { app.visitRules.remove(actor, needTenant(), m[1]); return ok(); }
    if (path === '/visits' && req.method === 'GET') return ok({ visits: app.members.visits(actor, needTenant()) });

    // 会員
    if (path === '/members/search' && req.method === 'POST') { // ページ送り: limit(1〜200) / offset。columns で一覧に出す項目を指定
      const n = parseInt(body.limit, 10), limit = n >= 1 ? Math.min(n, 200) : 20, offset = Math.max(parseInt(body.offset, 10) || 0, 0);
      const columns = Array.isArray(body.columns) ? body.columns.filter((c) => typeof c === 'string').slice(0, 40) : undefined;
      const r = mm.search(actor, needTenant(), { where: body.where, sort: body.sort, status: body.status, limit, offset, columns });
      return ok({ total: r.total, members: r.members, limit, offset });
    }
    if ((m = /^\/members\/(\w+)$/.exec(path)) && req.method === 'GET') { const { member, items, notice, consents } = mm.profile(actor, needTenant(), m[1]); return ok({ member, items, notice, consents }); }
    if ((m = /^\/members\/(\w+)$/.exec(path)) && req.method === 'PATCH') { mm.updateByStaff(actor, needTenant(), m[1], body.values ?? {}); return ok(); }
    if ((m = /^\/members\/(\w+)\/withdraw$/.exec(path)) && req.method === 'POST') { mm.withdrawByAdmin(actor, needTenant(), m[1], body.reason); return ok(); }
    if ((m = /^\/members\/(\w+)\/restore$/.exec(path)) && req.method === 'POST') { mm.restore(actor, needTenant(), m[1]); return ok(); }
    if ((m = /^\/members\/(\w+)\/visit$/.exec(path)) && req.method === 'POST') { const t = needTenant(), r = mm.recordVisit(actor, t, m[1]); return ok({ rewards: await app.visitRules.onVisit(t, m[1]) }); }
    if (path === '/export' && req.method === 'POST') {
      const opts = { columns: body.columns ?? [], where: body.where, sort: body.sort, status: body.status };
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
    if (p === '/healthz' || p === '/status') return send(res, 200, { ok: true }); // Cloud Run の run.app では /healthz がGoogle側で予約され届かないため /status も用意
    if (req.method === 'GET' && p === '/app/config.json') { // 店舗ごとの LIFF ID (未設定なら既定値)
      const t = url.searchParams.get('t'), link = url.searchParams.get('link');
      let id = liffId ?? '';
      if (link) { try { id = adminLine(readLineLink(app.vault, app.store, link).admin).liffId || id; } catch { /* 無効なリンクは既定値 */ } }
      try { if (/^[0-9a-f]{32}$/.test(t ?? '')) id = resolveLine(app.store, app.vault, app.forms.resolveTenant(t), defaults).liffId || id; } catch { /* 無効なtokenは既定値 */ }
      return send(res, 200, { liffId: id });
    }
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, await readFile(PUBLIC_DIR + file), type, { 'content-security-policy': p.startsWith('/admin') ? ADMIN_CSP : APP_CSP });
    }
    if ((p === '/api/cron/run' || p === '/api/cron/birthday') && req.method === 'POST') { // Cloud Scheduler 用 (10分おき)。CRON_SECRET を Bearer で渡す
      const got = Buffer.from(req.headers.authorization ?? ''), want = Buffer.from(`Bearer ${cronSecret ?? ''}`);
      if (!cronSecret || got.length !== want.length || !timingSafeEqual(got, want)) return send(res, 401, { error: 'unauthorized' });
      const results = await app.birthday.runAll(Date.now(), { morningOnly: true }), schedules = await app.schedules.runDue();
      await app.store.flush?.();
      return send(res, 200, { results, schedules });
    }
    let m;
    if ((m = /^\/t\/([0-9a-f]{32})(?:\/([a-z]+)(?:\/([0-9a-f]{32})(?:\/([a-z]+))?)?)?$/.exec(p))) await publicApi(req, res, url, m[1], m[2], m[3], m[4]);
    else if (p.startsWith('/api/admin/')) await adminApi(req, res, url, p.slice('/api/admin'.length));
    else return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') await app.store.flush?.(); // Sheets への書き込み完了後に応答
  }

  return http.createServer(async (req, res) => {
    try { await route(req, res); } catch (e) {
      if (e instanceof AuthError) send(res, 401, { error: e.message, code: 'line_auth' });
      else if (e instanceof ValidationError) send(res, 400, { error: e.message, details: e.details, code: e.code, addUrl: e.addUrl });
      else if (e instanceof Forbidden) send(res, 403, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'internal error' }); }
    }
    pending.get(res)?.();
  });
}
