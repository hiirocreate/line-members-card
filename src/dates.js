// 日付の計算 (すべて日本時間 JST で扱う。サーバーのタイムゾーンに依存しない)
const JST = 9 * 3600_000;
export const jstParts = (ms = Date.now()) => { const d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400_000);
export const validDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? ''); if (!m) return null; const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3] ? { y: +m[1], m: +m[2], d: +m[3] } : null; };

// 次の誕生日までの日数 (今日が誕生日なら0)。year は、その誕生日が来る年。
// 2月29日生まれは、うるう年でない年は2月28日として扱う。日付が不正・未登録なら null。
export function daysUntilBirthday(birthday, nowMs = Date.now()) {
  const b = validDate(birthday); if (!b) return null;
  const t = jstParts(nowMs), today = dayNum(t.y, t.m, t.d);
  const occ = (y) => (b.m === 2 && b.d === 29 && !isLeap(y) ? dayNum(y, 2, 28) : dayNum(y, b.m, b.d));
  let year = t.y, n = occ(year) - today;
  if (n < 0) { year = t.y + 1; n = occ(year) - today; }
  return { days: n, year };
}
// 今日から n 日後の日付 (YYYY-MM-DD, 日本時間)
export const addDaysJst = (nowMs, n) => { const p = jstParts(nowMs + n * 86400_000); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const endOfDayJst = (day) => Date.parse(`${day}T23:59:59.999+09:00`);
