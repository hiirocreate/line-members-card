import { Store } from './store.js';
import { seedMaster } from './master.js';
import { FormService } from './forms.js';
import { MemberService } from './members.js';

export function createApp(file = null) {
  const store = new Store(file);
  seedMaster(store);
  const forms = new FormService(store);
  return { store, forms, members: new MemberService(store, forms) };
}
