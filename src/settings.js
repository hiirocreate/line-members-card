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

// 友だち追加を会員登録の条件にするか。未設定(空)のときは、確認に使えるトークンがあれば有効 (推奨の既定)。
function requireFriendOf(t) {
  const v = t.require_friend;
  if (v === true || v === 'TRUE' || v === 'true') return true;
  if (v === false || v === 'FALSE' || v === 'false') return false;
  return !!t.messaging_token;
}

// 実際に使う設定 (店舗未設定なら全体のデフォルトにフォールバック)。トークンは復号して返す(内部用)。
export function resolveLine(store, vault, tenantId, defaults = {}) {
  const t = tenant(store, tenantId);
  return {
    liffId: t.liff_id || defaults.liffId || '',
    loginChannelId: t.login_channel_id || defaults.loginChannelId || '',
    shopcardUrl: t.shopcard_url || '',
    messagingToken: t.messaging_token ? vault.decrypt(t.messaging_token) : null,
    friendUrl: t.friend_url || '',
    requireFriend: requireFriendOf(t),
  };
}
// 管理画面向け (秘密は返さない)
export function publicLine(store, vault, tenantId, defaults) {
  const r = resolveLine(store, vault, tenantId, defaults);
  const t = tenant(store, tenantId);
  return { liffId: t.liff_id || '', loginChannelId: t.login_channel_id || '', shopcardUrl: r.shopcardUrl, hasMessagingToken: !!r.messagingToken, requireFriend: r.requireFriend, requireFriendExplicit: t.require_friend === true || t.require_friend === false || t.require_friend === 'TRUE' || t.require_friend === 'FALSE', friendUrl: r.friendUrl, usingDefaults: { liffId: !t.liff_id && !!defaults?.liffId, loginChannelId: !t.login_channel_id && !!defaults?.loginChannelId } };
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
  field('friendUrl', 'friend_url', (v) => { assertLineUrl(v); return true; });
  if (patch.requireFriend !== undefined) {
    if (typeof patch.requireFriend !== 'boolean') throw new ValidationError('requireFriend は true/false で指定してください');
    const hasToken = !!(set.messaging_token ?? tenant(store, tenantId).messaging_token);
    if (patch.requireFriend && !hasToken) throw new ValidationError('友だち追加の確認には、メッセージ用チャネルアクセストークンが必要です。先に登録してください');
    set.require_friend = patch.requireFriend; changed.push('requireFriend');
  }
  store.update('tenants', (t) => t.tenant_id === tenantId, set);
  audit(store, { tenant_id: tenantId, actor, action: 'LINE_SETTINGS_UPDATE', target: 'line', detail: { changed } }); // 値(秘密)は記録しない
}

export async function testMessaging(store, vault, actor, tenantId, fetchImpl) {
  require_(actor, 'LINE_SETTINGS', tenantId);
  const { messagingToken } = resolveLine(store, vault, tenantId);
  if (!messagingToken) throw new ValidationError('メッセージ用のチャネルアクセストークンが未設定です');
  return botInfo(messagingToken, fetchImpl);
}
