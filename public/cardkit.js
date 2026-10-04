// 会員証カードの描画 (会員画面・管理画面のプレビュー・画像保存で共通)。
// Canvas に直接描くので、表示と「画像として保存」が同じ見た目になる。HTML文字列は使わない。
export const CARD_W = 1000, CARD_H = 630;
const P = 56; // 余白
const FONTS = {
  sans: '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif',
  serif: '"Hiragino Mincho ProN","Noto Serif JP","Yu Mincho","MS PMincho",serif',
};
const RADIUS = { none: 0, small: 28, large: 56 };
const SIZES = { shop: { S: 40, M: 54, L: 72 }, logo: { S: 70, M: 100, L: 140 } };

// テンプレート (背景・色・角・書体だけを上書きする。ロゴ・文言・表示項目は保持)
export const PRESETS = {
  classic: { label: 'クラシック', design: { background: { type: 'gradient', color1: '#14213d', color2: '#233a6b', angle: 135, overlay: 0 }, textColor: '#ffffff', accentColor: '#fca311', radius: 'large', font: 'serif', page: { accentColor: '#233a6b', backgroundColor: '#f4f5f7' } } },
  dark: { label: 'ダーク', design: { background: { type: 'gradient', color1: '#0f0f10', color2: '#2d2d33', angle: 160, overlay: 0 }, textColor: '#ffffff', accentColor: '#06c755', radius: 'large', font: 'sans', page: { accentColor: '#06c755', backgroundColor: '#111114' } } },
  minimal: { label: 'ミニマル', design: { background: { type: 'solid', color1: '#ffffff', color2: '#ffffff', angle: 0, overlay: 0 }, textColor: '#111111', accentColor: '#111111', radius: 'small', font: 'sans', page: { accentColor: '#111111', backgroundColor: '#ffffff' } } },
  sakura: { label: 'サクラ', design: { background: { type: 'gradient', color1: '#ff9a9e', color2: '#fad0c4', angle: 120, overlay: 0 }, textColor: '#5a1a2b', accentColor: '#c2185b', radius: 'large', font: 'sans', page: { accentColor: '#e91e63', backgroundColor: '#fff5f7' } } },
  forest: { label: 'フォレスト', design: { background: { type: 'gradient', color1: '#134e5e', color2: '#71b280', angle: 135, overlay: 0 }, textColor: '#ffffff', accentColor: '#ffd54f', radius: 'large', font: 'sans', page: { accentColor: '#2e7d32', backgroundColor: '#f1f8f2' } } },
  photo: { label: '写真', design: { background: { type: 'image', overlay: 35 }, textColor: '#ffffff', accentColor: '#ffffff', radius: 'large', font: 'sans', page: { accentColor: '#333333', backgroundColor: '#f4f5f7' } } },
};

// メタリック(金属調): 光の反射を模した多段のグラデーション。text は読みやすい文字色、accent は線の色
export const METALS = {
  gold: { label: 'ゴールド', stops: ['#8f6410', '#e9c34b', '#fff4b8', '#c99a2e', '#f6df7a', '#a87b13', '#fbe9a0', '#8f6410'], text: '#2b2100', accent: '#7a5200', page: '#a87b13' },
  silver: { label: 'シルバー', stops: ['#8d94a3', '#d9dde5', '#ffffff', '#b4bac7', '#eef0f4', '#9aa1b0', '#f4f6f9', '#8d94a3'], text: '#1f2430', accent: '#4b5565', page: '#6b7385' },
  bronze: { label: 'ブロンズ', stops: ['#6e3d17', '#c98a4b', '#f0b987', '#a8672f', '#e0a066', '#80481c', '#e8b07c', '#6e3d17'], text: '#2a1608', accent: '#4a2810', page: '#8a5426' },
  platinum: { label: 'プラチナ', stops: ['#7d8895', '#cfd8e3', '#f8fbff', '#aab6c4', '#e6edf5', '#8794a3', '#f1f6fb', '#7d8895'], text: '#1c2530', accent: '#3b4a5c', page: '#5f6d7e' },
  rosegold: { label: 'ローズゴールド', stops: ['#9a5a54', '#e8b4a8', '#ffe3da', '#c9867b', '#f4cabd', '#a8645c', '#ffdacf', '#9a5a54'], text: '#3b1a1a', accent: '#6b2f2b', page: '#b0675d' },
  chrome: { label: 'ブラッククローム', stops: ['#0b0b0d', '#3a3d45', '#8a8f9b', '#1a1b20', '#4a4e58', '#0f1013', '#6e7380', '#0b0b0d'], text: '#f1f1f1', accent: '#c9ced8', page: '#2a2c33' },
};
for (const [k, m] of Object.entries(METALS)) PRESETS[`metal_${k}`] = { label: m.label, design: { background: { type: 'metal', metal: k, angle: 135, overlay: 0 }, textColor: m.text, accentColor: m.accent, radius: 'large', font: 'sans', page: { accentColor: m.page, backgroundColor: '#f4f5f7' } } };

// #RRGGBB の上に載せる文字色 (黒 or 白)
export function contrast(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
}
const dayFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
export const fmtDay = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? dayFmt.format(new Date(iso)) : null);

export function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めません')); i.src = url; });
}
// QR (qrcodejs) を canvas として得る
export function makeQr(text, size = 200) {
  if (!window.QRCode) return null;
  const box = document.createElement('div');
  new window.QRCode(box, { text, width: size, height: size });
  return box.querySelector('canvas');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// 会員番号を伏せる (下3桁だけ表示)
const maskNumber = (n) => { const t = String(n ?? ''); return `${'•'.repeat(Math.max(0, t.length - 3))}${t.slice(-3)}`; };
// 幅に収まるよう末尾を「…」で省略
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text; while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
// 字間つきで描画 (ctx.letterSpacing 非対応の端末でも同じ見た目にするため1文字ずつ)
function spaced(ctx, text, x, y, gap, align = 'left') {
  const chars = [...text];
  const total = chars.reduce((w, c) => w + ctx.measureText(c).width + gap, -gap);
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  const prev = ctx.textAlign; ctx.textAlign = 'left';
  for (const c of chars) { ctx.fillText(c, cx, y); cx += ctx.measureText(c).width + gap; }
  ctx.textAlign = prev;
  return total;
}
function drawMetal(ctx, bg) {
  const m = METALS[bg.metal] ?? METALS.gold, a = (((bg.angle ?? 135) - 90) * Math.PI) / 180, len = Math.abs(CARD_W * Math.cos(a)) + Math.abs(CARD_H * Math.sin(a));
  const cx = CARD_W / 2, cy = CARD_H / 2, dx = (Math.cos(a) * len) / 2, dy = (Math.sin(a) * len) / 2;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  m.stops.forEach((c, i) => g.addColorStop(i / (m.stops.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  // ヘアライン(ブラシ仕上げ): 毎回同じ模様になるよう、決まった乱数で細い横線を重ねる
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < CARD_H; y += 2) { ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${0.02 + rnd() * 0.05})` : `rgba(0,0,0,${0.02 + rnd() * 0.05})`; ctx.fillRect(0, y, CARD_W, 1); }
  const s = ctx.createLinearGradient(0, 0, CARD_W, CARD_H); // 斜めの強い反射
  s.addColorStop(0.32, 'rgba(255,255,255,0)'); s.addColorStop(0.42, 'rgba(255,255,255,0.28)'); s.addColorStop(0.5, 'rgba(255,255,255,0)'); s.addColorStop(0.72, 'rgba(255,255,255,0.16)'); s.addColorStop(0.8, 'rgba(255,255,255,0)');
  ctx.fillStyle = s; ctx.fillRect(0, 0, CARD_W, CARD_H);
}
// 横の帯(上・中・下)。背景の上、文字やロゴの下に描く
const BAND = { thick: { S: 10, M: 22, L: 40 }, y: [120, 345, CARD_H - 30] };
function drawBands(ctx, bands = []) {
  bands.forEach((b, i) => { if (!b?.show) return; const h = BAND.thick[b.size] ?? 22; ctx.fillStyle = b.color; ctx.fillRect(0, BAND.y[i] - h / 2, CARD_W, h); });
}
function drawBackground(ctx, bg, images) {
  if (bg.type === 'metal') { drawMetal(ctx, bg); return; }
  if (bg.type === 'image' && images.bg) {
    const im = images.bg, s = Math.max(CARD_W / im.width, CARD_H / im.height), w = im.width * s, h = im.height * s;
    ctx.drawImage(im, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
    if (bg.overlay > 0) { ctx.fillStyle = `rgba(0,0,0,${bg.overlay / 100})`; ctx.fillRect(0, 0, CARD_W, CARD_H); }
  } else if (bg.type === 'gradient' || bg.type === 'image') {
    const a = ((bg.angle - 90) * Math.PI) / 180, len = Math.abs(CARD_W * Math.cos(a)) + Math.abs(CARD_H * Math.sin(a));
    const cx = CARD_W / 2, cy = CARD_H / 2, dx = (Math.cos(a) * len) / 2, dy = (Math.sin(a) * len) / 2;
    const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy); g.addColorStop(0, bg.color1); g.addColorStop(1, bg.color2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  } else { ctx.fillStyle = bg.color1; ctx.fillRect(0, 0, CARD_W, CARD_H); }
  const shine = ctx.createRadialGradient(CARD_W * 0.85, -80, 20, CARD_W * 0.85, -80, 700); // 控えめな光沢
  shine.addColorStop(0, 'rgba(255,255,255,0.14)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine; ctx.fillRect(0, 0, CARD_W, CARD_H);
}

// 氏名の並び順: 'swap' は、空白で区切られた姓と名を入れ替える (山田 太郎 → 太郎 山田)。空白がなければそのまま
// 姓・名が別項目のときは parts({family, given}) から組み立てる。'asis' は 姓 名、'swap' は 名 姓
export const cardName = (data, order) => { const p = data.nameParts; if (p && (p.family || p.given)) return (order === 'swap' ? [p.given, p.family] : [p.family, p.given]).filter(Boolean).join(' '); return formatName(data.name, order); };
export const formatName = (name, order) => { const parts = String(name ?? '').trim().split(/[\s\u3000]+/).filter(Boolean); return order === 'swap' && parts.length > 1 ? parts.reverse().join(' ') : parts.join(' '); };
// data: { shop, name, memberNumber, registeredAt, lastVisitAt, visitCount }
// images: { logo, bg } (読み込み済みの Image)。qr: canvas (qr==='inside' のときのみ描画)
// privacy: true のとき、氏名・来店情報を出さず、会員番号を伏せ、QRの代わりに「非表示」の枠を描く (人に画面を見られるとき用)
export function drawCard(canvas, design, data, { logo = null, bg = null, qr = null, privacy = false } = {}) {
  canvas.width = CARD_W; canvas.height = CARD_H;
  // ランクにカード色が設定されていれば、背景(画像以外)をその色にする。文字色は背景に合わせて白/黒を自動で選ぶ
  const rank = data.rank ?? null, rankMetal = !!(rank?.metal && METALS[rank.metal] && design.background.type !== 'image'), recolor = rankMetal || !!(rank?.color1 && design.background.type !== 'image');
  const bgCfg = rankMetal ? { ...design.background, type: 'metal', metal: rank.metal } : recolor ? { ...design.background, type: 'gradient', color1: rank.color1, color2: rank.color2 || rank.color1, angle: design.background.angle ?? 135 } : design.background;
  const ctx = canvas.getContext('2d'), font = FONTS[design.font] ?? FONTS.sans, tc = rankMetal ? METALS[rank.metal].text : recolor ? contrast(rank.color1) : design.textColor, accent = design.accentColor;
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  ctx.save(); roundRect(ctx, 0, 0, CARD_W, CARD_H, RADIUS[design.radius] ?? 56); ctx.clip();
  drawBackground(ctx, bgCfg, { bg });
  drawBands(ctx, design.bands);
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = tc;

  // ---- 上段: ロゴ と タイトル ----
  const pos = design.logo.position; let topBottom = P;
  if (logo && design.logo.imageId) {
    const h = SIZES.logo[design.logo.size], w = Math.min(320, (logo.width / logo.height) * h), hh = w / (logo.width / logo.height);
    const x = pos === 'top-left' ? P : pos === 'top-right' ? CARD_W - P - w : (CARD_W - w) / 2;
    ctx.drawImage(logo, x, P, w, hh); topBottom = P + hh;
  }
  if (design.title) {
    ctx.font = `600 26px ${font}`; ctx.fillStyle = tc; ctx.globalAlpha = 0.85;
    if (pos === 'top-center' && logo && design.logo.imageId) spaced(ctx, design.title, CARD_W / 2, topBottom + 40, 5, 'center');
    else spaced(ctx, design.title, pos === 'top-left' && design.logo.imageId ? CARD_W - P : P, P + 30, 5, pos === 'top-left' && design.logo.imageId ? 'right' : 'left');
    ctx.globalAlpha = 1;
  }

  // ---- ランク: 右上に「★★★ 称号」 (★はランクが上がるごとに増える。ロゴが右上のときはその下) ----
  if (rank) {
    const ry = pos === 'top-right' && logo && design.logo.imageId ? topBottom + 46 : P + 30;
    ctx.font = `700 30px ${font}`; ctx.fillStyle = tc; ctx.textAlign = 'right';
    const tw = ctx.measureText(rank.title).width; ctx.fillText(rank.title, CARD_W - P, ry);
    ctx.fillStyle = rank.starColor; ctx.font = `700 34px ${font}`; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 3;
    ctx.fillText('★'.repeat(Math.min(rank.stars, 10)), CARD_W - P - tw - 14, ry + 2);
    ctx.shadowBlur = 0; ctx.textAlign = 'left'; ctx.fillStyle = tc;
  }

  // ---- 中段: 店舗名 + アクセント線 ----
  const insideQr = design.qr === 'inside' && (qr || privacy);
  const textMaxW = insideQr ? CARD_W - P * 2 - 240 : CARD_W - P * 2;
  if (design.shopName.show) {
    const size = SIZES.shop[design.shopName.size], text = design.shopName.text || data.shop || '';
    ctx.font = `700 ${size}px ${font}`; ctx.fillStyle = tc;
    const y = 290, center = design.shopName.align === 'center', x = center ? CARD_W / 2 : P;
    ctx.textAlign = center ? 'center' : 'left'; ctx.fillText(fit(ctx, text, CARD_W - P * 2), x, y);
    ctx.fillStyle = accent; ctx.fillRect(center ? CARD_W / 2 - 40 : P, y + 22, 80, 6); ctx.textAlign = 'left';
  }

  // ---- 下段: 会員番号 / 氏名 / 補足 (下から積む) ----
  const extras = [];
  if (!privacy && design.fields.registeredAt && data.registeredAt) extras.push(`登録 ${fmtDay(data.registeredAt) ?? ''}`);
  if (!privacy && design.fields.lastVisit) extras.push(data.lastVisitAt ? `最終来店 ${fmtDay(data.lastVisitAt) ?? ''}` : '最終来店 -');
  if (!privacy && design.fields.visitCount) extras.push(`来店 ${data.visitCount ?? 0}回`);
  ctx.font = `500 30px ${font}`; ctx.fillStyle = tc;
  const lines = []; let cur = '';
  for (const e of extras) { const t = cur ? `${cur}   ${e}` : e; if (cur && ctx.measureText(t).width > textMaxW) { lines.push(cur); cur = e; } else cur = t; }
  if (cur) lines.push(cur);
  let y = CARD_H - P;
  ctx.globalAlpha = 0.9;
  for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(fit(ctx, lines[i], textMaxW), P, y); y -= 44; }
  ctx.globalAlpha = 1;
  if (!privacy && design.fields.name && (data.name || data.nameParts)) { ctx.font = `600 44px ${font}`; ctx.fillText(fit(ctx, cardName(data, design.fields.nameOrder), textMaxW), P, y); y -= 70; }
  ctx.font = `700 84px ${font}`; ctx.fillStyle = tc; spaced(ctx, privacy ? maskNumber(data.memberNumber) : String(data.memberNumber ?? ''), P, y, 8);
  ctx.font = `500 24px ${font}`; ctx.globalAlpha = 0.8; spaced(ctx, 'MEMBER No.', P, y - 84 - 14, 3); ctx.globalAlpha = 1;

  // ---- QR (カード内) ----
  if (insideQr) {
    const s = 190, pad = 14, x = CARD_W - P - s - pad * 2, yy = CARD_H - P - s - pad * 2;
    ctx.fillStyle = '#ffffff'; roundRect(ctx, x, yy, s + pad * 2, s + pad * 2, 16); ctx.fill();
    if (qr && !privacy) ctx.drawImage(qr, x + pad, yy + pad, s, s);
    else { ctx.fillStyle = '#888888'; ctx.font = `600 26px ${font}`; ctx.textAlign = 'center'; ctx.fillText('QRコード', x + pad + s / 2, yy + pad + s / 2 - 6); ctx.fillText('非表示中', x + pad + s / 2, yy + pad + s / 2 + 30); ctx.textAlign = 'left'; }
  }
  ctx.restore();
}

// 会員画面のテーマ (CSS変数) を反映
export function applyPage(page, root = document.documentElement) {
  root.style.setProperty('--accent', page.accentColor);
  root.style.setProperty('--accent-text', contrast(page.accentColor));
  root.style.setProperty('--page-bg', page.backgroundColor);
  root.style.setProperty('--page-text', contrast(page.backgroundColor));
  root.style.setProperty('--card-bg', contrast(page.backgroundColor) === '#ffffff' ? '#1e1e22' : '#ffffff');
}
