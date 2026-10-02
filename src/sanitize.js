// XSS 対策: 管理者入力の拒否 (保存時) と HTML エスケープ (表示時) の二段構え
const DANGEROUS = /<[^>]*>|<\s*\/?\s*[a-z!]|javascript\s*:|data\s*:\s*text\/html|\bon\w+\s*=/i;

export class ValidationError extends Error {
  constructor(message, details = []) { super(message); this.name = 'ValidationError'; this.details = details; }
}

export function assertSafeText(value, label) {
  if (typeof value !== 'string') return;
  if (DANGEROUS.test(value)) throw new ValidationError(`${label}にHTML/スクリプトは使用できません`);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}
