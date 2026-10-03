import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { seedMaster } from './master.js';
import { FormService } from './forms.js';
import { MemberService } from './members.js';
import { createVault } from './vault.js';
import { MessagingService } from './messaging.js';
import { CardService } from './card.js';
import { CouponService } from './coupons.js';
import { BirthdayService } from './birthday.js';
import { VisitRuleService } from './visitrules.js';
import { RankService } from './ranks.js';
import { ScheduleService } from './schedules.js';

// secret: 署名/暗号化鍵の元 (本番は SESSION_SECRET)。未指定なら起動ごとのランダム値 (開発・テスト用)。
export function createApp(fileOrStore = null, { secret = randomBytes(32).toString('hex'), dataKey = null, fetchImpl = fetch } = {}) {
  const store = fileOrStore instanceof Store ? fileOrStore : new Store(fileOrStore);
  seedMaster(store);
  const vault = createVault(secret, dataKey);
  const forms = new FormService(store);
  const members = new MemberService(store, forms, vault);
  const coupons = new CouponService(store, vault);
  const messaging = new MessagingService(store, vault, members, fetchImpl);
  messaging.coupons = coupons; // クーポンの添付・付与
  const birthday = new BirthdayService(store, vault, members, coupons, fetchImpl);
  const visitRules = new VisitRuleService(store, vault, members, coupons, fetchImpl);
  const ranks = new RankService(store); members.ranks = ranks; // 会員の絞り込み条件「会員ランク」で使う
  const schedules = new ScheduleService(store, members, messaging);
  return { store, vault, forms, members, card: new CardService(store), coupons, messaging, birthday, visitRules, ranks, schedules, fetchImpl };
}
