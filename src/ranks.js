// 会員ランク: 来店回数に応じて、称号・☆の数・カードの色が変わる。
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_RANKS = [
  { title: 'レギュラー', min_visits: 0, star_color: '#cd7f32', card_color1: '', card_color2: '' },
  { title: 'シルバー', min_visits: 5, star_color: '#b0b7c3', card_color1: '', card_color2: '' },
  { title: 'ゴールド', min_visits: 15, star_color: '#f5b301', card_color1: '', card_color2: '' },
  { title: 'プラチナ', min_visits: 30, star_color: '#7fd3e6', card_color1: '', card_color2: '' },
];

export class RankService {
  constructor(store) { this.store = store; }
  #row(tenantId) { return this.store.find('member_ranks', (r) => r.tenant_id === tenantId); }
  get(actor, tenantId) {
    require_(actor, 'CARD_DESIGN', tenantId);
    const c = this.#row(tenantId)?.config;
    return { enabled: !!c?.enabled, ranks: c?.ranks?.length ? c.ranks : DEFAULT_RANKS, version: Number(this.#row(tenantId)?.version) || 0 };
  }
  save(actor, tenantId, input) {
    require_(actor, 'CARD_DESIGN', tenantId);
    const errors = [], list = Array.isArray(input?.ranks) ? input.ranks : [];
    if (list.length < 1 || list.length > 10) errors.push('ランクは1〜10個で設定してください');
    const ranks = list.slice(0, 10).map((r, i) => {
      const title = typeof r?.title === 'string' ? r.title.trim() : '', min = Number(r?.min_visits);
      if (!title || title.length > 12) errors.push(`${i + 1}番目: 称号は1〜12文字で入力してください`); else { try { assertSafeText(title, '称号'); } catch (e) { errors.push(e.message); } }
      if (!Number.isInteger(min) || min < 0 || min > 100000) errors.push(`${i + 1}番目: 来店回数は0以上の整数で指定してください`);
      const color = (k, label, optional) => { const v = r?.[k] ?? ''; if (v === '' && optional) return ''; if (typeof v !== 'string' || !HEX.test(v)) { errors.push(`${i + 1}番目: ${label}は #RRGGBB で指定してください`); return ''; } return v.toLowerCase(); };
      const c1 = color('card_color1', 'カードの色1', true), c2 = color('card_color2', 'カードの色2', true);
      return { title, min_visits: min, star_color: color('star_color', '☆の色', false), card_color1: c1, card_color2: c1 ? (c2 || c1) : '' };
    });
    if (ranks.length && ranks[0].min_visits !== 0) errors.push('最初のランクの来店回数は0にしてください');
    for (let i = 1; i < ranks.length; i++) if (!(ranks[i].min_visits > ranks[i - 1].min_visits)) { errors.push('来店回数は、ランクが上がるごとに大きくしてください'); break; }
    if (errors.length) throw new ValidationError('会員ランクの入力内容に誤りがあります', errors);
    const config = { enabled: !!input.enabled, ranks }, cur = this.#row(tenantId);
    if (cur) this.store.update('member_ranks', (r) => r.tenant_id === tenantId, { config, version: (Number(cur.version) || 0) + 1, updated_at: new Date().toISOString(), updated_by: actor.id });
    else this.store.insert('member_ranks', { tenant_id: tenantId, config, version: 1, updated_at: new Date().toISOString(), updated_by: actor.id });
    audit(this.store, { tenant_id: tenantId, actor, action: 'RANK_UPDATE', detail: { enabled: config.enabled, count: ranks.length } });
    return this.get(actor, tenantId);
  }
  // 絞り込みの選択肢用: 有効なときのランクの称号 (低い順)
  titles(actor, tenantId) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    const c = this.#row(tenantId)?.config;
    return c?.enabled ? c.ranks.map((r) => r.title) : [];
  }
  // 会員のランク (無効なら null)。stars は 1 から。next は次のランクまでの残り回数
  forVisits(tenantId, visits) {
    const c = this.#row(tenantId)?.config;
    if (!c?.enabled || !c.ranks?.length) return null;
    const n = Number(visits) || 0;
    let idx = 0; c.ranks.forEach((r, i) => { if (n >= r.min_visits) idx = i; });
    const r = c.ranks[idx], nx = c.ranks[idx + 1];
    return { title: r.title, stars: idx + 1, starColor: r.star_color, color1: r.card_color1 || '', color2: r.card_color2 || '', next: nx ? { title: nx.title, remaining: nx.min_visits - n } : null };
  }
}
