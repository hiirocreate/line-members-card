// 店舗ごとの「ロール別の権限」: 運営が、店舗スタッフ・店舗管理者に何を許すかを店舗ごとに決める。
// 設定がなければ、標準の権限(permissions.js の BASE)を使う。アカウントごとの追加(grants)は、これに加えて有効。
import { ValidationError } from './sanitize.js';
import { require_, ASSIGNABLE, ROLE_PERM_LABELS, defaultRolePerms } from './permissions.js';
import { audit } from './audit.js';

const ROLES = ['STAFF', 'STORE_ADMIN'];
const tenantOf = (store, id) => store.find('tenants', (t) => t.tenant_id === id);

export function getRolePerms(store, actor, tenantId) {
  require_(actor, 'MASTER_EDIT', tenantId); // 運営のみ
  const t = tenantOf(store, tenantId);
  if (!t) throw new ValidationError('店舗が存在しません');
  const cur = t.role_perms && typeof t.role_perms === 'object' ? t.role_perms : {};
  return { roles: Object.fromEntries(ROLES.map((r) => [r, Array.isArray(cur[r]) ? cur[r] : defaultRolePerms(r)])), defaults: Object.fromEntries(ROLES.map((r) => [r, defaultRolePerms(r)])), assignable: ASSIGNABLE, labels: ROLE_PERM_LABELS };
}
export function setRolePerms(store, actor, tenantId, input) {
  require_(actor, 'MASTER_EDIT', tenantId);
  if (!tenantOf(store, tenantId)) throw new ValidationError('店舗が存在しません');
  const out = {};
  for (const r of ROLES) {
    const list = input?.[r];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((p) => !ASSIGNABLE.includes(p))) throw new ValidationError('権限の指定が不正です');
    const set = [...new Set(list)];
    if (!set.includes('MEMBER_VIEW')) throw new ValidationError('「会員の閲覧・検索」は、必ず許可してください');
    const def = defaultRolePerms(r);
    if (!(set.length === def.length && def.every((p) => set.includes(p)))) out[r] = ASSIGNABLE.filter((p) => set.includes(p)); // 標準と同じなら、設定として残さない
  }
  const cur = tenantOf(store, tenantId).role_perms ?? {}, next = { ...Object.fromEntries(ROLES.filter((r) => input?.[r] === undefined && cur[r]).map((r) => [r, cur[r]])), ...out };
  store.update('tenants', (t) => t.tenant_id === tenantId, { role_perms: next });
  audit(store, { tenant_id: tenantId, actor, action: 'ROLE_PERMS', detail: next });
  return getRolePerms(store, actor, tenantId);
}
