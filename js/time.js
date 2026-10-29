// 伍伴 Wuplet — 時間規則（一律用台灣時間 UTC+8，不用手機或伺服器的時區）
//
// 任務日 = 台灣時間「現在減 2 小時」的日期，所以 00:00–02:00 還算前一天的晚上。
// 時段：早 06:00–11:00、中 11:00–17:00、晚 17:00–隔天 02:00；02:00–06:00 當成新一天的早上。
// 一週是週一到週日（依任務日），所以週一 02:00 進入新的一週。

const TZ_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const WEEKDAY_ZH = ['一', '二', '三', '四', '五', '六', '日'];

let overrideMs = null;

/** 測試用：把「現在」假設成某個時間（只在管理者或示範模式使用）。傳 null 取消。 */
export function setNowOverride(ms) {
  overrideMs = ms == null || Number.isNaN(ms) ? null : ms;
}
export function getNowOverride() {
  return overrideMs;
}
export function nowMs() {
  return overrideMs != null ? overrideMs : Date.now();
}

const pad = (n) => String(n).padStart(2, '0');

function taipei(ms) {
  return new Date(ms + TZ_MS); // 之後一律用 getUTC* 讀，等於台灣時間
}

function ymd(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 現在的任務日，例如 '2026-11-04' */
export function questDate(ms = nowMs()) {
  return ymd(taipei(ms - 2 * HOUR_MS));
}

/** 台灣時間的小時（含小數），例如 12.5 = 12:30 */
export function taipeiHour(ms = nowMs()) {
  const d = taipei(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/** 'morning' | 'midday' | 'evening'。02:00–06:00 當成早上。 */
export function windowOf(ms = nowMs()) {
  const h = taipeiHour(ms);
  if (h >= 11 && h < 17) return 'midday';
  if (h >= 17 || h < 2) return 'evening';
  return 'morning';
}

export function addDays(dateStr, n) {
  return ymd(new Date(parseYmd(dateStr) + n * DAY_MS));
}

/** b 減 a 的天數 */
export function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);
}

/** 1 = 週一 … 7 = 週日 */
export function weekdayOf(dateStr) {
  const wd = new Date(parseYmd(dateStr)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function weekStartOf(dateStr) {
  return addDays(dateStr, 1 - weekdayOf(dateStr));
}

export function currentWeekStart(ms = nowMs()) {
  return weekStartOf(questDate(ms));
}

export function prevWeekStart(weekStart) {
  return addDays(weekStart, -7);
}

/** 這一週的第幾天（1–7） */
export function dayIndex(dateStr, weekStart) {
  return diffDays(weekStart, dateStr) + 1;
}

/** 一週開始的那一刻：週一 02:00（台灣時間），回傳 epoch 毫秒 */
export function weekBoundaryMs(weekStart) {
  return parseYmd(weekStart) + 2 * HOUR_MS - TZ_MS;
}

export function hoursSince(ms, ref = nowMs()) {
  if (ms == null) return Infinity;
  return (ref - ms) / HOUR_MS;
}

/** '12:30'（台灣時間） */
export function formatHM(ms = nowMs()) {
  const d = taipei(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** '11/4（三）' */
export function formatMD(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${WEEKDAY_ZH[weekdayOf(dateStr) - 1]}）`;
}

/** 把 'YYYY-MM-DDTHH:mm'（當作台灣時間）轉成 epoch 毫秒；格式不對回傳 null */
export function parseTaipeiLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - TZ_MS;
}

/** epoch 毫秒 → 'YYYY-MM-DDTHH:mm'（台灣時間），給輸入框用 */
export function toTaipeiLocal(ms) {
  const d = taipei(ms);
  return `${ymd(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
