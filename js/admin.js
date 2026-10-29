// 伍伴 Wuplet — 管理頁
//
// 只有安全規則裡設定的管理者帳號讀得到資料。網址加 ?demo=1 可以用示範資料看看。
// 功能：每週配對（先預覽再寫入）、手動把晚加入的人放進小隊、使用者與小隊一覽、測試指標、匯出 CSV、測試工具。
import { CHAR_IDS, charById, MAX_CREW, MIN_GROUP } from './constants.js';
import {
  nowMs, setNowOverride, getNowOverride, questDate, currentWeekStart, prevWeekStart, addDays, dayIndex,
  formatHM, formatMD, parseTaipeiLocal, toTaipeiLocal, windowOf,
} from './time.js';
import {
  planMatching, countSteps, pickCharacter, openCrewCandidates, computeMetrics, toCSV, statusView, isAway,
  mulberry32, shuffle,
} from './logic.js';
import { createBackend } from './backend.js';
import { esc, avatar, toast, friendlyError } from './ui.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const FAKE_KEY = 'wuplet-fake-now';
const HOUR = 3600e3;
const root = document.getElementById('admin');
const presenceNow = () => (DEMO ? nowMs() : Date.now());

const st = {
  backend: null,
  user: null,
  phase: 'loading', // loading | login | denied | ready | error
  error: '',
  loginError: '',
  forests: [],
  templates: [],
  users: [],
  crews: [],
  meta: null,
  before: null,
  days: {},
  reactions: [],
  opens: [],
  loading: false,
  busy: '',
  progress: '',
  plan: null,
  skips: new Set(),
  addTarget: {},
  confirmRematch: false,
  resetText: '',
  testCount: 11,
  fakeInput: '',
};

/* ================= 小工具 ================= */

const b = () => st.backend;
const forestBy = (order) => st.forests.find((f) => f.order === Number(order)) || { order, zh: `森林 ${order}`, en: '', id: 'mistwhisper' };
const userBy = (uid) => st.users.find((u) => u.uid === uid) || null;
const nick = (uid) => (userBy(uid) && userBy(uid).nickname) || `（${String(uid).slice(0, 6)}）`;
const pct = (m) => (m && m.value != null ? `${Math.round(m.value * 100)}%` : '—');
const fmtTime = (ms) => (ms ? toTaipeiLocal(ms).replace('T', ' ') : '');
const WINDOW_ZH = { morning: '早上', midday: '中午', evening: '晚上' };

function ago(ms) {
  if (!ms) return '從未';
  const h = (presenceNow() - ms) / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分鐘前`;
  if (h < 48) return `${Math.round(h)} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

function byForest(a, c) {
  return a.forest - c.forest || String(a.id).localeCompare(String(c.id));
}

function weekInfo() {
  const ws = currentWeekStart();
  const prev = prevWeekStart(ws);
  const thisCrews = st.crews.filter((c) => c.weekStart === ws).sort(byForest);
  const prevCrews = st.crews.filter((c) => c.weekStart === prev).sort(byForest);
  return { ws, prev, thisCrews, prevCrews };
}

function crewLabel(c) {
  const same = st.crews.filter((x) => x.weekStart === c.weekStart && x.forest === c.forest).sort(byForest);
  const i = same.findIndex((x) => x.id === c.id);
  return `${forestBy(c.forest).zh}・第 ${i + 1} 隊`;
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function randomId(n = 4) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ================= 讀資料 ================= */

async function loadAll() {
  st.loading = true;
  render();
  try {
    const ws = currentWeekStart();
    const [users, crews, meta, before, opens] = await Promise.all([
      b().listUsers(), b().listAllCrews(), b().getWeekMeta(ws), b().getWeekBefore(ws), b().listAppOpens(),
    ]);
    const days = {};
    const reactions = [];
    await Promise.all(crews.map(async (c) => {
      const [ds, rs] = await Promise.all([b().getCrewDays(c.id), b().listCrewReactions(c.id)]);
      days[c.id] = ds;
      reactions.push(...rs.map((r) => ({ ...r, crewId: c.id })));
    }));
    Object.assign(st, { users, crews, meta, before, opens, days, reactions });
    for (const uid of [...st.skips]) if (!userBy(uid)) st.skips.delete(uid);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  st.loading = false;
  render();
}

/* ================= 每週配對 ================= */

function makePlan(seed = Math.floor(Math.random() * 1e9)) {
  const { ws, prev, thisCrews, prevCrews } = weekInfo();
  const rematch = !!st.meta;
  // 重新配對時，用第一次配對前的狀態重算，森林才不會前進兩次
  const before = rematch && st.before ? st.before
    : Object.fromEntries(st.users.map((u) => [u.uid, { currentForest: u.currentForest || 1, crewWeek: u.crewWeek || null, crewId: u.crewId || null }]));
  const effUsers = st.users.map((u) => {
    const x = before[u.uid];
    return x ? { ...u, currentForest: x.currentForest, crewWeek: x.crewWeek, crewId: x.crewId } : u;
  });
  const res = planMatching({ users: effUsers, prevWeekStart: prev, ref: presenceNow(), skips: st.skips, rng: mulberry32(seed) });
  const suffix = randomId();
  const count = {};
  const crews = res.crews.map((c) => {
    count[c.forest] = (count[c.forest] || 0) + 1;
    return { ...c, id: `${ws}-f${c.forest}-${count[c.forest]}-${suffix}`, n: count[c.forest] };
  });
  const settle = prevCrews.filter((c) => !c.settled).map((c) => ({
    crewId: c.id, steps: countSteps(st.days[c.id] || []), members: Object.keys(c.members || {}), forest: c.forest, weekStart: prev,
  }));
  const userUpdates = {};
  for (const c of crews) for (const uid of c.members) userUpdates[uid] = { crewId: c.id, crewWeek: ws, currentForest: c.forest };
  // 這次沒分到的人：本週的小隊要拿掉（還原成配對前）
  for (const u of st.users) {
    if (userUpdates[u.uid]) continue;
    const x = before[u.uid];
    if (rematch && x) userUpdates[u.uid] = { crewId: x.crewId || null, crewWeek: x.crewWeek || null, currentForest: x.currentForest || 1 };
    else if (u.crewWeek === ws) userUpdates[u.uid] = { crewId: null, crewWeek: null };
  }
  const deleteCrewIds = rematch ? thisCrews.map((c) => c.id) : [];
  const lostEntries = deleteCrewIds.reduce((n, id) => n + (st.days[id] || []).length, 0);
  const matched = new Set(crews.flatMap((c) => c.members));
  const advanced = effUsers.filter((u) => matched.has(u.uid) && u.crewWeek === prev).length;
  return { ws, prev, rematch, before, crews, excluded: res.excluded, settle, userUpdates, deleteCrewIds, lostEntries, advanced, seed };
}

async function commitPlan() {
  const p = st.plan;
  if (!p) return;
  st.busy = 'match';
  render();
  try {
    await b().commitMatching({
      weekStart: p.ws,
      deleteCrewIds: p.deleteCrewIds,
      settle: p.settle,
      crews: p.crews.map((c) => ({ id: c.id, forest: c.forest, chars: c.chars })),
      userUpdates: p.userUpdates,
      before: p.before,
    });
    toast(`配對完成：${p.crews.length} 個小隊`);
    st.plan = null;
    st.confirmRematch = false;
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  st.busy = '';
  await loadAll();
}

async function addMember(uid) {
  const { ws, thisCrews } = weekInfo();
  const u = userBy(uid);
  const crewId = st.addTarget[uid] || (openCrewCandidates(thisCrews, u.currentForest || 1)[0] || {}).id;
  const crew = thisCrews.find((c) => c.id === crewId);
  if (!crew) { toast('這週沒有還有空位的小隊'); return; }
  const char = pickCharacter(u.prefs, crew.chars);
  if (!char || Object.keys(crew.members).length >= MAX_CREW) { toast('這個小隊滿了'); return; }
  st.busy = `add-${uid}`;
  render();
  try {
    await b().adminAddMember(crew.id, uid, char, ws, crew.forest);
    toast(`已把 ${u.nickname} 加進 ${crewLabel(crew)}`);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  st.busy = '';
  await loadAll();
}

/* ================= 測試工具 ================= */

async function createTestUsers() {
  const n = Math.max(1, Math.min(30, Number(st.testCount) || 11));
  const used = new Set(st.users.map((u) => u.uid));
  const list = [];
  for (let i = 1; list.length < n && i < 200; i++) {
    const uid = `test_${String(i).padStart(2, '0')}`;
    if (used.has(uid)) continue;
    list.push({ uid, nickname: `測試${String(i).padStart(2, '0')}`, prefs: shuffle(CHAR_IDS).slice(0, 2), createdAt: presenceNow() - 3 * 24 * HOUR });
  }
  await run('test-create', () => b().createTestUsers(list), `建立了 ${list.length} 位測試使用者`);
}

async function touchTestUsers() {
  const uids = st.users.filter((u) => u.isTest).map((u) => u.uid);
  if (!uids.length) { toast('還沒有測試使用者'); return; }
  await run('test-touch', () => b().touchTestUsers(uids, questDate()), `${uids.length} 位測試使用者都「剛剛打開過 App」了`);
}

async function seedTeam() {
  const { thisCrews } = weekInfo();
  const mine = st.user && thisCrews.find((c) => c.members[st.user.uid]);
  if (!mine) { toast('你這週還沒有小隊（先配對，或把自己加進小隊）'); return; }
  const testers = Object.keys(mine.members).filter((uid) => userBy(uid) && userBy(uid).isTest);
  if (!testers.length) { toast('你的小隊裡沒有測試使用者'); return; }
  const today = questDate();
  const pool = ['setout', 'onit', 'done', 'little', 'rest', 'not-today'];
  const titles = st.templates.length ? st.templates.map((t) => t.title) : ['讀英文', '跑步', '整理書桌'];
  const entries = testers.map((uid) => {
    const status = pool[Math.floor(Math.random() * pool.length)];
    const priv = Math.random() < 0.25;
    const rest = status === 'rest';
    return {
      uid, date: today, status, visibility: priv ? 'private' : 'public',
      publicTitle: rest || priv ? null : titles[Math.floor(Math.random() * titles.length)],
      minutes: rest ? null : [10, 15, 20][Math.floor(Math.random() * 3)],
      energy: rest ? null : 'normal', setOut: !rest, setOutSeconds: rest ? null : 15 + Math.floor(Math.random() * 80),
    };
  });
  await run('test-seed', () => b().seedDays(mine.id, entries), `幫 ${testers.length} 位測試隊友填好今天的狀態`);
}

async function resetAll() {
  if (st.resetText.trim() !== '重設') { toast('請在框裡輸入「重設」兩個字'); return; }
  await run('reset', () => b().resetAll((p) => { st.progress = p; render(); }), '所有資料都清空了');
  st.resetText = '';
  st.plan = null;
  render();
}

async function run(key, fn, okText) {
  st.busy = key;
  render();
  try {
    await fn();
    toast(okText);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  st.busy = '';
  st.progress = '';
  await loadAll();
}

/* ================= 匯出 CSV ================= */

function exportCsv(kind) {
  const crewById = Object.fromEntries(st.crews.map((c) => [c.id, c]));
  const stamp = questDate();
  if (kind === 'days') {
    const rows = Object.values(st.days).flat().sort((x, y) => (x.date > y.date ? 1 : x.date < y.date ? -1 : 0));
    const cols = [
      { label: 'weekStart', get: (r) => (crewById[r.crewId] || {}).weekStart },
      { label: 'crewId', key: 'crewId' },
      { label: 'forest', get: (r) => forestBy((crewById[r.crewId] || {}).forest).zh },
      { label: 'date', key: 'date' },
      { label: 'uid', key: 'uid' },
      { label: 'nickname', get: (r) => nick(r.uid) },
      { label: 'status', key: 'status' },
      { label: 'visibility', key: 'visibility' },
      { label: 'publicTitle', get: (r) => (r.visibility === 'private' ? '' : r.publicTitle) },
      { label: 'minutes', key: 'minutes' },
      { label: 'energy', key: 'energy' },
      { label: 'templateId', key: 'templateId' },
      { label: 'publicNote', get: (r) => (r.visibility === 'private' ? '' : r.publicNote) },
      { label: 'setOutAt', get: (r) => fmtTime(r.setOutAt) },
      { label: 'setOutSeconds', key: 'setOutSeconds' },
      { label: 'middayAt', get: (r) => fmtTime(r.middayAt) },
      { label: 'updatedAt', get: (r) => fmtTime(r.updatedAt) },
    ];
    download(`wuplet_days_${stamp}.csv`, toCSV(rows, cols));
  }
  if (kind === 'reactions') {
    const cols = [
      { label: 'crewId', key: 'crewId' }, { label: 'date', key: 'date' },
      { label: 'from', key: 'from' }, { label: 'fromNickname', get: (r) => nick(r.from) },
      { label: 'to', key: 'to' }, { label: 'toNickname', get: (r) => nick(r.to) },
      { label: 'type', key: 'type' }, { label: 'at', get: (r) => fmtTime(r.at) },
    ];
    download(`wuplet_reactions_${stamp}.csv`, toCSV(st.reactions, cols));
  }
  if (kind === 'opens') {
    const cols = [
      { label: 'date', key: 'date' }, { label: 'uid', key: 'uid' }, { label: 'nickname', get: (r) => nick(r.uid) },
      { label: 'at', get: (r) => fmtTime(r.at) },
    ];
    download(`wuplet_app_opens_${stamp}.csv`, toCSV([...st.opens].sort((x, y) => String(x.date).localeCompare(String(y.date))), cols));
  }
  if (kind === 'crews') {
    const rows = [];
    for (const c of [...st.crews].sort((x, y) => String(x.weekStart).localeCompare(String(y.weekStart)) || byForest(x, y))) {
      for (const [uid, m] of Object.entries(c.members || {})) rows.push({ c, uid, m });
    }
    const cols = [
      { label: 'weekStart', get: (r) => r.c.weekStart }, { label: 'crewId', get: (r) => r.c.id },
      { label: 'crew', get: (r) => crewLabel(r.c) }, { label: 'forest', get: (r) => forestBy(r.c.forest).zh },
      { label: 'uid', get: (r) => r.uid }, { label: 'nickname', get: (r) => nick(r.uid) },
      { label: 'character', get: (r) => r.m.c }, { label: 'joinedAt', get: (r) => fmtTime(r.m.j) },
      { label: 'crewSteps', get: (r) => countSteps(st.days[r.c.id] || []) }, { label: 'settled', get: (r) => (r.c.settled ? 'yes' : 'no') },
    ];
    download(`wuplet_crews_${stamp}.csv`, toCSV(rows, cols));
  }
  if (kind === 'users') {
    const cols = [
      { label: 'uid', key: 'uid' }, { label: 'nickname', key: 'nickname' },
      { label: 'pref1', get: (r) => r.prefs[0] }, { label: 'pref2', get: (r) => r.prefs[1] },
      { label: 'currentForest', get: (r) => forestBy(r.currentForest).zh }, { label: 'crewWeek', key: 'crewWeek' },
      { label: 'crewId', key: 'crewId' }, { label: 'createdAt', get: (r) => fmtTime(r.createdAt) },
      { label: 'lastSeenAt', get: (r) => fmtTime(r.lastSeenAt) }, { label: 'isTest', get: (r) => (r.isTest ? 'yes' : 'no') },
    ];
    download(`wuplet_users_${stamp}.csv`, toCSV(st.users, cols));
  }
}

/* ================= 畫面 ================= */

function render() {
  const a = document.activeElement;
  const keep = a && a.id && root.contains(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
  const views = { loading: loadingView, login: loginView, denied: deniedView, error: errorView, ready: readyView };
  root.innerHTML = (views[st.phase] || loadingView)();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.focus({ preventScroll: true });
      try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* 不支援就算了 */ }
    }
  }
}

function header() {
  return `<header class="adm-head">
    <img src="assets/app/logo.webp" alt="" width="44" height="44">
    <div class="adm-title"><h1>伍伴 管理頁</h1><p class="muted small">${DEMO ? '示範資料（不會存）' : esc((st.user && st.user.email) || '')}</p></div>
    <nav class="adm-nav">
      <a class="btn btn-ghost btn-sm" href="${DEMO ? 'index.html?demo=1' : 'index.html'}">回到 App</a>
      ${st.user && !DEMO ? '<button class="btn btn-ghost btn-sm" data-action="sign-out">登出</button>' : ''}
    </nav>
  </header>`;
}

function loadingView() {
  return `<main class="adm"><div class="loader adm-loader" role="status" aria-label="載入中"></div></main>`;
}

function loginView() {
  return `<main class="adm narrow-adm">${header()}
    <section class="card">
      <h2>請先登入</h2>
      <p class="muted">用你在 Firestore 安全規則裡設定的管理者 Google 帳號登入。</p>
      <button class="btn btn-primary" data-action="sign-in">用 Google 登入</button>
      ${st.loginError ? `<p class="error-text" role="alert">${esc(st.loginError)}</p>` : ''}
    </section>
  </main>`;
}

function deniedView() {
  return `<main class="adm narrow-adm">${header()}
    <section class="card">
      <h2>這個帳號不是管理者</h2>
      <p class="muted">管理者帳號寫在 Firestore 安全規則的 <code>isAdmin()</code> 裡。如果你就是管理者，請確認規則已經「發布」，而且登入的是同一個 Google 帳號。</p>
      <button class="btn btn-ghost" data-action="sign-out">換一個帳號</button>
    </section>
  </main>`;
}

function errorView() {
  return `<main class="adm narrow-adm">${header()}<section class="card"><h2>載入失敗</h2><p class="muted">${esc(st.error)}</p><button class="btn btn-primary" data-action="reload">重新整理</button></section></main>`;
}

function readyView() {
  return `<main class="adm">
    ${header()}
    ${DEMO ? '<p class="adm-band">示範模式：這裡的資料是假的，重新整理就回到預設。正式使用請拿掉網址裡的 <code>?demo=1</code>。</p>' : ''}
    ${st.loading ? '<p class="adm-band subtle">資料更新中…</p>' : ''}
    <div class="adm-grid">
      ${timeCard()}
      ${matchCard()}
    </div>
    ${planView()}
    ${crewsCard()}
    ${usersCard()}
    ${metricsCard()}
    ${exportCard()}
    ${toolsCard()}
    <p class="muted tiny center-text">資料讀取時間：${fmtTime(Date.now())}　<button class="btn-link" data-action="reload-data">重新整理資料</button></p>
  </main>`;
}

function timeCard() {
  const ws = currentWeekStart();
  const today = questDate();
  const fake = getNowOverride() != null;
  return `<section class="card adm-card">
    <h2>App 現在的時間</h2>
    <p class="big-num num">${formatMD(today)} ${formatHM()}</p>
    <p class="muted small">${WINDOW_ZH[windowOf()]}・這週第 ${dayIndex(today, ws)} 天（${formatMD(ws)} – ${formatMD(addDays(ws, 6))}）${fake ? '・<b class="warn">測試時間</b>' : ''}</p>
    <details ${fake ? 'open' : ''}>
      <summary>測試用：假裝現在是…</summary>
      <p class="muted small">只會改變這台裝置上「管理頁」和「App」看到的時間（台灣時間），不影響別人，也不影響伺服器記錄的時間。用完記得恢復。</p>
      <div class="row">
        <input id="fake-now" class="input input-sm" type="datetime-local" data-input="fake" value="${esc(st.fakeInput || toTaipeiLocal(nowMs()))}">
        <button class="btn btn-ghost btn-sm" data-action="set-fake">套用</button>
        ${fake ? '<button class="btn btn-ghost btn-sm" data-action="clear-fake">恢復真實時間</button>' : ''}
      </div>
    </details>
  </section>`;
}

function matchCard() {
  const { ws, prev, thisCrews, prevCrews } = weekInfo();
  const active = st.users.filter((u) => !isAway(u, presenceNow()));
  const unsettled = prevCrews.filter((c) => !c.settled).length;
  return `<section class="card adm-card">
    <h2>本週配對</h2>
    <p class="status-line">${st.meta
      ? `<span class="pill ok">已配對</span> ${st.meta.matchedAt ? fmtTime(st.meta.matchedAt) : ''}・${thisCrews.length} 個小隊`
      : '<span class="pill">還沒配對</span> 每週一早上按一次就好'}</p>
    <ul class="facts">
      <li>使用者 <b class="num">${st.users.length}</b> 人（測試 ${st.users.filter((u) => u.isTest).length}）</li>
      <li>48 小時內打開過 <b class="num">${active.length}</b> 人，其餘算「出遠門」不參加配對</li>
      <li>上週（${formatMD(prev)} 起）小隊 ${prevCrews.length} 個${unsettled ? `，<b>${unsettled} 個還沒結算</b>（配對時一起結算）` : ''}</li>
    </ul>
    ${st.plan ? '<p class="muted small">預覽在下面，確認後才會寫入。</p>' : `<button class="btn btn-primary" data-action="plan" ${st.busy || st.loading ? 'disabled' : ''}>${st.meta ? '重新配對本週…' : '開始本週配對'}</button>`}
    ${st.meta && !st.plan ? '<p class="muted small">重新配對會刪掉本週現有的小隊和這週的每日紀錄，只在剛配完發現問題時用。</p>' : ''}
    <p class="muted tiny">本週從 ${formatMD(ws)} 02:00 開始。</p>
  </section>`;
}

function planView() {
  const p = st.plan;
  if (!p) return '';
  const small = p.crews.filter((c) => c.members.length < MIN_GROUP);
  const awayN = p.excluded.filter((x) => x.reason === 'away').length;
  const skipN = p.excluded.filter((x) => x.reason === 'skip').length;
  const people = p.crews.reduce((n, c) => n + c.members.length, 0);
  const cards = p.crews.map((c) => `<article class="crew-card">
      <h3>${esc(forestBy(c.forest).zh)}・第 ${c.n} 隊</h3><p class="crew-meta muted small">${c.members.length} 人</p>
      <ul>${c.members.map((uid) => {
        const u = userBy(uid);
        const from = u && (p.before[uid] || {}).crewWeek === p.prev ? `上週在${forestBy((p.before[uid] || {}).currentForest).zh}` : '新加入或上週沒來';
        return `<li>${avatar(c.chars[uid], 'idle', { size: 'sm' })}<span><b>${esc(nick(uid))}</b><span class="muted tiny">${esc(charById(c.chars[uid]).zh)}・${from}</span></span></li>`;
      }).join('')}</ul>
    </article>`).join('');
  return `<section class="card plan">
    <h2>${p.rematch ? '重新配對預覽' : '配對預覽'}（還沒寫入）</h2>
    <ul class="facts">
      <li><b class="num">${people}</b> 人分成 <b class="num">${p.crews.length}</b> 隊；不參加 ${p.excluded.length} 人（出遠門 ${awayN}、跳過 ${skipN}）</li>
      <li>森林：上週有小隊的人（${p.advanced} 人）往前一座；新加入或上週出遠門的人留在原本的森林。不到 ${MIN_GROUP} 人的森林會併到下一座有人的森林。</li>
      ${p.settle.length ? `<li>會結算上週 ${p.settle.length} 個小隊（共 ${p.settle.reduce((n, s) => n + s.steps, 0)} 步）</li>` : ''}
      ${p.rematch ? `<li class="warn">會刪掉本週現有的 ${p.deleteCrewIds.length} 個小隊和 ${p.lostEntries} 筆本週每日紀錄</li>` : ''}
    </ul>
    ${small.length ? `<p class="warn small">有 ${small.length} 隊不到 ${MIN_GROUP} 人（人太少時會這樣）。</p>` : ''}
    ${p.crews.length ? `<div class="crew-grid">${cards}</div>` : '<p class="muted">沒有可以配對的人。請確認大家最近 48 小時內打開過 App，或用測試工具讓測試使用者「打開 App」。</p>'}
    ${p.excluded.length ? `<p class="muted small">不參加：${p.excluded.map((x) => `${esc(nick(x.uid))}（${x.reason === 'away' ? '出遠門' : '跳過'}）`).join('、')}</p>` : ''}
    <div class="row">
      ${p.crews.length ? (p.rematch && !st.confirmRematch
        ? '<button class="btn btn-primary btn-auto" data-action="confirm-rematch">確定重新配對…</button>'
        : `<button class="btn btn-primary btn-auto" data-action="commit" ${st.busy ? 'disabled' : ''}>${st.busy === 'match' ? '寫入中…' : p.rematch ? '我了解，刪掉舊小隊並重新配對' : '確定配對'}</button>`) : ''}
      <button class="btn btn-ghost" data-action="reshuffle" ${st.busy ? 'disabled' : ''}>重新洗牌</button>
      <button class="btn btn-text" data-action="cancel-plan" ${st.busy ? 'disabled' : ''}>取消</button>
    </div>
  </section>`;
}

function crewsCard() {
  const { thisCrews } = weekInfo();
  if (!thisCrews.length) return '';
  const today = questDate();
  const cards = thisCrews.map((c) => {
    const days = st.days[c.id] || [];
    const members = Object.entries(c.members || {}).sort((x, y) => (x[1].j || 0) - (y[1].j || 0));
    return `<article class="crew-card">
      <h3>${esc(crewLabel(c))}</h3><p class="crew-meta muted small">${members.length} 人・營火 ${countSteps(days)} 步</p>
      <ul>${members.map(([uid, m]) => {
        const u = userBy(uid);
        const v = statusView(days.find((d) => d.uid === uid && d.date === today), { away: u ? isAway(u, presenceNow()) : false });
        return `<li>${avatar(m.c, v.state, { size: 'sm' })}<span><span class="nm"><b>${esc(nick(uid))}</b>${u && u.isTest ? ' <span class="tag-mini">測試</span>' : ''}</span><span class="muted tiny">${esc(v.sentence)}</span></span></li>`;
      }).join('')}</ul>
    </article>`;
  }).join('');
  return `<section class="card"><h2>本週小隊・今天的樣子</h2><div class="crew-grid">${cards}</div></section>`;
}

function usersCard() {
  const { ws, thisCrews } = weekInfo();
  const crewOf = Object.fromEntries(thisCrews.map((c) => [c.id, c]));
  const open = thisCrews.filter((c) => !c.settled && Object.keys(c.members).length < MAX_CREW);
  const rows = [...st.users].sort((x, y) => (y.lastSeenAt || 0) - (x.lastSeenAt || 0)).map((u) => {
    const away = isAway(u, presenceNow());
    const crew = u.crewWeek === ws ? crewOf[u.crewId] : null;
    let action = '';
    if (!crew && st.meta) {
      if (!open.length) action = '<span class="muted tiny">沒有空位</span>';
      else {
        const def = st.addTarget[u.uid] || (openCrewCandidates(thisCrews, u.currentForest || 1)[0] || open[0]).id;
        action = `<div class="row tight"><select class="input input-sm" data-add-target="${u.uid}" aria-label="選小隊">${open.map((c) => `<option value="${c.id}" ${c.id === def ? 'selected' : ''}>${esc(crewLabel(c))}（${Object.keys(c.members).length}）</option>`).join('')}</select>
          <button class="btn btn-ghost btn-sm" data-action="add-member" data-uid="${u.uid}" ${st.busy ? 'disabled' : ''}>${st.busy === `add-${u.uid}` ? '加入中…' : '加入小隊'}</button></div>`;
      }
    }
    return `<tr>
      <td class="nowrap"><b>${esc(u.nickname || '（未命名）')}</b>${u.isTest ? ' <span class="tag-mini">測試</span>' : ''}<span class="muted tiny block">${esc(u.uid.slice(0, 10))}</span></td>
      <td><span class="prefs">${(u.prefs || []).map((c) => avatar(c, 'idle', { size: 'sm', label: charById(c).zh })).join('')}</span></td>
      <td class="nowrap">${esc(forestBy(u.currentForest).zh)}</td>
      <td class="nowrap">${crew ? esc(crewLabel(crew)) : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${ago(u.lastSeenAt)}${away ? ' <span class="tag-mini away">出遠門</span>' : ''}</td>
      <td><label class="check"><input type="checkbox" data-skip="${u.uid}" ${st.skips.has(u.uid) ? 'checked' : ''}><span>跳過</span></label></td>
      <td>${action}</td>
    </tr>`;
  }).join('');
  return `<section class="card">
    <h2>使用者 <span class="muted small">${st.users.length} 人</span></h2>
    <p class="muted small">「跳過」只影響下一次配對（例如請假的人）。這週才加入、或配對後才回來的人，可以用「加入小隊」手動放進有空位的小隊。</p>
    <div class="table-wrap"><table class="adm-table">
      <thead><tr><th>暱稱</th><th>角色志願</th><th>所在森林</th><th>本週小隊</th><th>最後打開</th><th>配對</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">還沒有人登入過。</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

function metricsCard() {
  const entries = Object.values(st.days).flat();
  if (!entries.length) {
    return '<section class="card"><h2>測試指標</h2><p class="muted">還沒有每日紀錄。大家開始出發之後，這裡會自動算出來。</p></section>';
  }
  const opens = new Set(st.opens.map((o) => `${o.date}_${o.uid}`));
  const m = computeMetrics({ entries, opens, crews: st.crews, today: questDate() });
  const n = (x) => (x && x.n ? `<span class="muted tiny">n=${x.n}</span>` : '');
  const secs = (x) => (x && x.value != null ? `${Math.round(x.value)} 秒` : '—');
  const rows = m.weeks.map((w) => `<tr>
    <td>${formatMD(w.weekStart)} 那週</td>
    <td>${pct(w.questStartRate)} ${n(w.questStartRate)}</td>
    <td>${pct(w.returnToShare)} ${n(w.returnToShare)}</td>
    <td>${secs(w.timeToSetOut)} ${n(w.timeToSetOut)}</td>
    <td>${pct(w.restToReturn)} ${n(w.restToReturn)}</td>
    <td>${pct(w.crewImpact.withAway)} ${n(w.crewImpact.withAway)} / ${pct(w.crewImpact.withoutAway)} ${n(w.crewImpact.withoutAway)}</td>
  </tr>`).join('');
  return `<section class="card">
    <h2>測試指標</h2>
    <div class="table-wrap"><table class="adm-table metrics">
      <thead><tr><th>週</th><th>出發後帶回一步</th><th>回營回報</th><th>出發所需時間（中位數）</th><th>休息後隔天回來</th><th>有人出遠門 / 沒有</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${m.week2Return ? `<p><b>第二週回訪：</b>${pct(m.week2Return)} ${n(m.week2Return)}</p>` : ''}
    <details class="defs"><summary>指標怎麼算</summary>
      <dl>
        <dt>出發後帶回一步（Quest Start Rate）</dt><dd>按了「出發」的那些天，最後選「完成」或「做了一點」的比例。</dd>
        <dt>回營回報（Return-to-Share）</dt><dd>按了「出發」的那些天，晚上有回來選結果（包含「今天沒做」）的比例。</dd>
        <dt>出發所需時間（Time to Set Out）</dt><dd>打開 App 到按下「出發」的秒數，取中位數。</dd>
        <dt>休息後隔天回來（Rest-to-Return）</dt><dd>選了「今天休息」或「今天沒做」之後，隔天有打開 App 的比例（今天的還不算）。</dd>
        <dt>有人出遠門 / 沒有（Crew Impact）</dt><dd>同隊有人前一天和當天都沒打開 App 的日子，和沒有這種人的日子，其他人「出發後帶回一步」的比例。</dd>
        <dt>第二週回訪（Week-2 Return）</dt><dd>第一週有出發過的人，第二週也有出發的比例。</dd>
      </dl>
      <p class="muted small">n 是分母的筆數。人數少的時候，比例會跳很大，請一起看 n。</p>
    </details>
  </section>`;
}

function exportCard() {
  const total = Object.values(st.days).reduce((n, d) => n + d.length, 0);
  return `<section class="card">
    <h2>匯出資料（CSV）</h2>
    <p class="muted small">用 Excel 或 Google 試算表打開。私人任務的名稱和心得不會出現在這裡（只有本人讀得到）。</p>
    <div class="row wrap">
      <button class="btn btn-ghost btn-sm" data-action="csv" data-kind="days">每日紀錄（${total}）</button>
      <button class="btn btn-ghost btn-sm" data-action="csv" data-kind="reactions">回應（${st.reactions.length}）</button>
      <button class="btn btn-ghost btn-sm" data-action="csv" data-kind="opens">開啟紀錄（${st.opens.length}）</button>
      <button class="btn btn-ghost btn-sm" data-action="csv" data-kind="crews">小隊成員</button>
      <button class="btn btn-ghost btn-sm" data-action="csv" data-kind="users">使用者</button>
    </div>
  </section>`;
}

function toolsCard() {
  const busy = (k) => (st.busy === k ? 'disabled' : st.busy ? 'disabled' : '');
  return `<section class="card tools">
    <h2>測試工具</h2>
    <p class="muted small">正式開始前，可以用測試使用者自己演練一輪。正式測試開始前記得「重設所有資料」。</p>
    <div class="tool">
      <div><b>建立測試使用者</b><span class="muted small block">名字是「測試01、測試02…」，會一起被配對。</span></div>
      <div class="row tight"><input id="test-count" class="input input-sm num" type="number" min="1" max="30" data-input="test-count" value="${esc(st.testCount)}" aria-label="人數"><button class="btn btn-ghost btn-sm" data-action="test-create" ${busy('test-create')}>建立</button></div>
    </div>
    <div class="tool">
      <div><b>讓測試使用者「剛剛打開 App」</b><span class="muted small block">超過 48 小時沒打開的人不會被配對。</span></div>
      <button class="btn btn-ghost btn-sm" data-action="test-touch" ${busy('test-touch')}>執行</button>
    </div>
    <div class="tool">
      <div><b>幫我小隊的測試隊友填今天的狀態</b><span class="muted small block">隨機出發、完成、休息…，看首頁會長怎樣。</span></div>
      <button class="btn btn-ghost btn-sm" data-action="test-seed" ${busy('test-seed')}>執行</button>
    </div>
    <div class="tool danger">
      <div><b>重設所有資料</b><span class="muted small block">刪掉所有人的資料：使用者、小隊、每日紀錄、回應、開啟紀錄、配對紀錄。你自己的暱稱也會被刪，回到 App 要重新設定。無法復原。</span></div>
      <div class="row tight"><input id="reset-text" class="input input-sm" data-input="reset" placeholder="輸入「重設」" value="${esc(st.resetText)}" aria-label="輸入重設確認"><button class="btn btn-danger btn-sm" data-action="reset" ${busy('reset')}>${st.busy === 'reset' ? `刪除中…${esc(st.progress)}` : '重設'}</button></div>
    </div>
  </section>`;
}

/* ================= 互動 ================= */

const actions = {
  reload: () => location.reload(),
  'reload-data': () => loadAll(),
  'sign-in': () => {
    st.loginError = '';
    b().signIn().catch((err) => { st.loginError = friendlyError(err); render(); });
  },
  'sign-out': () => b().signOut(),
  'set-fake': () => {
    const ms = parseTaipeiLocal(st.fakeInput || (document.getElementById('fake-now') || {}).value);
    if (ms == null) { toast('時間格式不對'); return; }
    setNowOverride(ms);
    if (!DEMO) { try { localStorage.setItem(FAKE_KEY, String(ms)); } catch (e) { /* 存不了就只影響這頁 */ } }
    st.plan = null;
    toast('已套用測試時間');
    loadAll();
  },
  'clear-fake': () => {
    setNowOverride(null);
    try { localStorage.removeItem(FAKE_KEY); } catch (e) { /* 忽略 */ }
    st.fakeInput = '';
    st.plan = null;
    toast('已恢復真實時間');
    loadAll();
  },
  plan: () => { st.plan = makePlan(); st.confirmRematch = false; render(); },
  reshuffle: () => { st.plan = makePlan(); st.confirmRematch = false; render(); },
  'cancel-plan': () => { st.plan = null; st.confirmRematch = false; render(); },
  'confirm-rematch': () => { st.confirmRematch = true; render(); },
  commit: () => commitPlan(),
  'add-member': (el) => addMember(el.dataset.uid),
  csv: (el) => exportCsv(el.dataset.kind),
  'test-create': () => createTestUsers(),
  'test-touch': () => touchTestUsers(),
  'test-seed': () => seedTeam(),
  reset: () => resetAll(),
};

root.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});

root.addEventListener('input', (ev) => {
  const k = ev.target.dataset && ev.target.dataset.input;
  if (k === 'fake') st.fakeInput = ev.target.value;
  if (k === 'test-count') st.testCount = ev.target.value;
  if (k === 'reset') st.resetText = ev.target.value;
});

root.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset && t.dataset.skip) {
    if (t.checked) st.skips.add(t.dataset.skip);
    else st.skips.delete(t.dataset.skip);
    if (st.plan) { st.plan = makePlan(st.plan.seed); render(); }
  }
  if (t.dataset && t.dataset.addTarget) st.addTarget[t.dataset.addTarget] = t.value;
});

/* ================= 啟動 ================= */

async function onAuth(user) {
  st.user = user;
  if (!user) { st.phase = 'login'; render(); return; }
  st.phase = 'loading';
  render();
  const admin = await b().isAdmin();
  if (!admin) { st.phase = 'denied'; render(); return; }
  if (!DEMO) {
    try {
      const v = Number(localStorage.getItem(FAKE_KEY));
      if (v) setNowOverride(v);
    } catch (e) { /* 忽略 */ }
  }
  st.phase = 'ready';
  await loadAll();
}

async function boot() {
  render();
  try {
    const getJson = (url) => fetch(url, { cache: 'no-cache' }).then((r) => r.json());
    const [backend, forests, templates] = await Promise.all([
      createBackend({ demo: DEMO }),
      getJson('content/forests.json'),
      getJson('content/quest_templates.json'),
    ]);
    st.backend = backend;
    st.forests = forests.forests || [];
    st.templates = templates.templates || [];
  } catch (err) {
    console.error(err);
    st.phase = 'error';
    st.error = String((err && err.message) || err);
    render();
    return;
  }
  b().onAuth(onAuth);
}

boot();
