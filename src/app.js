import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { seedMaster } from './master.js';
import { FormService } from './forms.js';
import { MemberService } from './members.js';
import { createVault } from './vault.js';
import { MessagingService } from './messaging.js';

// secret: 署名/暗号化鍵の元 (本番は SESSION_SECRET)。未指定なら起動ごとのランダム値 (開発・テスト用)。
export function createApp(fileOrStore = null, { secret = randomBytes(32).toString('hex'), dataKey = null, fetchImpl = fetch } = {}) {
  const store = fileOrStore instanceof Store ? fileOrStore : new Store(fileOrStore);
  seedMaster(store);
  const vault = createVault(secret, dataKey);
  const forms = new FormService(store);
  const members = new MemberService(store, forms, vault);
  return { store, vault, forms, members, messaging: new MessagingService(store, vault, members, fetchImpl), fetchImpl };
}
