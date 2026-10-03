// RFC 6238 TOTP (SHA-1 / 6桁 / 30秒) と回復コード
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf) => { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += ALPHA[(v << (5 - bits)) & 31]; return out; };
const unbase32 = (s) => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('bad base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };

export const newSecret = () => base32(randomBytes(20));
export function totp(secret, time = Date.now(), step = 30) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = createHmac('sha1', unbase32(secret)).update(ctr).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
// ±1ステップ(30秒)の時計ずれを許容
export function verifyTotp(secret, code, time = Date.now()) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  let ok = false;
  for (const d of [-1, 0, 1]) { const x = Buffer.from(totp(secret, time + d * 30_000)); if (timingSafeEqual(x, Buffer.from(c))) ok = true; }
  return ok;
}
export const otpauthUri = (secret, account, issuer = '会員管理') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

export const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => { const r = randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
export const hashRecovery = (code) => createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex');
