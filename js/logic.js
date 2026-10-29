// 伍伴 Wuplet — 規則（純函式，不碰資料庫，方便測試）
import {
  CAMP_STAGES, STEP_STATUSES, REPORTED_STATUSES, CHAR_IDS, MAX_CREW, MIN_GROUP,
  AWAY_HOURS, SMALL_STEP_PREFIX,
} from './constants.js';
import { hoursSince, nowMs, addDays, diffDays } from './time.js';

/* ---------------- 亂數 ---------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- 營火與步數 ---------------- */

export function countSteps(entries) {
  return entries.filter((e) => e && STEP_STATUSES.includes(e.status)).length;
}

export function campStage(steps) {
  let stage = CAMP_STAGES[0];
  for (const s of CAMP_STAGES) if (steps >= s.min) stage = s;
  return stage;
}

/** 營火畫面：週日結算之後（或一週回顧）用紀念樹 */
export function campImage(steps) {
  return `camp_${campStage(steps).id}`;
}

/* ---------------- 森林 ---------------- */

export function nextForest(f) {
  return (Number(f) % 4) + 1;
}

/* ---------------- 縮小與推薦（規則版 AI 小幫手） ---------------- */

export function smallerMinutes(m) {
  if (m === 20 || m === 15) return 10;
  if (m === 10) return 5;
  return null; // 5 分鐘已經最小
}

/** 把任務縮小一級；已經 5 分鐘時回傳 null */
export function shrinkQuest(quest, templates = []) {
  const minutes = smallerMinutes(quest.minutes);
  if (!minutes) return null;
  const t = quest.templateId ? templates.find((x) => x.id === quest.templateId) : null;
  let title;
  if (t && t.smallerTitle) title = t.smallerTitle;
  else title = String(quest.title || '').startsWith(SMALL_STEP_PREFIX) ? quest.title : SMALL_STEP_PREFIX + quest.title;
  return { ...quest, title, minutes };
}

/** 依類別、時間、能量挑最多 3 個範本，一次只會顯示 1 個 */
export function recommend(templates, { category, minutes, energy }, rng = Math.random) {
  let pool = templates.filter((t) => t.category === category && t.minutes <= (minutes || 20));
  if (energy === 'low') pool = pool.filter((t) => t.minutes <= 10 && t.light);
  return shuffle(pool, rng).slice(0, 3);
}

/* ---------------- 狀態與句子 ---------------- */

export function isAway(user, ref = nowMs()) {
  return hoursSince(user && user.lastSeenAt, ref) > AWAY_HOURS;
}

/** '讀英文' + 20 → '讀英文 20 分鐘'；標題裡已經寫了分鐘就不重複 */
export function questLabel(title, minutes) {
  const t = String(title || '').trim();
  if (!minutes || /\d+\s*分/.test(t)) return t;
  return `${t} ${minutes} 分鐘`;
}

/**
 * 隊友（或自己）今天的樣子：角色圖 state + 一句話。
 * 休息和今天沒做在隊友眼中一模一樣。
 */
export function statusView(entry, { away = false } = {}) {
  if (!entry) {
    return away ? { state: 'away', sentence: '去遠方旅行了' } : { state: 'idle', sentence: '還沒出發' };
  }
  switch (entry.status) {
    case 'setout':
      if (entry.visibility === 'private') return { state: 'private', sentence: '正在進行私人任務' };
      return { state: 'setout', sentence: `出發了：${questLabel(entry.publicTitle, entry.minutes)}` };
    case 'onit':
      return { state: 'onit', sentence: '正在做自己的事' };
    case 'done':
      return { state: 'done', sentence: '帶回了一顆光點' };
    case 'little':
      return { state: 'little', sentence: '帶回了一片葉子' };
    case 'rest':
    case 'not-today':
      return { state: 'rest', sentence: '在營火旁休息' };
    default:
      return { state: 'idle', sentence: '還沒出發' };
  }
}

/* ---------------- 每週配對 ---------------- */

/** 隊數 = 人數 ÷ 5 無條件進位，再平均分配。11 → [4,4,3] */
export function splitSizes(n, max = MAX_CREW) {
  if (n <= 0) return [];
  const k = Math.ceil(n / max);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/** 同隊角色不重複：第一志願 → 第二志願 → 沒人用的角色隨機給。處理順序隨機。 */
export function assignCharacters(memberIds, prefsById, rng = Math.random, taken = []) {
  const used = new Set(taken);
  const out = {};
  const order = shuffle(memberIds, rng);
  order.forEach((uid, idx) => {
    const prefs = (prefsById && prefsById[uid]) || [];
    let c = prefs.find((p) => CHAR_IDS.includes(p) && !used.has(p));
    if (!c) {
      const free = CHAR_IDS.filter((x) => !used.has(x));
      // 隨機給的時候，先避開後面還沒分到的人想要的角色
      const wanted = new Set(order.slice(idx + 1).flatMap((u) => (prefsById && prefsById[u]) || []));
      const polite = free.filter((x) => !wanted.has(x));
      const pool = polite.length ? polite : free;
      c = pool[Math.floor(rng() * pool.length)];
    }
    used.add(c);
    out[uid] = c;
  });
  return out;
}

/** 選一個沒人用的角色給中途加入的人 */
export function pickCharacter(prefs, usedChars, rng = Math.random) {
  const used = new Set(usedChars || []);
  const c = (prefs || []).find((p) => CHAR_IDS.includes(p) && !used.has(p));
  if (c) return c;
  const free = CHAR_IDS.filter((x) => !used.has(x));
  return free.length ? free[Math.floor(rng() * free.length)] : null;
}

/** 不到 3 人的森林併到下一座有人的森林（第 4 座的下一座是第 1 座）；只剩一組就不再併 */
export function mergeSmallGroups(groups, minGroup = MIN_GROUP) {
  const g = { 1: [], 2: [], 3: [], 4: [] };
  for (const f of [1, 2, 3, 4]) g[f] = (groups[f] || []).slice();
  for (let guard = 0; guard < 12; guard++) {
    const nonEmpty = [1, 2, 3, 4].filter((f) => g[f].length > 0);
    if (nonEmpty.length <= 1) break;
    const small = nonEmpty.find((f) => g[f].length < minGroup);
    if (!small) break;
    let t = nextForest(small);
    while (g[t].length === 0) t = nextForest(t);
    g[t] = g[t].concat(g[small]);
    g[small] = [];
  }
  return g;
}

/**
 * 算出這週的分隊（不寫資料庫）。
 * users: [{ uid, prefs, currentForest, crewWeek, lastSeenAt }]
 * 回傳 { crews: [{ forest, members: [uid], chars: {uid: char} }], userForest, excluded }
 */
export function planMatching({ users, prevWeekStart, ref = nowMs(), skips = new Set(), rng = Math.random }) {
  const eligible = [];
  const excluded = [];
  for (const u of users) {
    if (skips.has(u.uid)) excluded.push({ uid: u.uid, reason: 'skip' });
    else if (isAway(u, ref)) excluded.push({ uid: u.uid, reason: 'away' });
    else eligible.push(u);
  }
  const prefsById = {};
  const groups = { 1: [], 2: [], 3: [], 4: [] };
  for (const u of eligible) {
    prefsById[u.uid] = u.prefs || [];
    const cur = [1, 2, 3, 4].includes(u.currentForest) ? u.currentForest : 1;
    // 上週有小隊、這週有回營 → 前進一座；新加入或上週出遠門 → 留在原森林
    const f = u.crewWeek === prevWeekStart ? nextForest(cur) : cur;
    groups[f].push(u.uid);
  }
  const merged = mergeSmallGroups(groups);
  const crews = [];
  const userForest = {};
  for (const f of [1, 2, 3, 4]) {
    const ids = shuffle(merged[f], rng);
    let i = 0;
    for (const size of splitSizes(ids.length)) {
      const members = ids.slice(i, i + size);
      i += size;
      crews.push({ forest: f, members, chars: assignCharacters(members, prefsById, rng) });
      for (const uid of members) userForest[uid] = f;
    }
  }
  return { crews, userForest, excluded };
}

/** 中途回來的人：先找自己森林有空位的小隊，沒有就找下一座。回傳候選清單（人少的優先）。 */
export function openCrewCandidates(crews, forest) {
  const size = (c) => Object.keys(c.members || {}).length;
  const pick = (f) => crews
    .filter((c) => c.forest === f && !c.settled && size(c) < MAX_CREW)
    .sort((a, b) => size(a) - size(b) || String(a.id).localeCompare(String(b.id)));
  return [...pick(forest), ...pick(nextForest(forest))];
}

/* ---------------- 紀念樹光點 ---------------- */

/** n 顆光點的位置（0–1 比例），同一隊每次都一樣 */
export function treeDots(n, seed) {
  const rng = mulberry32(hashString(String(seed)));
  const dots = [];
  for (let i = 0; i < n; i++) {
    const t = rng() * Math.PI * 2;
    const r = Math.sqrt(rng());
    dots.push({
      x: 0.66 + Math.cos(t) * r * 0.25,
      y: 0.27 + Math.sin(t) * r * 0.16,
      s: 0.7 + rng() * 0.6,
      d: rng() * 3,
    });
  }
  return dots;
}

/* ---------------- 測試指標 ---------------- */

const pct = (a, b) => (b ? a / b : null);

function median(nums) {
  const a = nums.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * entries: 每日狀態 [{ uid, date, status, setOutAt, setOutSeconds, crewId }]
 * opens: Set('YYYY-MM-DD_uid')
 * crews: [{ id, weekStart, members: {uid: …} }]
 * today: 今天的任務日（算 Rest-to-Return 時不看未來）
 */
export function computeMetrics({ entries, opens, crews, today }) {
  const crewWeek = {};
  for (const c of crews) crewWeek[c.id] = c.weekStart;
  const weeks = [...new Set(crews.map((c) => c.weekStart))].sort();
  const byWeek = {};
  for (const w of weeks) byWeek[w] = [];
  for (const e of entries) {
    const w = crewWeek[e.crewId];
    if (w && byWeek[w]) byWeek[w].push(e);
  }

  const qsr = (list) => {
    const out = list.filter((e) => e.setOutAt != null);
    return { value: pct(out.filter((e) => STEP_STATUSES.includes(e.status)).length, out.length), n: out.length };
  };

  const awayOn = (uid, date) => !opens.has(`${date}_${uid}`) && !opens.has(`${addDays(date, -1)}_${uid}`);

  const result = weeks.map((w) => {
    const list = byWeek[w];
    const setOut = list.filter((e) => e.setOutAt != null);
    const restish = list.filter((e) => e.status === 'rest' || e.status === 'not-today')
      .filter((e) => !today || diffDays(e.date, today) >= 1);
    const returned = restish.filter((e) => opens.has(`${addDays(e.date, 1)}_${e.uid}`));

    // Crew Impact：有人出遠門的日子 vs 沒有的日子，其他人的 Quest Start Rate
    const withAway = [];
    const withoutAway = [];
    for (const c of crews.filter((x) => x.weekStart === w)) {
      const members = Object.keys(c.members || {});
      for (let d = 0; d < 7; d++) {
        const date = addDays(w, d);
        if (today && diffDays(date, today) < 0) continue;
        const away = members.filter((uid) => awayOn(uid, date));
        const dayEntries = list.filter((e) => e.crewId === c.id && e.date === date && !away.includes(e.uid));
        (away.length ? withAway : withoutAway).push(...dayEntries);
      }
    }
    return {
      weekStart: w,
      questStartRate: qsr(list),
      returnToShare: {
        value: pct(setOut.filter((e) => REPORTED_STATUSES.includes(e.status)).length, setOut.length),
        n: setOut.length,
      },
      timeToSetOut: { value: median(setOut.map((e) => e.setOutSeconds)), n: setOut.length },
      restToReturn: { value: pct(returned.length, restish.length), n: restish.length },
      crewImpact: { withAway: qsr(withAway), withoutAway: qsr(withoutAway) },
    };
  });

  let week2Return = null;
  if (weeks.length >= 2) {
    const setOutUsers = (w) => new Set(byWeek[w].filter((e) => e.setOutAt != null).map((e) => e.uid));
    const w1 = setOutUsers(weeks[0]);
    const w2 = setOutUsers(weeks[1]);
    const back = [...w1].filter((u) => w2.has(u)).length;
    week2Return = { value: pct(back, w1.size), n: w1.size };
  }
  return { weeks: result, week2Return };
}

/* ---------------- CSV ---------------- */

export function toCSV(rows, columns) {
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => cell(c.label || c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n');
}
