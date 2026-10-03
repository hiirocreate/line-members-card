// 店舗ごとの機能の制限。運営が店舗ごとにオフにすると、その店舗の管理者・スタッフには画面にも出ず、APIも使えない(運営は常に使える)。
import { ValidationError } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';

export const FEATURES = {
  card: '会員証デザイン', scan: '来店スキャン(来店の記録)', messages: 'メッセージ配信', schedule: '予約メッセージ(定期)', birthday: '誕生日配信',
  visitrules: '来店回数配信', coupons: 'クーポン', rank: '会員ランク',
};
const tenantOf = (store, id) => store.find('tenants', (t) => t.tenant_id === id);
export const featureOn = (store, tenantId, key) => { const f = tenantOf(store, tenantId)?.features; return !(f && typeof f === 'object' && f[key] === false); };
export const featureMap = (store, tenantId) => Object.fromEntries(Object.keys(FEATURES).map((k) => [k, featureOn(store, tenantId, k)]));

export function setFeatures(store, actor, tenantId, input) {
  require_(actor, 'MASTER_EDIT', tenantId); // 運営のみ
  if (!tenantOf(store, tenantId)) throw new ValidationError('店舗が存在しません');
  const off = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!(k in FEATURES)) throw new ValidationError(`不明な機能: ${k}`);
    if (typeof v !== 'boolean') throw new ValidationError('設定の値が不正です');
    if (!v) off[k] = false;
  }
  store.update('tenants', (t) => t.tenant_id === tenantId, { features: off });
  audit(store, { tenant_id: tenantId, actor, action: 'TENANT_FEATURES', detail: { off: Object.keys(off) } });
  return featureMap(store, tenantId);
}

// 管理APIのパス → 機能。ここに載っていないパスは制限されない
const ROUTES = [[/^\/card(\/|$)/, 'card'], [/^\/visits\/scan$/, 'scan'], [/^\/members\/\w+\/visit$/, 'scan'], [/^\/messages(\/|$)/, 'messages'], [/^\/schedules(\/|$)/, 'schedule'],
  [/^\/birthday(\/|$)/, 'birthday'], [/^\/visit-rules(\/|$)/, 'visitrules'], [/^\/coupons(\/|$)/, 'coupons'], [/^\/ranks?(\/|$)/, 'rank']];
export const featureForPath = (path) => ROUTES.find(([re]) => re.test(path))?.[1] ?? null;
