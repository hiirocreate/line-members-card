// XSS 対策: 管理者入力の拒否 (保存時) と HTML エスケープ (表示時) の二段構え
const DANGEROUS = /<[^>]*>|<\s*\/?\s*[a-z!]|javascript\s*:|data\s*:\s*text\/html|\bon\w+\s*=/i;

export class ValidationError extends Error {
  constructor(message, details = []) { super(message); this.name = 'ValidationError'; this.details = details; }
}

// 公式アカウントの友だち追加が必要 (HTTP 400, code: friend_required)。addUrl は友だち追加のURL。
export class FriendRequiredError extends ValidationError {
  constructor(addUrl) { super('会員登録の前に、公式アカウントを友だち追加してください'); this.code = 'friend_required'; this.addUrl = addUrl ?? null; }
}

// 認証失敗 (HTTP 401): LINEのIDトークンが無効/期限切れ。クライアントは再ログインする。
export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

export function assertSafeText(value, label) {
  if (typeof value !== 'string') return;
  if (DANGEROUS.test(value)) throw new ValidationError(`${label}にHTML/スクリプトは使用できません`);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}
