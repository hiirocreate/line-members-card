// 会員証デザイン (カード面 + 会員画面のテーマ) と、ロゴ/背景画像の保管。
// 画像はスペースの都合でスプレッドシートに 4万文字ずつ分割保存する (1画像 最大400KB、1店舗12枚まで)。
// 会員数・画像が増えたら、画像だけオブジェクトストレージへ移す想定 (CardService の get/add/deleteAsset を差し替える)。
import { randomUUID } from 'node:crypto';
import { ValidationError, assertSafeText } from './sanitize.js';
import { require_ } from './permissions.js';
import { audit } from './audit.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_ASSET_BYTES = 400_000, CHUNK = 40_000, MAX_ASSETS = 12;
const MIMES = { 'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' }; // SVGは許可しない(スクリプトを含められるため)

export const DEFAULT_DESIGN = {
  template: 'classic',
  background: { type: 'gradient', color1: '#14213d', color2: '#233a6b', angle: 135, imageId: null, overlay: 0, metal: 'gold' },
  bands: [{ show: false, color: '#ffffff', size: 'M' }, { show: false, color: '#ffffff', size: 'M' }, { show: false, color: '#ffffff', size: 'M' }], // 横の帯(上・中・下)
  textColor: '#ffffff', accentColor: '#fca311',
  shopName: { show: true, text: '', size: 'M', align: 'left' },
  title: 'MEMBER CARD',
  logo: { imageId: null, position: 'top-left', size: 'M' },
  fields: { name: true, reading: false, nameOrder: 'asis', registeredAt: false, lastVisit: true, visitCount: true },
  qr: 'below', qrBack: { x: 0, y: 0, size: 'M', label: true }, // qrBack: カードの裏面にQRを置くときの位置(中央からのずれ%)・大きさ・文字の表示
  radius: 'large', font: 'sans',
  page: { accentColor: '#06c755', backgroundColor: '#f4f5f7', welcomeText: '', showInfoList: true, showShopcard: true, showNotice: true },
};

export const METALS = ['gold', 'silver', 'bronze', 'platinum', 'rosegold', 'chrome']; // メタリック(金属調)の種類
const ENUM = {
  metal: METALS, bgType: ['solid', 'gradient', 'image', 'metal'], size: ['S', 'M', 'L'], align: ['left', 'center'], pos: ['top-left', 'top-center', 'top-right'],
  qr: ['below', 'inside', 'flip'], nameOrder: ['asis', 'swap'], radius: ['none', 'small', 'large'], font: ['sans', 'serif'], template: ['classic', 'dark', 'minimal', 'sakura', 'forest', 'photo', ...METALS.map((m) => `metal_${m}`), 'custom'],
};

// 入力を検証し、不足を既定値で補った完全なデザインを返す。未知の値・不正な色・他店舗の画像は拒否。
export function normalizeDesign(input, { hasAsset = () => false } = {}) {
  const d = input && typeof input === 'object' ? input : {};
  const errors = [];
  const pick = (v, list, def, label) => { if (v === undefined) return def; if (!list.includes(v)) { errors.push(`${label}の値が不正です`); return def; } return v; };
  const color = (v, def, label) => { if (v === undefined) return def; if (typeof v !== 'string' || !HEX.test(v)) { errors.push(`${label}は #RRGGBB 形式で指定してください`); return def; } return v.toLowerCase(); };
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const num = (v, def, min, max, label) => { if (v === undefined) return def; if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label}は${min}〜${max}で指定してください`); return def; } return Math.round(v); };
  const text = (v, def, max, label) => {
    if (v === undefined) return def;
    if (typeof v !== 'string' || v.length > max) { errors.push(`${label}は${max}文字以内で入力してください`); return def; }
    try { assertSafeText(v, label); } catch (e) { errors.push(e.message); return def; }
    return v.trim();
  };
  const img = (v, label) => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || !hasAsset(v)) { errors.push(`${label}の画像が見つかりません`); return null; } return v; };
  const D = DEFAULT_DESIGN, b = d.background ?? {}, sn = d.shopName ?? {}, lg = d.logo ?? {}, f = d.fields ?? {}, pg = d.page ?? {};
  const out = {
    template: pick(d.template, ENUM.template, D.template, 'テンプレート'),
    background: {
      metal: pick(b.metal, ENUM.metal, D.background.metal, 'メタリックの種類'), type: pick(b.type, ENUM.bgType, D.background.type, '背景の種類'), color1: color(b.color1, D.background.color1, '背景色1'), color2: color(b.color2, D.background.color2, '背景色2'),
      angle: num(b.angle, D.background.angle, 0, 360, '背景の角度'), imageId: img(b.imageId, '背景'), overlay: num(b.overlay, D.background.overlay, 0, 80, '背景の暗さ'),
    },
    bands: D.bands.map((def, i) => { const x = Array.isArray(d.bands) ? d.bands[i] ?? {} : {}; return { show: bool(x.show, def.show), color: color(x.color, def.color, `帯${i + 1}の色`), size: pick(x.size, ENUM.size, def.size, `帯${i + 1}の太さ`) }; }),
    textColor: color(d.textColor, D.textColor, '文字色'), accentColor: color(d.accentColor, D.accentColor, 'アクセント色'),
    shopName: { show: bool(sn.show, D.shopName.show), text: text(sn.text, D.shopName.text, 30, '店舗名'), size: pick(sn.size, ENUM.size, D.shopName.size, '店舗名の大きさ'), align: pick(sn.align, ENUM.align, D.shopName.align, '店舗名の位置') },
    title: text(d.title, D.title, 24, 'カードのタイトル'),
    logo: { imageId: img(lg.imageId, 'ロゴ'), position: pick(lg.position, ENUM.pos, D.logo.position, 'ロゴの位置'), size: pick(lg.size, ENUM.size, D.logo.size, 'ロゴの大きさ') },
    fields: { name: bool(f.name, D.fields.name), reading: bool(f.reading, D.fields.reading), nameOrder: pick(f.nameOrder, ENUM.nameOrder, D.fields.nameOrder, '氏名の並び順'), registeredAt: bool(f.registeredAt, D.fields.registeredAt), lastVisit: bool(f.lastVisit, D.fields.lastVisit), visitCount: bool(f.visitCount, D.fields.visitCount) },
    qrBack: { x: num(d.qrBack?.x, D.qrBack.x, -40, 40, 'QRの横の位置'), y: num(d.qrBack?.y, D.qrBack.y, -40, 40, 'QRの縦の位置'), size: pick(d.qrBack?.size, ENUM.size, D.qrBack.size, 'QRの大きさ'), label: bool(d.qrBack?.label, D.qrBack.label) },
    qr: pick(d.qr, ENUM.qr, D.qr, 'QRコードの位置'), radius: pick(d.radius, ENUM.radius, D.radius, '角の丸み'), font: pick(d.font, ENUM.font, D.font, '書体'),
    page: { accentColor: color(pg.accentColor, D.page.accentColor, 'ボタンの色'), backgroundColor: color(pg.backgroundColor, D.page.backgroundColor, '画面の背景色'),
      welcomeText: text(pg.welcomeText, D.page.welcomeText, 120, 'メッセージ'), showInfoList: bool(pg.showInfoList, D.page.showInfoList), showShopcard: bool(pg.showShopcard, D.page.showShopcard), showNotice: bool(pg.showNotice, D.page.showNotice) },
  };
  if (out.background.type === 'image' && !out.background.imageId) errors.push('背景に画像を使う場合は、画像をアップロードしてください');
  if (errors.length) throw new ValidationError('会員証デザインに誤りがあります', errors);
  return out;
}

export class CardService {
  constructor(store) { this.store = store; }

  get(tenantId) {
    const row = this.store.find('card_designs', (r) => r.tenant_id === tenantId);
    // 保存済みの値も毎回正規化 (将来の項目追加でも欠けた値は既定値で補われる)
    return { design: normalizeDesign(row?.config ?? {}, { hasAsset: (id) => this.#exists(tenantId, id) }), version: Number(row?.version) || 0, updated_at: row?.updated_at ?? null };
  }
  #exists(tenantId, id) { return !!this.store.find('card_assets', (a) => a.tenant_id === tenantId && a.asset_id === id); }
  assets(tenantId) {
    const seen = new Map();
    for (const a of this.store.select('card_assets', (r) => r.tenant_id === tenantId && Number(r.chunk) === 0)) seen.set(a.asset_id, { id: a.asset_id, kind: a.kind, mime: a.mime, size: Number(a.size), created_at: a.created_at });
    return [...seen.values()];
  }

  save(actor, tenantId, input) {
    require_(actor, 'CARD_DESIGN', tenantId);
    const design = normalizeDesign(input, { hasAsset: (id) => this.#exists(tenantId, id) }); // 他店舗の画像IDは存在扱いにならない
    const cur = this.store.find('card_designs', (r) => r.tenant_id === tenantId);
    const row = { tenant_id: tenantId, config: design, version: (Number(cur?.version) || 0) + 1, updated_at: new Date().toISOString(), updated_by: actor.id };
    if (cur) this.store.update('card_designs', (r) => r.tenant_id === tenantId, row); else this.store.insert('card_designs', row);
    this.#gc(tenantId, design);
    audit(this.store, { tenant_id: tenantId, actor, action: 'CARD_DESIGN_UPDATE', target: 'card', detail: { version: row.version, template: design.template } });
    return { design, version: row.version };
  }
  // 使われていない古い画像(アップロード後1時間以上)を削除。保存直後の別操作のアップロードは消さない。
  #gc(tenantId, design) {
    const used = new Set([design.logo.imageId, design.background.imageId].filter(Boolean));
    const old = Date.now() - 3600_000;
    for (const a of this.assets(tenantId)) if (!used.has(a.id) && Date.parse(a.created_at) < old) this.store.remove('card_assets', (r) => r.tenant_id === tenantId && r.asset_id === a.id);
  }

  addAsset(actor, tenantId, { kind, mime, data }) {
    require_(actor, 'CARD_DESIGN', tenantId);
    if (!['logo', 'background'].includes(kind)) throw new ValidationError('画像の種類が不正です');
    if (!MIMES[mime]) throw new ValidationError('PNG / JPEG / WebP の画像のみアップロードできます');
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ValidationError('画像データが不正です');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_ASSET_BYTES) throw new ValidationError(`画像が大きすぎます(${Math.round(MAX_ASSET_BYTES / 1000)}KBまで)`);
    if (!MIMES[mime](buf)) throw new ValidationError('画像の形式が正しくありません');
    if (this.assets(tenantId).length >= MAX_ASSETS) throw new ValidationError(`画像は${MAX_ASSETS}枚までです。使っていない画像を削除してください`);
    const id = randomUUID().replace(/-/g, '');
    const b64 = buf.toString('base64'), total = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < total; i++) this.store.insert('card_assets', { asset_id: id, tenant_id: tenantId, kind, mime, chunk: i, total, size: buf.length, data: b64.slice(i * CHUNK, (i + 1) * CHUNK), created_at: new Date().toISOString() });
    audit(this.store, { tenant_id: tenantId, actor, action: 'CARD_ASSET_ADD', target: id, detail: { kind, size: buf.length } });
    return { id, kind, mime, size: buf.length };
  }
  getAsset(tenantId, id) {
    const rows = this.store.select('card_assets', (a) => a.tenant_id === tenantId && a.asset_id === id).sort((a, b) => Number(a.chunk) - Number(b.chunk));
    if (!rows.length || rows.length !== Number(rows[0].total)) return null;
    return { mime: rows[0].mime, buffer: Buffer.from(rows.map((r) => r.data).join(''), 'base64') };
  }
  deleteAsset(actor, tenantId, id) {
    require_(actor, 'CARD_DESIGN', tenantId);
    const { design } = this.get(tenantId);
    if ([design.logo.imageId, design.background.imageId].includes(id)) throw new ValidationError('使用中の画像は削除できません。先にデザインから外して保存してください');
    if (!this.store.remove('card_assets', (a) => a.tenant_id === tenantId && a.asset_id === id)) throw new ValidationError('画像が見つかりません');
    audit(this.store, { tenant_id: tenantId, actor, action: 'CARD_ASSET_REMOVE', target: id });
  }
}
