// LINE 公式アカウントからの一斉・セグメント配信。配信対象は「有効な会員 かつ LINE配信に同意した会員」のみ。
import { randomUUID } from 'node:crypto';
import { ValidationError } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { resolveLine } from './settings.js';
import { multicast, couponFlex } from './line.js';
import { fmtDay } from './coupons.js';

export class MessagingService {
  constructor(store, vault, members, fetchImpl = fetch) { Object.assign(this, { store, vault, members, fetchImpl }); }

  // 配信対象の LINE userId 一覧 (退会済み・未同意は含めない)
  audience(actor, tenantId, where) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const { _rows } = this.members.search(actor, tenantId, { where, limit: Infinity, status: 'ACTIVE' });
    const consented = new Set(this.store.select('member_consents', (c) => c.tenant_id === tenantId && c.channel === 'LINE' && c.granted).map((c) => c.member_id));
    const targets = _rows.map((r) => r.m).filter((m) => consented.has(m.member_id));
    return { matched: _rows.length, userIds: targets.map((m) => m.user_id), memberByUser: new Map(targets.map((m) => [m.user_id, m.member_id])) };
  }
  preview(actor, tenantId, where) {
    const a = this.audience(actor, tenantId, where);
    return { matched: a.matched, audience: a.userIds.length };
  }

  // expectedCount: 確認画面で見せた人数。確認後に対象が変わっていたら送らない。
  // couponId: クーポンを添付する場合。クーポンのカード(Flex)を添え、届いた会員にだけクーポンを付与する。
  async send(actor, tenantId, { text, where, expectedCount, couponId }) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    const body = typeof text === 'string' ? text.trim() : '';
    if (body.length > 5000) throw new ValidationError('メッセージは5000文字以内です');
    const coupon = couponId ? this.coupons.assertOfferable(tenantId, couponId) : null; // 期限切れ・終了済みは添付できない
    if (!body && !coupon) throw new ValidationError('メッセージを入力してください(クーポンだけの配信もできます)');
    const { messagingToken } = resolveLine(this.store, this.vault, tenantId);
    if (!messagingToken) throw new ValidationError('LINE設定でチャネルアクセストークンを登録してください');
    const messages = body ? [{ type: 'text', text: body }] : [];
    if (coupon) {
      const url = this.couponUrl?.(actor, tenantId, coupon.coupon_id);
      if (!url) throw new ValidationError('クーポンのURLを作れません。「LINE連携」でLIFF IDを設定してください');
      messages.push(couponFlex({ shop: this.store.find('tenants', (t) => t.tenant_id === tenantId)?.name ?? '', coupon, url, until: fmtDay(coupon.valid_until) }));
    }
    const { userIds, memberByUser } = this.audience(actor, tenantId, where);
    if (!userIds.length) throw new ValidationError('配信対象の会員がいません');
    if (expectedCount !== userIds.length) throw new ValidationError(`配信対象が変わりました(現在 ${userIds.length}人)。再度確認してください`);
    const row = { message_id: randomUUID(), tenant_id: tenantId, created_by: actor.id, text: body || `(クーポン) ${coupon.title}`, audience: userIds.length, sent: 0, failed: 0, errors: [], status: 'SENDING', created_at: new Date().toISOString(), coupon_id: coupon?.coupon_id ?? '' };
    this.store.insert('messages', row);
    let r, granted = 0;
    const onSent = coupon ? (ids) => { granted += this.coupons.grant(tenantId, coupon.coupon_id, ids.map((u) => memberByUser.get(u)).filter(Boolean), row.message_id); } : null;
    try { r = await multicast(messagingToken, userIds, messages, this.fetchImpl, onSent); } catch (e) { r = { sent: 0, failed: userIds.length, errors: [String(e.message).slice(0, 200)] }; }
    const status = r.failed === 0 ? 'SENT' : r.sent === 0 ? 'FAILED' : 'PARTIAL';
    this.store.update('messages', (m) => m.message_id === row.message_id, { sent: r.sent, failed: r.failed, errors: r.errors.slice(0, 5), status });
    audit(this.store, { tenant_id: tenantId, actor, action: 'MESSAGE_SEND', target: row.message_id, detail: { audience: userIds.length, sent: r.sent, failed: r.failed, coupon: coupon?.coupon_id ?? null, granted } });
    return { message_id: row.message_id, audience: userIds.length, sent: r.sent, failed: r.failed, status, errors: r.errors.slice(0, 5), granted };
  }
  history(actor, tenantId, limit = 50) {
    require_(actor, 'MESSAGE_SEND', tenantId);
    return this.store.select('messages', (m) => m.tenant_id === tenantId).slice(-limit).reverse();
  }
}
