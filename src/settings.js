// 店舗ごとの LINE 連携設定 (LIFF / ログインチャネル / メッセージ用トークン / ショップカードURL)
import { ValidationError } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { isLiffId, isChannelId, isChannelToken, assertLineUrl, botInfo } from './line.js';

const tenant = (store, id) => {
  const t = store.find('tenants', (x) => x.tenant_id === id);
  if (!t) throw new ValidationError('店舗が存在しません');
  return t;
};

// 実際に使う設定 (店舗未設定なら全体のデフォルトにフォールバック)。トークンは復号して返す(内部用)。
export function resolveLine(store, vault, tenantId, defaults = {}) {
  const t = tenant(store, tenantId);
  return {
    liffId: t.liff_id || defaults.liffId || '',
    loginChannelId: t.login_channel_id || defaults.loginChannelId || '',
    shopcardUrl: t.shopcard_url || '',
    messagingToken: t.messaging_token ? vault.decrypt(t.messaging_token) : null,
  };
}
// 管理画面向け (秘密は返さない)
export function publicLine(store, vault, tenantId, defaults) {
  const r = resolveLine(store, vault, tenantId, defaults);
  const t = tenant(store, tenantId);
  return { liffId: t.liff_id || '', loginChannelId: t.login_channel_id || '', shopcardUrl: r.shopcardUrl, hasMessagingToken: !!r.messagingToken, usingDefaults: { liffId: !t.liff_id && !!defaults?.liffId, loginChannelId: !t.login_channel_id && !!defaults?.loginChannelId } };
}

// patch の各キーは省略=変更なし / 空文字=解除。messagingToken は書き込み専用。
export function setLine(store, vault, actor, tenantId, patch) {
  require_(actor, 'LINE_SETTINGS', tenantId);
  tenant(store, tenantId);
  const set = {}; const changed = [];
  const field = (key, col, validate, transform = (v) => v) => {
    if (patch[key] === undefined) return;
    const v = String(patch[key]).trim();
    if (v && !validate(v)) throw new ValidationError(`${key} の形式が正しくありません`);
    set[col] = v ? transform(v) : ''; changed.push(key);
  };
  field('liffId', 'liff_id', isLiffId);
  field('loginChannelId', 'login_channel_id', isChannelId);
  field('messagingToken', 'messaging_token', isChannelToken, (v) => vault.encrypt(v));
  field('shopcardUrl', 'shopcard_url', (v) => { assertLineUrl(v); return true; });
  store.update('tenants', (t) => t.tenant_id === tenantId, set);
  audit(store, { tenant_id: tenantId, actor, action: 'LINE_SETTINGS_UPDATE', target: 'line', detail: { changed } }); // 値(秘密)は記録しない
}

export async function testMessaging(store, vault, actor, tenantId, fetchImpl) {
  require_(actor, 'LINE_SETTINGS', tenantId);
  const { messagingToken } = resolveLine(store, vault, tenantId);
  if (!messagingToken) throw new ValidationError('メッセージ用のチャネルアクセストークンが未設定です');
  return botInfo(messagingToken, fetchImpl);
}
