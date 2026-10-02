import { randomUUID } from 'node:crypto';

export function audit(store, { tenant_id, actor, action, target = '', detail = {} }) {
  store.insert('audit_logs', {
    log_id: randomUUID(), tenant_id, actor: actor?.id ?? 'system', action, target, detail,
    created_at: new Date().toISOString(),
  });
}
export const listAudit = (store, tenantId) => store.select('audit_logs', (r) => r.tenant_id === tenantId);
