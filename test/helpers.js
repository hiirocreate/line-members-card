import { createApp } from '../src/app.js';

export const OP = { id: 'op', role: 'OPERATOR', tenantId: null };
export const ADMIN_A = { id: 'adminA', role: 'STORE_ADMIN', tenantId: 'SHOP001' };
export const STAFF_A = { id: 'staffA', role: 'STAFF', tenantId: 'SHOP001' };
export const ADMIN_B = { id: 'adminB', role: 'STORE_ADMIN', tenantId: 'SHOP002' };

export function setup() {
  const app = createApp();
  const tokenA = app.forms.createTenant(OP, 'SHOP001', 'テスト美容室');
  const tokenB = app.forms.createTenant(OP, 'SHOP002', '別店舗');
  return { app, tokenA, tokenB };
}
