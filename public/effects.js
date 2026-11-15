// ランクアップ演出。会員の画面(本番)と、管理画面のプレビューで同じものを使う。
// playRankUp({ kind, seconds, title, stars, starColor }) → 演出が終わる(またはタップで閉じる)と解決する Promise
export const EFFECT_KINDS = { confetti: '紙吹雪', flash: '光・フラッシュ', badge: 'バッジ出現', grand: '豪華な特別演出' };

const COLORS = ['#f5b301', '#ffd54a', '#ff7a45', '#ff4d8d', '#4cc9f0', '#7bd88f', '#fff2b3'];
const mk = (tag, css, text) => { const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; return e; };

function confetti(layer, ms, n) {
  const c = mk('canvas', 'position:absolute;inset:0;width:100%;height:100%'), W = (c.width = innerWidth), H = (c.height = innerHeight), g = c.getContext('2d');
  layer.append(c);
  const ps = Array.from({ length: n }, () => ({ x: Math.random() * W, y: -20 - Math.random() * H * 0.6, w: 6 + Math.random() * 7, h: 9 + Math.random() * 9, vx: (Math.random() - 0.5) * 2.4, vy: 2 + Math.random() * 3.4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, col: COLORS[(Math.random() * COLORS.length) | 0], ph: Math.random() * 6 }));
  const t0 = performance.now(); let raf;
  const tick = (t) => {
    const el = t - t0; g.clearRect(0, 0, W, H);
    const fade = el > ms - 700 ? Math.max(0, (ms - el) / 700) : 1; g.globalAlpha = fade;
    for (const p of ps) { p.x += p.vx + Math.sin(el / 400 + p.ph) * 0.8; p.y += p.vy; p.r += p.vr; g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.col; g.scale(1, Math.abs(Math.cos(p.r * 2)) * 0.8 + 0.2); g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore(); }
    if (el < ms) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

function flash(layer, ms) {
  const rays = mk('div', 'position:absolute;left:50%;top:42%;width:150vmax;height:150vmax;margin:-75vmax 0 0 -75vmax;opacity:0;background:repeating-conic-gradient(from 0deg,rgba(255,236,150,.55) 0 6deg,rgba(255,236,150,0) 6deg 18deg);-webkit-mask-image:radial-gradient(circle,#000 0,transparent 55%);mask-image:radial-gradient(circle,#000 0,transparent 55%)');
  const glow = mk('div', 'position:absolute;inset:0;opacity:0;background:radial-gradient(circle at 50% 42%,#fff 0,rgba(255,236,150,.85) 18%,rgba(255,200,60,.0) 60%)');
  layer.append(glow, rays);
  glow.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 0.55, offset: 0.4 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
  rays.animate([{ opacity: 0, transform: 'rotate(0) scale(.6)' }, { opacity: 1, offset: 0.2 }, { opacity: 0, transform: 'rotate(50deg) scale(1.1)' }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
}

export const BADGE_SHAPES = { circle: 'メダル', seal: 'ロゼット', shield: '盾', ribbon: 'リボン付きメダル', star: '星' };
const mix = (hex, to, t) => { const n = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const a = n(hex), b = n(to); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const pts = (n, f) => Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2 - Math.PI / 2, r = f(i, t); return `${(100 + r * Math.cos(t)).toFixed(1)},${(100 + r * Math.sin(t)).toFixed(1)}`; }).join(' ');
const SHAPES = {
  circle: (o) => `<circle cx="100" cy="100" r="94" fill="url(#r${o.id})"/><circle cx="100" cy="100" r="80" fill="url(#f${o.id})"/><circle cx="100" cy="100" r="70" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.5" stroke-dasharray="2 6" stroke-linecap="round"/>`,
  seal: (o) => `<polygon points="${pts(160, (i, t) => 90 + 7 * Math.cos(t * 16 + Math.PI * 0.5))}" fill="url(#r${o.id})"/><circle cx="100" cy="100" r="76" fill="url(#f${o.id})"/><circle cx="100" cy="100" r="66" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.5"/>`,
  shield: (o) => `<path d="M100 6 L176 28 V98 C176 146 140 178 100 194 C60 178 24 146 24 98 V28 Z" fill="url(#r${o.id})"/><path d="M100 18 L164 36 V98 C164 138 134 166 100 180 C66 166 36 138 36 98 V36 Z" fill="url(#f${o.id})"/><path d="M100 28 L154 43 V98 C154 132 130 156 100 169 C70 156 46 132 46 98 V43 Z" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>`,
  ribbon: (o) => `<path d="M58 140 L34 232 L72 214 L92 238 L104 150 Z" fill="${mix(o.col, '#000000', 0.35)}"/><path d="M142 140 L166 232 L128 214 L108 238 L96 150 Z" fill="${mix(o.col, '#000000', 0.2)}"/><circle cx="100" cy="94" r="84" fill="url(#r${o.id})"/><circle cx="100" cy="94" r="70" fill="url(#f${o.id})"/><circle cx="100" cy="94" r="61" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.5" stroke-dasharray="2 6" stroke-linecap="round"/>`,
  star: (o) => `<polygon points="${pts(10, (i) => (i % 2 ? 50 : 98))}" fill="url(#r${o.id})" stroke="url(#r${o.id})" stroke-width="10" stroke-linejoin="round"/><polygon points="${pts(10, (i) => (i % 2 ? 42 : 80))}" fill="url(#f${o.id})" stroke="url(#f${o.id})" stroke-width="6" stroke-linejoin="round"/>`,
};
let seq = 0;
function medalSvg(b, col, size) {
  const shape = SHAPES[b.shape] ? b.shape : 'circle', ribbon = shape === 'ribbon', id = `b${++seq}`, o = { id, col }, cy = ribbon ? 94 : shape === 'shield' ? 100 : 102;
  const n = [...b.icon].length, fs = Math.max(36, (shape === 'star' ? 62 : shape === 'shield' ? 66 : 76) - (n - 1) * 16);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 ${ribbon ? 244 : 200}" width="${size}" height="${Math.round(size * (ribbon ? 1.22 : 1))}" style="display:block;overflow:visible">
<defs><linearGradient id="r${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mix(col, '#ffffff', 0.75)}"/><stop offset=".45" stop-color="${mix(col, '#ffffff', 0.15)}"/><stop offset="1" stop-color="${mix(col, '#000000', 0.45)}"/></linearGradient>
<radialGradient id="f${id}" cx=".35" cy=".28" r=".95"><stop offset="0" stop-color="${mix(col, '#ffffff', 0.55)}"/><stop offset=".5" stop-color="${col}"/><stop offset="1" stop-color="${mix(col, '#000000', 0.4)}"/></radialGradient></defs>
${SHAPES[shape](o)}
<text x="100" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" fill="#fff" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))">${b.icon.replace(/[<>&]/g, '')}</text></svg>`;
}
function badge(layer, ms, o, big) {
  const b = { label: 'RANK UP!', icon: '★', shape: 'circle', color: '', showTitle: true, showStars: true, ...(o.badge ?? {}) }, col = /^#[0-9a-f]{6}$/i.test(b.color || o.starColor) ? (b.color || o.starColor) : '#f5b301', size = big ? 190 : 156;
  const wrap = mk('div', 'position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);text-align:center;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.55);font-family:sans-serif;pointer-events:none');
  const holder = mk('div', `margin:0 auto;width:${size}px;filter:drop-shadow(0 0 16px ${col}cc)`); holder.innerHTML = medalSvg(b, col, size);
  wrap.append(b.label ? mk('div', 'font-size:14px;letter-spacing:.3em;font-weight:700;margin-bottom:10px', b.label) : '', holder);
  if (b.showTitle) wrap.append(mk('div', `margin-top:10px;font-size:${big ? 30 : 26}px;font-weight:800`, o.title || ''));
  if (b.showStars) wrap.append(mk('div', `margin-top:4px;font-size:16px;letter-spacing:.15em;color:${col}`, '★'.repeat(Math.min(10, o.stars || 1))));
  layer.append(wrap);
  wrap.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1.18)', offset: 0.28 }, { transform: 'translate(-50%,-50%) scale(1)', offset: 0.4 }, { opacity: 1, offset: 0.85 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.05)' }], { duration: ms, fill: 'forwards' });
  if (big) holder.firstElementChild.animate([{ transform: 'rotateY(0)' }, { transform: 'rotateY(360deg)' }], { duration: 1200, easing: 'cubic-bezier(.2,.7,.3,1)' });
}

// 文字だけの控えめな表示(紙吹雪・光の演出で使う。大きなバッジは出さない)
function caption(layer, ms, o) {
  const c = mk('div', 'position:absolute;left:0;right:0;top:40%;text-align:center;color:#fff;font-family:sans-serif;font-weight:800;text-shadow:0 2px 12px rgba(0,0,0,.7);pointer-events:none');
  c.append(mk('div', 'font-size:13px;letter-spacing:.3em', o.badge?.label ?? 'RANK UP!'), mk('div', 'font-size:30px;margin-top:4px', o.title || ''), mk('div', `font-size:15px;letter-spacing:.2em;margin-top:2px;color:${o.starColor || '#ffd54a'}`, '★'.repeat(Math.min(10, o.stars || 1))));
  layer.append(c);
  c.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none', offset: 0.18 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
}

export function playRankUp(o, host = document.body) {
  return new Promise((resolve) => {
    const ms = Math.max(2, Math.min(10, Number(o.seconds) || 4)) * 1000, reduce = !o.force && matchMedia?.('(prefers-reduced-motion: reduce)').matches; // 端末の「動きを減らす」設定のときは、バッジだけ(管理画面のプレビューは常に本来の演出)
    const kind = reduce ? 'badge' : (EFFECT_KINDS[o.kind] ? o.kind : 'confetti');
    const layer = mk('div', 'position:fixed;inset:0;z-index:99999;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent');
    const stops = []; let done = false;
    const end = () => { if (done) return; done = true; stops.forEach((f) => f()); layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).onfinish = () => { layer.remove(); resolve(); }; };
    if (kind === 'grand') layer.style.background = 'radial-gradient(circle at 50% 42%,rgba(20,14,0,.55),rgba(0,0,0,.8))';
    else if (kind === 'badge') layer.style.background = 'rgba(0,0,0,.45)';
    host.append(layer);
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    if (kind === 'confetti') { stops.push(confetti(layer, ms, 170)); caption(layer, ms, o); }
    if (kind === 'flash') { flash(layer, ms); layer.style.background = 'rgba(0,0,0,.25)'; caption(layer, ms, o); }
    if (kind === 'badge') badge(layer, ms, o, false);
    if (kind === 'grand') { flash(layer, ms); stops.push(confetti(layer, ms, 260)); badge(layer, ms, o, true); }
    layer.addEventListener('click', end);
    setTimeout(end, ms + 100);
  });
}
