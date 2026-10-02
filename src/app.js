import { Store } from './store.js';
import { seedMaster } from './master.js';
import { FormService } from './forms.js';
import { MemberService } from './members.js';

export function createApp(fileOrStore = null) {
  const store = fileOrStore instanceof Store ? fileOrStore : new Store(fileOrStore);
  seedMaster(store);
  const forms = new FormService(store);
  return { store, forms, members: new MemberService(store, forms) };
}
