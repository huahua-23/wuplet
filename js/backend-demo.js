// 伍伴 Wuplet — 示範模式資料層（網址加 ?demo=1）
// 不登入、不連 Firebase，資料只存在這個分頁的記憶體裡，重新整理就回到預設。
import { MAX_CREW } from './constants.js';
import { pickCharacter, mulberry32, hashString } from './logic.js';
import { nowMs, questDate, currentWeekStart, prevWeekStart, addDays, dayIndex, weekBoundaryMs, windowOf } from './time.js';

export const DEMO_ME = 'demo-me';

const TEAM = [
  { uid: DEMO_ME, nickname: '旅人', c: 'sprouty', prefs: ['sprouty', 'leafy'] },
  { uid: 'demo-mia', nickname: 'Mia', c: 'peachi', prefs: ['peachi', 'sunny'] },
  { uid: 'demo-leo', nickname: 'Leo', c: 'leafy', prefs: ['leafy', 'coco'] },
  { uid: 'demo-zhe', nickname: '阿哲', c: 'sunny', prefs: ['sunny', 'peachi'] },
  { uid: 'demo-an', nickname: '小安', c: 'coco', prefs: ['coco', 'sprouty'] },
];

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function seedStore({ scene }) {
  const now = nowMs();
  const today = questDate(now);
  const week = currentWeekStart(now);
  const prev = prevWeekStart(week);
  const store = { users: {}, crews: {}, days: {}, reactions: {}, privates: {}, appOpens: {}, weeks: {}, before: {}, journeys: {} };
  const HOUR = 3600e3;

  // 這一場示範的小隊：一般情況是本週；「週一還沒配對」則是上週
  const crewWeek = scene === 'monday' ? prev : week;
  const crewId = `demo-crew-${crewWeek}`;
  const lastDay = scene === 'monday' ? addDays(prev, 6) : today;

  for (const m of TEAM) {
    store.users[m.uid] = {
      uid: m.uid, nickname: m.nickname, prefs: m.prefs, currentForest: 1,
      crewId, crewWeek, createdAt: weekBoundaryMs(crewWeek) - 3 * 24 * HOUR,
      lastSeenAt: m.uid === 'demo-an' ? now - 72 * HOUR : now - 2 * HOUR, isTest: false,
    };
  }
  if (scene === 'new') delete store.users[DEMO_ME];

  const members = {};
  TEAM.forEach((m, i) => { members[m.uid] = { c: m.c, j: weekBoundaryMs(crewWeek) + i * 60e3 }; });
  store.crews[crewId] = { id: crewId, weekStart: crewWeek, forest: 1, members, chars: TEAM.map((m) => m.c), steps: 0, settled: false };
  store.days[crewId] = {};
  store.reactions[crewId] = {};
  store.weeks[crewWeek] = { weekStart: crewWeek, matchedAt: weekBoundaryMs(crewWeek) + 6 * HOUR, crews: 1 };

  const put = (uid, date, e) => {
    store.days[crewId][`${date}_${uid}`] = {
      id: `${date}_${uid}`, uid, date, crewId, status: e.status, visibility: e.visibility || 'public',
      publicTitle: e.visibility === 'private' ? null : (e.title ?? null), minutes: e.minutes ?? null, energy: e.energy ?? 'normal',
      templateId: null, publicNote: e.note ?? null, setOutAt: e.setOut === false ? null : (e.setOutAt ?? weekBoundaryMs(crewWeek)), setOutSeconds: e.secs ?? 40,
      middayAt: e.middayAt ?? null, updatedAt: now,
    };
  };

  // 之前幾天的紀錄（固定亂數，每次一樣）
  const titles = ['讀英文', '跑步', '整理書桌', '寫論文草稿', '練吉他', '背單字'];
  const pool = ['done', 'done', 'done', 'little', 'little', 'rest', 'not-today', 'done'];
  const days = dayIndex(lastDay, crewWeek);
  const pastUntil = scene === 'monday' ? days : days - 1;
  for (const m of TEAM) {
    for (let d = 1; d <= pastUntil; d++) {
      const date = addDays(crewWeek, d - 1);
      if (m.uid === 'demo-an' && d >= pastUntil - 1 && scene !== 'monday') continue; // 小安最近兩天沒打開
      const rng = mulberry32(hashString(m.uid + date));
      const status = pool[Math.floor(rng() * pool.length)];
      const minutes = [10, 15, 20][Math.floor(rng() * 3)];
      if (status === 'rest') put(m.uid, date, { status, setOut: false });
      else put(m.uid, date, { status, title: titles[Math.floor(rng() * titles.length)], minutes, secs: 20 + Math.floor(rng() * 60) });
      store.appOpens[`${date}_${m.uid}`] = { uid: m.uid, date };
    }
  }

  // 今天的樣子依時段不同
  if (scene !== 'monday') {
    const evening = windowOf(now) === 'evening';
    const midday = windowOf(now) === 'midday';
    put('demo-mia', today, midday || evening ? { status: 'done', title: '跑步', minutes: 15 } : { status: 'setout', title: '跑步', minutes: 15 });
    put('demo-leo', today, evening ? { status: 'little', visibility: 'private', minutes: 20 } : { status: 'setout', visibility: 'private', minutes: 20 });
    store.privates[`demo-leo_${today}`] = { title: '整理求職信' };
    put('demo-zhe', today, { status: 'rest', setOut: false });
    // 自己：早上還沒出發（可以試「出發」）；中午已經出發（可以試「碰面」）；晚上正在做（可以試「回營」）
    const morningAt = weekBoundaryMs(week) + (dayIndex(today, week) - 1) * 24 * HOUR + 6.5 * HOUR; // 今天 08:30
    if (midday) put(DEMO_ME, today, { status: 'setout', title: '讀英文', minutes: 20, setOutAt: morningAt, secs: 35 });
    if (evening) put(DEMO_ME, today, { status: 'onit', title: '讀英文', minutes: 20, setOutAt: morningAt, middayAt: morningAt + 4 * HOUR, secs: 35 });
    if (evening) {
      store.reactions[crewId][`${today}_demo-leo_demo-mia`] = { id: `${today}_demo-leo_demo-mia`, date: today, from: 'demo-leo', to: 'demo-mia', type: 'sparkle', at: now };
    }
    for (const m of TEAM) if (m.uid !== 'demo-an') store.appOpens[`${today}_${m.uid}`] = { uid: m.uid, date: today };
  }

  // 管理頁示範：兩位還沒分隊的人
  store.users['demo-amy'] = { uid: 'demo-amy', nickname: 'Amy', prefs: ['leafy', 'sunny'], currentForest: 1, crewId: null, crewWeek: null, createdAt: now - 26 * HOUR, lastSeenAt: now - HOUR, isTest: false };
  store.users['demo-ken'] = { uid: 'demo-ken', nickname: 'Ken', prefs: ['coco', 'peachi'], currentForest: 1, crewId: null, crewWeek: null, createdAt: now - 30 * HOUR, lastSeenAt: now - 5 * HOUR, isTest: false };
  return store;
}

export function createDemoBackend({ scene = '' } = {}) {
  const store = seedStore({ scene });
  const listeners = new Set();
  let authCb = null;
  let signedIn = true;

  const emit = () => setTimeout(() => { for (const l of [...listeners]) l(); }, 0);
  const watch = (get, cb) => {
    let last;
    const fire = () => {
      const v = get();
      const s = JSON.stringify(v);
      if (s !== last) { last = s; cb(clone(v)); }
    };
    listeners.add(fire);
    setTimeout(fire, 0);
    return () => listeners.delete(fire);
  };
  const authUser = () => (signedIn ? { uid: DEMO_ME, email: 'demo@example.com', displayName: '示範旅人' } : null);

  const api = {
    mode: 'demo',
    sdkVersion: 'demo',
    onAuth(cb) { authCb = cb; setTimeout(() => cb(authUser()), 0); return () => { authCb = null; }; },
    signIn() { signedIn = true; setTimeout(() => authCb && authCb(authUser()), 0); return Promise.resolve(); },
    signOut() { signedIn = false; setTimeout(() => authCb && authCb(null), 0); return Promise.resolve(); },

    watchUser(uid, cb) { return watch(() => store.users[uid] || null, cb); },
    async getUser(uid) { return clone(store.users[uid] || null); },
    async createUser(uid, { nickname, prefs }) {
      store.users[uid] = { uid, nickname, prefs, currentForest: 1, crewId: null, crewWeek: null, createdAt: nowMs(), lastSeenAt: nowMs(), isTest: false };
      emit();
    },
    async updateUser(uid, patch) { Object.assign(store.users[uid], clone(patch)); emit(); },
    async touchPresence(uid, date) {
      if (store.users[uid]) store.users[uid].lastSeenAt = nowMs();
      store.appOpens[`${date}_${uid}`] = { uid, date };
      emit();
    },
    async isAdmin() { return true; },

    watchCrew(crewId, cb) { return watch(() => store.crews[crewId] || null, cb); },
    watchCrewDays(crewId, cb) { return watch(() => Object.values(store.days[crewId] || {}), cb); },
    watchReactions(crewId, date, cb) { return watch(() => Object.values(store.reactions[crewId] || {}).filter((r) => r.date === date), cb); },
    async getCrewDays(crewId) { return clone(Object.values(store.days[crewId] || {})); },
    async getCrew(crewId) { return clone(store.crews[crewId] || null); },
    async createDay(crewId, uid, date, f, { setOut = false } = {}) {
      store.days[crewId] = store.days[crewId] || {};
      store.days[crewId][`${date}_${uid}`] = {
        id: `${date}_${uid}`, uid, date, crewId, status: f.status, visibility: f.visibility || 'public',
        publicTitle: f.publicTitle ?? null, minutes: f.minutes ?? null, energy: f.energy ?? null, templateId: f.templateId ?? null,
        publicNote: null, setOutAt: setOut ? nowMs() : null, setOutSeconds: f.setOutSeconds ?? null, middayAt: null, updatedAt: nowMs(),
      };
      emit();
    },
    async updateDay(crewId, uid, date, patch, { midday = false } = {}) {
      const e = store.days[crewId] && store.days[crewId][`${date}_${uid}`];
      if (!e) throw new Error('no-entry');
      Object.assign(e, clone(patch), { updatedAt: nowMs() }, midday ? { middayAt: nowMs() } : {});
      emit();
    },
    async getPrivate(uid, date) { return clone(store.privates[`${uid}_${date}`] || null); },
    async savePrivate(uid, date, { title, note, templateId }) {
      const k = `${uid}_${date}`;
      store.privates[k] = { ...(store.privates[k] || {}) };
      if (title !== undefined) store.privates[k].title = title;
      if (note !== undefined) store.privates[k].note = note;
      if (templateId !== undefined) store.privates[k].templateId = templateId;
    },
    async setReaction(crewId, r) {
      const id = `${r.date}_${r.from}_${r.to}`;
      store.reactions[crewId][id] = { ...r, id, at: nowMs() };
      emit();
    },
    async removeReaction(crewId, r) { delete store.reactions[crewId][`${r.date}_${r.from}_${r.to}`]; emit(); },
    async getWeekMeta(weekStart) { return clone(store.weeks[weekStart] || null); },
    async listCrewsForWeek(weekStart) { return clone(Object.values(store.crews).filter((c) => c.weekStart === weekStart)); },
    async joinCrew(crewId, uid, prefs, userPatch = {}) {
      const c = store.crews[crewId];
      if (!c) throw new Error('crew-missing');
      if (c.members[uid]) return { char: c.members[uid].c };
      if (Object.keys(c.members).length >= MAX_CREW || c.settled) throw new Error('crew-full');
      const char = pickCharacter(prefs, c.chars);
      if (!char) throw new Error('crew-full');
      c.members[uid] = { c: char, j: nowMs() };
      c.chars.push(char);
      Object.assign(store.users[uid], { crewId, crewWeek: c.weekStart, ...userPatch });
      emit();
      return { char };
    },

    async listUsers() { return clone(Object.values(store.users)); },
    async listAllCrews() { return clone(Object.values(store.crews)); },
    async listCrewReactions(crewId) { return clone(Object.values(store.reactions[crewId] || {})); },
    async listAppOpens() { return clone(Object.entries(store.appOpens).map(([id, v]) => ({ id, ...v }))); },
    async getWeekBefore(weekStart) { return clone(store.before[weekStart] || null); },
    async commitMatching({ weekStart, deleteCrewIds = [], settle = [], crews = [], userUpdates = {}, before = {} }) {
      for (const id of deleteCrewIds) { delete store.crews[id]; delete store.days[id]; delete store.reactions[id]; }
      for (const s of settle) {
        Object.assign(store.crews[s.crewId], { steps: s.steps, settled: true });
        for (const uid of s.members) store.journeys[`${uid}_${s.weekStart}`] = { forest: s.forest, crewId: s.crewId, steps: s.steps };
      }
      for (const c of crews) {
        const members = {};
        for (const [uid, ch] of Object.entries(c.chars)) members[uid] = { c: ch, j: nowMs() };
        store.crews[c.id] = { id: c.id, weekStart, forest: c.forest, members, chars: Object.values(c.chars), steps: 0, settled: false };
        store.days[c.id] = {};
        store.reactions[c.id] = {};
      }
      for (const [uid, patch] of Object.entries(userUpdates)) Object.assign(store.users[uid], clone(patch));
      store.before[weekStart] = clone(before);
      store.weeks[weekStart] = { weekStart, matchedAt: nowMs(), crews: crews.length };
      emit();
    },
    async adminAddMember(crewId, uid, char, crewWeek, forest) {
      const c = store.crews[crewId];
      c.members[uid] = { c: char, j: nowMs() };
      if (!c.chars.includes(char)) c.chars.push(char);
      Object.assign(store.users[uid], { crewId, crewWeek, currentForest: forest });
      emit();
    },
    async createTestUsers(list) {
      for (const u of list) store.users[u.uid] = { uid: u.uid, nickname: u.nickname, prefs: u.prefs, currentForest: 1, crewId: null, crewWeek: null, createdAt: u.createdAt, lastSeenAt: nowMs(), isTest: true };
      emit();
    },
    async seedDays(crewId, entries) {
      for (const e of entries) {
        store.days[crewId][`${e.date}_${e.uid}`] = { id: `${e.date}_${e.uid}`, uid: e.uid, date: e.date, crewId, status: e.status, visibility: e.visibility, publicTitle: e.publicTitle ?? null, minutes: e.minutes ?? null, energy: e.energy ?? null, templateId: null, publicNote: e.publicNote ?? null, setOutAt: e.setOut ? nowMs() : null, setOutSeconds: e.setOutSeconds ?? null, middayAt: null, updatedAt: nowMs() };
      }
      emit();
    },
    async touchTestUsers(uids, date) {
      for (const uid of uids) {
        if (store.users[uid]) store.users[uid].lastSeenAt = nowMs();
        if (date) store.appOpens[`${date}_${uid}`] = { uid, date, at: nowMs() };
      }
      emit();
    },
    async resetAll(progress = () => {}) {
      const n = Object.keys(store.users).length + Object.keys(store.crews).length;
      for (const k of Object.keys(store)) store[k] = {};
      progress('完成');
      emit();
      return n;
    },
  };
  return api;
}
