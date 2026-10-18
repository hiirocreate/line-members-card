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
// 店舗ごとに運営が決めた「ロール別の権限」(actor.rolePerms) があれば、それを基本の権限として使う
export const ROLE_PERM_LABELS = {
  MEMBER_VIEW: ['会員の閲覧・検索', '会員の一覧・詳細を見る(常に必要)'], MEMBER_EDIT: ['来店の記録・クーポン使用', '来店スキャン、会員情報の修正'],
  FORM_EDIT: ['会員登録フォーム・登録URL', '登録項目の編集、登録URLの発行'], CARD_DESIGN: ['会員証デザイン・会員ランク', 'カードの見た目、ランクの設定'],
  COUPON_MANAGE: ['クーポンの管理', 'クーポンの作成・編集・終了'], MESSAGE_SEND: ['メッセージ配信', '一斉配信、予約、誕生日、来店回数、配信予定'],
  LINE_SETTINGS: ['LINE連携・来店方式', 'LINEのID・トークン、来店の記録方式'], MEMBER_STATUS: ['退会・復帰の操作', '会員の退会処理、復帰'],
  EXPORT_MEMBERS: ['会員のExcel出力', '会員一覧のダウンロード'], EXPORT_PERSONAL_DATA: ['個人情報を含む出力', '氏名・電話番号などの出力'], EXPORT_VISITS: ['来店履歴の出力', '来店履歴のダウンロード'],
};
export const ASSIGNABLE = Object.keys(ROLE_PERM_LABELS); // 運営だけが持つ権限(マスタ・項目の完全削除・方針の編集)は、店舗のロールには付けられない
export const defaultRolePerms = (role) => [...(BASE[role] ?? [])];
export function can(actor, perm) {
  if (!actor) return false;
  return (actor.rolePerms ?? BASE[actor.role] ?? []).includes(perm) || (actor.grants ?? []).includes(perm);
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
