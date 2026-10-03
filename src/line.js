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
export async function multicast(token, userIds, messages, fetchImpl = fetch) {
  let sent = 0, failed = 0; const errors = [];
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    const r = await call(fetchImpl, token, '/v2/bot/message/multicast', { method: 'POST', headers: { 'x-line-retry-key': randomUUID() }, body: JSON.stringify({ to: chunk, messages }) });
    if (r.ok) sent += chunk.length; else { failed += chunk.length; errors.push(`HTTP ${r.status}: ${r.body?.message ?? ''}`.trim()); }
  }
  return { sent, failed, errors };
}
