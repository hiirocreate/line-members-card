// LINE Messaging API ラッパーと入力検証 (fetch は差し替え可能)
import { randomUUID } from 'node:crypto';
import { ValidationError } from './sanitize.js';

export const isLiffId = (s) => /^\d{5,15}-[A-Za-z0-9]{4,20}$/.test(s);
export const isChannelId = (s) => /^\d{5,15}$/.test(s);
export const isChannelToken = (s) => /^[A-Za-z0-9+/=_.-]{20,400}$/.test(s);
// ショップカード等のリンク: https の LINE ドメインのみ (任意URLへの誘導を防ぐ)
export function assertLineUrl(u) {
  let x; try { x = new URL(u); } catch { throw new ValidationError('URLの形式が正しくありません'); }
  const h = x.hostname.toLowerCase();
  const ok = x.protocol === 'https:' && !x.username && !x.password && (h === 'line.me' || h.endsWith('.line.me') || h === 'lin.ee' || h.endsWith('.lin.ee'));
  if (!ok) throw new ValidationError('LINEのURL(https://line.me/... または https://lin.ee/...)のみ設定できます');
  return x.toString();
}

const call = async (fetchImpl, token, path, init = {}) => {
  const r = await fetchImpl(`https://api.line.me${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* 非JSON */ }
  return { ok: r.ok, status: r.status, body };
};

export async function botInfo(token, fetchImpl = fetch) {
  const r = await call(fetchImpl, token, '/v2/bot/info');
  if (!r.ok) throw new ValidationError(`LINE公式アカウントの確認に失敗しました (HTTP ${r.status})。チャネルアクセストークンを確認してください`);
  return { displayName: r.body.displayName, basicId: r.body.basicId, userId: r.body.userId };
}

// multicast は1リクエスト最大500人。X-Line-Retry-Key で再送時の二重配信を防ぐ。
// onSent(userIds): 送信に成功したまとまりごとに呼ばれる (クーポンの付与など、届いた人にだけ行う処理用)
export async function multicast(token, userIds, messages, fetchImpl = fetch, onSent = null) {
  let sent = 0, failed = 0; const errors = [];
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    const r = await call(fetchImpl, token, '/v2/bot/message/multicast', { method: 'POST', headers: { 'x-line-retry-key': randomUUID() }, body: JSON.stringify({ to: chunk, messages }) });
    if (r.ok) { sent += chunk.length; onSent?.(chunk); } else { failed += chunk.length; errors.push(`HTTP ${r.status}: ${r.body?.message ?? ''}`.trim()); }
  }
  return { sent, failed, errors };
}

// 1人へのプッシュ送信 (二段階認証のコードなど)。友だちでない/ブロック中の相手には届かない(LINEの仕様)。
export async function push(token, to, messages, fetchImpl = fetch) {
  const r = await call(fetchImpl, token, '/v2/bot/message/push', { method: 'POST', headers: { 'x-line-retry-key': randomUUID() }, body: JSON.stringify({ to, messages }) });
  if (!r.ok) throw new ValidationError(`LINEへ送信できませんでした (HTTP ${r.status})。公式アカウントの設定(チャネルアクセストークン)と、友だち追加の状態を確認してください`);
}

// 友だち追加の確認: 公式アカウントの友だち(ブロックしていない)なら、プロフィールが取得できる。
// 友だちでない/ブロック中 → 404。それ以外のエラー(トークン不正・LINE側の障害など)は、確認できなかったものとして例外にする。
// 注意: ユーザーIDと公式アカウントが「同じプロバイダー」でないと、友だちでも404になる。
export async function isFriend(token, userId, fetchImpl = fetch) {
  const r = await call(fetchImpl, token, `/v2/bot/profile/${encodeURIComponent(userId)}`);
  if (r.ok) return true;
  if (r.status === 404) return false;
  if (r.status === 401 || r.status === 403) throw new ValidationError('友だち追加の確認ができません(店舗のチャネルアクセストークンを確認してください)');
  throw new ValidationError('友だち追加の確認ができませんでした。しばらくしてからお試しください');
}
// 友だち追加のURL (LINEアプリで開くと、公式アカウントの追加画面になる)
export const friendAddUrl = (basicId) => (basicId ? `https://line.me/R/ti/p/${encodeURIComponent(basicId)}` : null);

// クーポンを配信するための Flex メッセージ (カード: タイトル・特典・条件・期限 + 「クーポンを使う」ボタン)
export function couponFlex({ shop, coupon, url, untilText }) {
  const txt = (text, extra = {}) => ({ type: 'text', text, wrap: true, ...extra });
  return {
    type: 'flex', altText: `【${shop}】クーポン: ${coupon.title}`.slice(0, 400),
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        txt('COUPON', { size: 'xs', color: '#06c755', weight: 'bold' }),
        txt(coupon.title, { weight: 'bold', size: 'xl' }),
        ...(coupon.benefit ? [txt(coupon.benefit, { size: 'lg', color: '#d9381e', weight: 'bold' })] : []),
        ...(coupon.description ? [txt(coupon.description, { size: 'sm', color: '#666666' })] : []),
        txt(`有効期限: ${untilText || 'なし'}`, { size: 'xs', color: '#999999' }),
      ] },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#06c755', action: { type: 'uri', label: 'クーポンを使う', uri: url } }] },
    },
  };
}
