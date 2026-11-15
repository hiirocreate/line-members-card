// 会員ランク: 来店回数に応じて、称号・☆の数・カードの色が変わる。
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';
import { METALS } from './card.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_RANKS = [
  { title: 'レギュラー', min_visits: 0, star_color: '#cd7f32', card_color1: '', card_color2: '' },
  { title: 'シルバー', min_visits: 5, star_color: '#b0b7c3', card_color1: '', card_color2: '' },
  { title: 'ゴールド', min_visits: 15, star_color: '#f5b301', card_color1: '', card_color2: '' },
  { title: 'プラチナ', min_visits: 30, star_color: '#7fd3e6', card_color1: '', card_color2: '' },
];

export const EFFECTS = { confetti: '紙吹雪', flash: '光・フラッシュ', badge: 'バッジ出現', grand: '豪華な特別演出' };
export const BADGE_SHAPES = { circle: '円', rounded: '角丸', hex: '六角形', shield: '盾', star: '星' };
export const DEFAULT_BADGE = { label: 'RANK UP!', icon: '★', shape: 'circle', color: '', show_title: true, show_stars: true };
const DEFAULT_FX = { enabled: false, kind: 'confetti', seconds: 4, badge: DEFAULT_BADGE };
const badgeOf = (fx) => ({ ...DEFAULT_BADGE, ...(fx?.badge ?? {}) });
const iconOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 8 && [...v].length <= 3;

export class RankService {
  constructor(store) { this.store = store; }
  #row(tenantId) { return this.store.find('member_ranks', (r) => r.tenant_id === tenantId); }
  get(actor, tenantId) {
    require_(actor, 'CARD_DESIGN', tenantId);
    const c = this.#row(tenantId)?.config;
    return { enabled: !!c?.enabled, show_next: c?.show_next !== false, ranks: c?.ranks?.length ? c.ranks : DEFAULT_RANKS, effect: { ...DEFAULT_FX, ...(c?.effect ?? {}), badge: badgeOf(c?.effect) }, version: Number(this.#row(tenantId)?.version) || 0 };
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
      const metal = r?.card_metal ?? ''; if (metal !== '' && !METALS.includes(metal)) errors.push(`${i + 1}番目: メタリックの種類が不正です`);
      const dd = r?.demote_days === '' || r?.demote_days === undefined || r?.demote_days === null ? '' : Number(r.demote_days);
      if (dd !== '' && (!Number.isInteger(dd) || dd < 1 || dd > 3650)) errors.push(`${i + 1}番目: ランクダウンの日数は1〜3650の整数で指定してください`);
      const ek = r?.effect_kind ?? ''; if (ek !== '' && !(ek in EFFECTS)) errors.push(`${i + 1}番目: 演出の種類が不正です`);
      const bi = r?.badge_icon ?? ''; if (bi !== '') { if (!iconOk(bi)) errors.push(`${i + 1}番目: バッジの記号は3文字以内で入力してください`); else { try { assertSafeText(bi, 'バッジの記号'); } catch (e) { errors.push(e.message); } } }
      return { title, effect_kind: ek in EFFECTS ? ek : '', badge_icon: bi === '' || !iconOk(bi) ? '' : bi, min_visits: min, star_color: color('star_color', '☆の色', false), card_color1: c1, card_color2: c1 ? (c2 || c1) : '', card_metal: METALS.includes(metal) ? metal : '', demote_days: i === 0 ? '' : dd };
    });
    if (ranks.length && ranks[0].min_visits !== 0) errors.push('最初のランクの来店回数は0にしてください');
    for (let i = 1; i < ranks.length; i++) if (!(ranks[i].min_visits > ranks[i - 1].min_visits)) { errors.push('来店回数は、ランクが上がるごとに大きくしてください'); break; }
    if (errors.length) throw new ValidationError('会員ランクの入力内容に誤りがあります', errors);
    const fx = input.effect ?? {}, seconds = Number(fx.seconds ?? DEFAULT_FX.seconds), kind = fx.kind ?? DEFAULT_FX.kind;
    if (!(kind in EFFECTS)) errors.push('演出の種類が不正です');
    if (!Number.isFinite(seconds) || seconds < 2 || seconds > 10) errors.push('演出の表示時間は2〜10秒で指定してください');
    if (errors.length) throw new ValidationError('会員ランクの入力内容に誤りがあります', errors);
    const bd = { ...DEFAULT_BADGE, ...(fx.badge ?? {}) };
    if (typeof bd.label !== 'string' || bd.label.length > 16) errors.push('バッジの見出しは16文字以内で入力してください'); else { try { assertSafeText(bd.label, 'バッジの見出し'); } catch (e) { errors.push(e.message); } }
    if (!iconOk(bd.icon)) errors.push('バッジの記号は1〜3文字で入力してください'); else { try { assertSafeText(bd.icon, 'バッジの記号'); } catch (e) { errors.push(e.message); } }
    if (!(bd.shape in BADGE_SHAPES)) errors.push('バッジの形が不正です');
    if (bd.color !== '' && !HEX.test(bd.color ?? '')) errors.push('バッジの色は #RRGGBB で指定してください');
    if (errors.length) throw new ValidationError('会員ランクの入力内容に誤りがあります', errors);
    const config = { effect: { enabled: fx.enabled === true, kind, seconds, badge: { label: bd.label, icon: bd.icon, shape: bd.shape, color: bd.color ? bd.color.toLowerCase() : '', show_title: bd.show_title !== false, show_stars: bd.show_stars !== false } }, enabled: !!input.enabled, show_next: input.show_next !== false, ranks }, cur = this.#row(tenantId);
    if (cur) this.store.update('member_ranks', (r) => r.tenant_id === tenantId, { config, version: (Number(cur.version) || 0) + 1, updated_at: new Date().toISOString(), updated_by: actor.id });
    else this.store.insert('member_ranks', { tenant_id: tenantId, config, version: 1, updated_at: new Date().toISOString(), updated_by: actor.id });
    audit(this.store, { tenant_id: tenantId, actor, action: 'RANK_UPDATE', detail: { enabled: config.enabled, count: ranks.length } });
    return this.get(actor, tenantId);
  }
  // 会員の画面を開いたとき: 前回見たランクより上がっていれば、演出の情報を返す(1回だけ)。ランクが下がったときや、初めて見るときは何も出さずに記録だけする。
  // rank: forVisits() の結果。記録は members.rank_seen(★の数)。
  checkUp(tenantId, member, rank) {
    const c = this.#row(tenantId)?.config;
    if (!rank || !c?.enabled) return null;
    const seen = member.rank_seen === '' || member.rank_seen === undefined ? NaN : Number(member.rank_seen);
    if (seen === rank.stars) return null;
    this.store.update('members', (r) => r.tenant_id === tenantId && r.member_id === member.member_id, { rank_seen: rank.stars });
    const fx = { ...DEFAULT_FX, ...(c.effect ?? {}) };
    if (!fx.enabled || !(rank.stars > seen) || rank.demoted) return null;
    const own = c.ranks[rank.stars - 1]?.effect_kind;
    const b = badgeOf(fx), icon = c.ranks[rank.stars - 1]?.badge_icon || b.icon;
    return { kind: own || fx.kind, seconds: fx.seconds, badge: { label: b.label, icon, shape: b.shape, color: b.color, showTitle: b.show_title !== false, showStars: b.show_stars !== false }, title: rank.title, stars: rank.stars, starColor: rank.starColor, from: c.ranks[seen - 1]?.title ?? '' };
  }
  // 絞り込みの選択肢用: 有効なときのランクの称号 (低い順)
  titles(actor, tenantId) {
    require_(actor, 'MEMBER_VIEW', tenantId);
    const c = this.#row(tenantId)?.config;
    return c?.enabled ? c.ranks.map((r) => r.title) : [];
  }
  // 会員のランク (無効なら null)。stars は 1 から。
  // ランクダウン: 最終来店からの日数が、そのランクの demote_days を超えると1つ下のランクになる(下のランクの日数も超えていれば、さらに下がる)。
  // next は次のランク。ランクダウン中は demoted=true で、来店1回で戻る。show_next が false のときは next を返さない。
  forVisits(tenantId, visits, lastVisitAt = '', nowMs = Date.now()) {
    const c = this.#row(tenantId)?.config;
    if (!c?.enabled || !c.ranks?.length) return null;
    const n = Number(visits) || 0, ts = Date.parse(lastVisitAt), idle = Number.isNaN(ts) ? 0 : Math.max(0, Math.floor((nowMs - ts) / 86400_000));
    let idx = 0; c.ranks.forEach((r, i) => { if (n >= r.min_visits) idx = i; });
    const earned = idx;
    while (idx > 0 && Number(c.ranks[idx].demote_days) > 0 && idle > Number(c.ranks[idx].demote_days)) idx--;
    const r = c.ranks[idx], nx = c.ranks[idx + 1], demoted = idx < earned;
    return { title: r.title, stars: idx + 1, starColor: r.star_color, color1: r.card_color1 || '', color2: r.card_color2 || '', metal: r.card_metal || '', demoted,
      next: c.show_next !== false && nx ? { title: nx.title, remaining: Math.max(1, nx.min_visits - n) } : null };
  }
}
