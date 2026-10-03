// 秘密情報の暗号化 (AES-256-GCM) と用途別の署名 (HMAC)。鍵は DATA_ENCRYPTION_KEY、未指定なら SESSION_SECRET から導出。
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function createVault(secret, dataKey = null) {
  if (!secret || secret.length < 32) throw new Error('秘密鍵は32文字以上が必要です');
  const key = dataKey ? Buffer.from(hkdfSync('sha256', dataKey, '', 'data-encryption', 32)) : Buffer.from(hkdfSync('sha256', secret, '', 'data-encryption', 32));
  const signKey = (purpose) => Buffer.from(hkdfSync('sha256', secret, '', `sign:${purpose}`, 32));
  return {
    encrypt(plain) {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = String(blob).split('.');
      if (v !== 'v1' || !ct) throw new Error('暗号文の形式が不正です');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
    // payload(JSON) に用途別の署名を付ける。"<payload>.<sig>"
    sign(purpose, obj) {
      const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return `${p}.${createHmac('sha256', signKey(purpose)).update(p).digest('base64url')}`;
    },
    verify(purpose, token) {
      const [p, sig] = String(token ?? '').split('.');
      if (!p || !sig) return null;
      const good = Buffer.from(createHmac('sha256', signKey(purpose)).update(p).digest('base64url')), given = Buffer.from(sig);
      if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
      try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
    },
  };
}
