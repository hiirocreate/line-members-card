export const ROLES = { OPERATOR: 'OPERATOR', STORE_ADMIN: 'STORE_ADMIN', STAFF: 'STAFF' };

export const PERMS = ['FORM_EDIT', 'MEMBER_VIEW', 'MEMBER_EDIT', 'EXPORT_MEMBERS', 'EXPORT_PERSONAL_DATA',
  'EXPORT_VISITS', 'MASTER_EDIT', 'FIELD_HARD_DELETE', 'POLICY_EDIT', 'LINE_SETTINGS', 'MESSAGE_SEND', 'MEMBER_STATUS', 'CARD_DESIGN', 'COUPON_MANAGE'];

// エクスポート権限は独立。スタッフには原則付与しない。
const BASE = {
  STAFF: ['MEMBER_VIEW', 'MEMBER_EDIT'],
  STORE_ADMIN: ['FORM_EDIT', 'MEMBER_VIEW', 'MEMBER_EDIT', 'EXPORT_MEMBERS', 'EXPORT_PERSONAL_DATA', 'EXPORT_VISITS',
    'LINE_SETTINGS', 'MESSAGE_SEND', 'MEMBER_STATUS', 'CARD_DESIGN', 'COUPON_MANAGE'],
  OPERATOR: PERMS,
};
// 項目の visibility ごとに必要なロール階層
export const VISIBILITY_RANK = { USER: 0, STAFF: 1, ADMIN: 2, OPERATOR: 3, SYSTEM: 4 };
const ROLE_RANK = { STAFF: 1, STORE_ADMIN: 2, OPERATOR: 3 };

export class Forbidden extends Error {
  constructor(msg) { super(msg); this.name = 'Forbidden'; }
}

// actor: { id, role, tenantId, grants?: [perm] }  grants はスタッフ等への個別付与
export function can(actor, perm) {
  if (!actor) return false;
  return (BASE[actor.role] ?? []).includes(perm) || (actor.grants ?? []).includes(perm);
}
export function require_(actor, perm, tenantId) {
  if (!can(actor, perm)) throw new Forbidden(`権限がありません: ${perm}`);
  if (actor.role !== ROLES.OPERATOR && actor.tenantId !== tenantId) throw new Forbidden('他店舗のデータにはアクセスできません');
}
// actor が項目を閲覧できるか (actor 無し = 会員本人 = rank 0)
export function canSeeField(actor, field) {
  const rank = actor ? ROLE_RANK[actor.role] ?? 0 : 0;
  return field.visibility !== 'SYSTEM' && rank >= VISIBILITY_RANK[field.visibility];
}
