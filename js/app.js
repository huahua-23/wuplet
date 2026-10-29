// 伍伴 Wuplet — 主程式（單頁 App）
//
// 畫面：登入 → 第一次設定 → 等待分隊 / 首頁（每週營地）→ 早上出發 → 任務出發 → 中午碰面 → 晚上回營 → 一週回顧
// 資料層在 backend-firebase.js（正式）和 backend-demo.js（網址加 ?demo=1 的示範模式），兩個介面一樣。
import {
  CHARACTERS, charById, MINUTES, ENERGY, CATEGORIES, REACTIONS, CAMP_STAGES, TITLE_MAX, NOTE_MAX, NICK_MAX, APP_VERSION,
} from './constants.js';
import {
  nowMs, setNowOverride, getNowOverride, questDate, windowOf, currentWeekStart, prevWeekStart, addDays,
  dayIndex, weekBoundaryMs, formatHM, formatMD, parseTaipeiLocal, WEEKDAY_ZH,
} from './time.js';
import {
  countSteps, campStage, nextForest, shrinkQuest, smallerMinutes, recommend, statusView, isAway,
  openCrewCandidates, questLabel, treeDots,
} from './logic.js';
import { createBackend } from './backend.js';
import { esc, asset, avatar, icon, toast, friendlyError, inAppBrowser } from './ui.js';

/* ================= 啟動參數 ================= */

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const SCENE = params.get('scene') || '';
if (DEMO && params.get('now')) setNowOverride(parseTaipeiLocal(params.get('now')));
const FAKE_KEY = 'wuplet-fake-now';
// 「出遠門」用真實時間判斷（最後上線時間是伺服器的真實時間）；示範模式的資料是照模擬時間做的
const presenceNow = () => (DEMO ? nowMs() : Date.now());

const app = document.getElementById('app');

const state = {
  backend: null,
  forests: [],
  templates: [],
  user: null,
  isAdmin: false,
  profile: undefined,
  crewId: null,
  crew: null,
  days: [],
  reactions: [],
  mates: {},
  privateToday: null,
  privateFor: '',
  route: 'loading',
  waiting: null,
  error: null,
  form: null,
  sheet: null,
  evening: null,
  onboard: { nickname: '', prefs: [] },
  confirmRest: false,
  busy: false,
  joinTried: false,
  joining: false,
  touched: '',
  loginError: '',
  today: questDate(),
  weekStart: currentWeekStart(),
  openedAt: Date.now(),
  hiddenAt: 0,
  renderedRoute: '',
  renderPending: false,
  pendingRoute: null,
};
const subs = { profile: null, crew: null, days: null, reactions: null, mates: {} };
let authSeq = 0;
let syncSeq = 0;

/* ================= 小工具 ================= */

const me = () => (state.user ? state.user.uid : null);
const forestBy = (order) => state.forests.find((f) => f.order === Number(order))
  || state.forests[0] || { order: 1, zh: '森林', en: '', id: 'mistwhisper', facts: [] };
const crewIsCurrent = () => !!(state.profile && state.profile.crewWeek === state.weekStart
  && state.crew && state.crew.weekStart === state.weekStart);
const myEntry = () => state.days.find((d) => d.uid === me() && d.date === state.today) || null;
const myChar = () => (state.crew && state.crew.members[me()] ? state.crew.members[me()].c
  : (state.profile && state.profile.prefs && state.profile.prefs[0]) || 'sprouty');
const mateInfo = (uid) => (uid === me() ? state.profile : state.mates[uid]) || null;
const entryOf = (uid) => state.days.find((d) => d.uid === uid && d.date === state.today) || null;

function membersOrdered() {
  const m = (state.crew && state.crew.members) || {};
  return Object.entries(m)
    .map(([uid, v]) => ({ uid, char: v.c, joined: v.j || 0 }))
    .sort((a, b) => (a.uid === me() ? -1 : b.uid === me() ? 1 : a.joined - b.joined));
}

function viewOf(uid) {
  const info = mateInfo(uid);
  const away = uid !== me() && info ? isAway(info, presenceNow()) : false;
  return statusView(entryOf(uid), { away });
}

/** 自己看得到的任務名稱（私人任務從私人資料拿） */
function myTitle(entry) {
  if (!entry) return '';
  if (entry.visibility === 'private') return (state.privateToday && state.privateToday.title) || '私人任務';
  return entry.publicTitle || '';
}

function refreshClock() {
  state.today = questDate();
  state.weekStart = currentWeekStart();
}

function nightNow() {
  return ['evening', 'journal'].includes(state.route) || windowOf() === 'evening';
}

function applyTheme() {
  const night = nightNow();
  document.body.dataset.theme = night ? 'night' : 'day';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', night ? '#1E2740' : '#FBF5E9');
}

function onError(err) {
  console.error(err);
  toast(friendlyError(err));
}

/* ================= 路由 ================= */

const SUB_ROUTES = ['setout', 'launch', 'midday', 'evening', 'journal'];
const baseRoute = () => (crewIsCurrent() ? 'home' : 'waiting');

function go(route) {
  state.route = route;
  state.sheet = null;
  state.confirmRest = false;
  render();
  window.scrollTo(0, 0);
}

/** 進入子畫面：多留一筆瀏覽紀錄，手機的「返回」會回到營地而不是離開 App */
function openSub(route) {
  if (!(history.state && history.state.wuplet)) history.pushState({ wuplet: true }, '');
  go(route);
}

/** 離開子畫面 */
function closeSub(route) {
  const target = route || baseRoute();
  if (history.state && history.state.wuplet) {
    state.pendingRoute = target;
    history.back(); // popstate 會接手
  } else {
    go(target);
  }
}

window.addEventListener('popstate', () => {
  const target = state.pendingRoute || baseRoute();
  state.pendingRoute = null;
  if (SUB_ROUTES.includes(state.route) || state.route !== target || state.sheet) go(target);
});

/* ================= 畫面繪製 ================= */

function isTyping() {
  const a = document.activeElement;
  return !!(a && app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
}

/** 資料更新時用：正在打字就先不重畫，離開輸入框再畫 */
function softRender() {
  if (isTyping() && state.renderedRoute === state.route) { state.renderPending = true; return; }
  render();
}

app.addEventListener('focusout', () => {
  setTimeout(() => { if (state.renderPending && !isTyping()) render(); }, 350);
});

function render() {
  state.renderPending = false;
  applyTheme();
  const a = document.activeElement;
  const keep = a && a.id && app.contains(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
  const screens = { loading, error, login, onboarding, waiting, home, setout, launch, midday, evening, journal };
  app.innerHTML = bands() + (screens[state.route] || loading)() + sheet();
  state.renderedRoute = state.route;
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.focus({ preventScroll: true });
      try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* 有些元素不支援 */ }
    }
  }
}

function bands() {
  if (DEMO) {
    const base = currentWeekStart(Date.now());
    const wed = addDays(base, 2);
    const chips = [
      ['早上', `now=${wed}T08:10`],
      ['中午', `now=${wed}T12:30`],
      ['晚上', `now=${wed}T21:40`],
      ['週日晚上', `now=${addDays(base, 6)}T21:40`],
      ['新使用者', `scene=new&now=${wed}T08:10`],
      ['週一還沒配對', `scene=monday&now=${addDays(base, 7)}T08:10`],
    ];
    const cur = location.search.replace(/^\?demo=1&?/, '');
    return `<div class="band band-demo" role="note"><p>示範模式：資料只存在這個分頁，重新整理就回到預設。換個時間看看：</p><div class="band-chips">${
      chips.map(([label, q]) => `<a class="band-chip" href="?demo=1&${q}" ${cur === q ? 'aria-current="page"' : ''}>${label}</a>`).join('')
    }</div></div>`;
  }
  if (getNowOverride() != null) {
    return `<div class="band band-fake" role="note"><p>測試時間：${formatMD(questDate())} ${formatHM()}（只有你的畫面）</p>`
      + '<button class="band-chip" data-action="clear-fake">恢復真實時間</button></div>';
  }
  return '';
}

/* ---------- 載入中、錯誤 ---------- */

function loading() {
  return '<main class="screen center"><div class="loader" role="status" aria-label="載入中"></div></main>';
}

function error() {
  const e = state.error || {};
  return `<main class="screen center narrow">
    <img class="hero-char" src="${asset.char('sprouty', 'rest')}" alt="">
    <h1 class="title">${esc(e.title || '出了點問題')}</h1>
    <p class="muted">${esc(e.text || '請稍後重新整理再試一次。')}</p>
    ${e.detail ? `<pre class="detail">${esc(e.detail)}</pre>` : ''}
    <button class="btn btn-primary" data-action="reload">重新整理</button>
  </main>`;
}

/* ---------- 登入 ---------- */

function login() {
  const iab = inAppBrowser();
  const url = location.href.split('#')[0];
  const lineUrl = url + (url.includes('?') ? '&' : '?') + 'openExternalBrowser=1';
  const appName = { line: 'LINE', instagram: 'Instagram', facebook: 'Facebook' }[iab] || '';
  return `<main class="screen login">
    <img class="login-logo" src="assets/app/logo.webp" alt="伍伴 Wuplet 標誌" width="168" height="168">
    <h1 class="brand">伍伴 <span class="latin">Wuplet</span></h1>
    <p class="slogan">各自生活，有伴前進</p>
    <ul class="rhythm">
      <li>${icon('icon_backpack')}<span><b>早上出發</b>選一件今天做得到的小事</span></li>
      <li>${icon('icon_sprout')}<span><b>中午碰面</b>看看大家，需要就縮小或休息</span></li>
      <li>${icon('icon_orb')}<span><b>晚上回營</b>帶回光點，營火一起變亮</span></li>
    </ul>
    ${iab ? `<div class="notice" role="alert">
      <b>請改用 Chrome 或 Safari 打開</b>
      <p>Google 不允許在 ${appName} 裡面的瀏覽器登入。</p>
      <div class="notice-btns">
        ${iab === 'line' ? `<a class="btn btn-ghost" href="${esc(lineUrl)}">用手機瀏覽器打開</a>` : ''}
        <button class="btn btn-ghost" data-action="copy-url">複製網址</button>
      </div>
    </div>` : ''}
    <button class="btn btn-primary btn-google" data-action="sign-in">${googleMark()}<span>用 Google 登入</span></button>
    ${state.loginError ? `<p class="error-text" role="alert">${esc(state.loginError)}</p>` : ''}
    <p class="fine">只會用到你的 Google 帳號 ID 和電子郵件來登入；隊友只看得到你取的暱稱。</p>
    ${DEMO ? '' : '<a class="link-muted" href="?demo=1">不登入，先看看示範</a>'}
  </main>`;
}

function googleMark() {
  return '<svg class="g-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
}

/* ---------- 第一次登入：暱稱與角色志願 ---------- */

function onboarding() {
  const o = state.onboard;
  const ok = o.nickname.trim().length > 0 && o.prefs.length === 2 && !state.busy;
  const cards = CHARACTERS.map((c) => {
    const rank = o.prefs.indexOf(c.id);
    return `<button class="pick ${rank >= 0 ? 'on' : ''}" data-action="pick-char" data-char="${c.id}" style="--wash:${c.wash};--main:${c.main}" aria-pressed="${rank >= 0}">
      ${rank >= 0 ? `<span class="pick-rank">${rank === 0 ? '第一志願' : '第二志願'}</span>` : ''}
      <img src="${asset.char(c.id, 'setout')}" alt="">
      <span class="pick-name">${c.zh} <span class="latin">${c.en}</span></span>
      <span class="pick-trait">${c.trait}</span>
    </button>`;
  }).join('');
  return `<main class="screen has-cta">
    <header class="page-head">
      <h1 class="title">先認識一下</h1>
      <p class="muted">每週一，大家會被隨機分成最多 5 人的小隊，一起走一座森林。</p>
    </header>
    <section class="card form">
      <label class="field-label" for="nick">暱稱（隊友會看到，不用真名）</label>
      <input id="nick" class="input" data-input="nickname" maxlength="${NICK_MAX}" autocomplete="nickname" placeholder="例如：小采" value="${esc(o.nickname)}">
    </section>
    <section class="section">
      <h2 class="section-title">選兩隻喜歡的 Wuplet</h2>
      <p class="muted small">依序點兩隻。同一隊的角色不會重複，會先照第一志願分配。</p>
      <div class="pick-grid">${cards}</div>
    </section>
    <button class="btn btn-text small-btn" data-action="sign-out">換一個 Google 帳號</button>
    <div class="cta-bar"><button class="btn btn-primary" data-action="finish-onboarding" ${ok ? '' : 'disabled'}>開始</button></div>
  </main>`;
}

/* ---------- 等待分隊 ---------- */

function waiting() {
  const w = state.waiting || { kind: 'matching' };
  const p = state.profile || { prefs: ['sprouty'], currentForest: 1 };
  const prev = prevWeekStart(state.weekStart);
  const hadLastWeek = p.crewWeek === prev && !!state.crew && state.crew.weekStart === prev;
  const fromCrew = state.crew ? state.crew.forest : p.currentForest;
  const dest = forestBy(w.kind === 'tonight' ? nextForest(fromCrew) : p.crewWeek === prev ? nextForest(p.currentForest) : p.currentForest);
  const texts = {
    joining: ['正在幫你找小隊', '找一個還有空位的小隊，馬上就好。'],
    matching: ['正在整隊', `每週一早上會分好新的小隊，分好之後打開 App 就會看到。下一站預計是「${dest.zh}」。`],
    newWeek: ['下週一出發', `你是這週才加入的。下週一會和大家一起被分進小隊，從「${dest.zh}」開始。`],
    noSpace: ['下週一一起出發', '這週的小隊都滿了，下週一會幫你重新分隊。'],
    tonight: ['這週走完了', `謝謝你這週來過。週一早上整好隊後，你會前往「${dest.zh}」，遇到新的同行者。`],
  };
  const [title, text] = texts[w.kind] || texts.matching;
  const pose = w.kind === 'tonight' ? 'rest' : w.kind === 'joining' ? 'setout' : 'idle';
  return `<main class="screen waiting">
    <div class="top-row">${state.isAdmin && !DEMO ? '<a class="chip-link" href="admin.html">管理頁</a>' : '<span></span>'}${topRight()}</div>
    <div class="center narrow">
      <img class="hero-char" src="${asset.char(p.prefs[0] || 'sprouty', pose)}" alt="">
      <h1 class="title">${title}</h1>
      <p class="muted">${esc(text)}</p>
      ${w.kind === 'joining' ? '<div class="loader small" role="status" aria-label="處理中"></div>' : ''}
    </div>
    <ul class="rhythm card">
      <li>${icon('icon_backpack')}<span><b>早上出發</b>選一件今天做得到的小事</span></li>
      <li>${icon('icon_sprout')}<span><b>中午碰面</b>保留、縮小，或休息</span></li>
      <li>${icon('icon_orb')}<span><b>晚上回營</b>帶回光點，營火一起變亮</span></li>
    </ul>
    <div class="stack">
      ${hadLastWeek ? '<button class="btn btn-ghost" data-action="go-journal">看看上週的紀念樹</button>' : ''}
      ${w.kind === 'tonight' ? '<button class="btn btn-ghost" data-action="go-home">回到營地</button>' : ''}
    </div>
  </main>`;
}

/* ---------- 首頁：每週營地 ---------- */

function topRight() {
  return `<button class="me-btn" data-action="open-menu" aria-label="選單">${avatar(myChar(), 'idle', { size: 'sm' })}</button>`;
}

function home() {
  if (!state.crew) return loading();
  const forest = forestBy(state.crew.forest);
  const di = dayIndex(state.today, state.crew.weekStart);
  const fact = (forest.facts || [])[di - 1];
  const steps = countSteps(state.days);
  const stage = campStage(steps);
  const nextStage = CAMP_STAGES.find((s) => s.min > steps);
  const members = membersOrdered();
  const e = myEntry();
  const act = homeAction(e);
  const rows = members.map((m) => crewRow(m, e)).join('');
  const sunday = di === 7 && (windowOf() === 'evening' || (e && ['done', 'little', 'not-today', 'rest'].includes(e.status)));
  return `<main class="screen has-cta home">
    <header class="hero" style="background-image:url('${asset.forest(forest.id)}')">
      <div class="hero-top"><span class="hero-day">第 <b class="num">${di}</b> 天 · ${formatMD(state.today)}</span>${topRight()}</div>
      <div class="hero-text">
        <h1 class="forest-name">${esc(forest.zh)}</h1>
        <p class="forest-en latin">${esc(forest.en)}</p>
      </div>
    </header>
    ${fact ? `<p class="fact">${icon('icon_leaf', 'ic-xs')}<span>${esc(fact)}</span></p>` : ''}
    <section class="section">
      <h2 class="section-title">小隊的今天<span class="count">${members.length} 人</span></h2>
      <ul class="card crew-list">${rows}</ul>
    </section>
    <section class="camp-card" aria-label="共同營火">
      <img class="camp-img" src="${asset.camp(stage.id)}" alt="營火現在是「${stage.name}」">
      <div class="camp-over">
        <span class="eyebrow">共同營火</span>
        <span class="camp-steps"><b class="num">${steps}</b> 步</span>
        <span class="chip-stage">${stage.name}</span>
      </div>
      <p class="camp-foot">${nextStage ? `再 <b class="num">${nextStage.min - steps}</b> 步，營火會變成「${nextStage.name}」` : '營地已經很亮了，謝謝每一小步'}</p>
    </section>
    ${questCard(e)}
    ${sunday ? '<button class="btn btn-ghost wide" data-action="go-journal">看看這週</button>' : ''}
    <div class="cta-bar">
      ${act.cta ? `<button class="btn btn-primary" data-action="${act.cta.action}">${act.cta.label}</button>` : ''}
      ${act.note ? `<p class="cta-note">${act.note}</p>` : ''}
      ${act.secondary ? `<button class="btn btn-text" data-action="${act.secondary.action}">${state.confirmRest ? '確定今天休息？再按一次' : act.secondary.label}</button>` : ''}
    </div>
  </main>`;
}

function crewRow(m, myE) {
  const self = m.uid === me();
  const info = mateInfo(m.uid);
  const entry = self ? myE : entryOf(m.uid);
  const v = viewOf(m.uid);
  let sentence = v.sentence;
  if (self && entry && ['setout', 'onit'].includes(entry.status)) {
    sentence = `${entry.status === 'onit' ? '正在做' : '出發了'}：${questLabel(myTitle(entry), entry.minutes)}${entry.visibility === 'private' ? '（私人）' : ''}`;
  }
  const note = entry && entry.publicNote && ['done', 'little', 'not-today'].includes(entry.status) ? entry.publicNote : '';
  const got = self ? state.reactions.filter((r) => r.to === me()) : [];
  const gotLabel = got.map((r) => `${(mateInfo(r.from) && mateInfo(r.from).nickname) || '隊友'}：${(REACTIONS.find((x) => x.id === r.type) || {}).label || ''}`).join('、');
  return `<li class="member ${self ? 'self' : ''}">
    ${avatar(m.char, v.state, { size: 'md', label: charById(m.char).zh })}
    <div class="member-text">
      <span class="member-name">${self ? '你' : esc((info && info.nickname) || '旅伴')}</span>
      <span class="member-status">${esc(sentence)}</span>
      ${note ? `<span class="member-note">「${esc(note)}」</span>` : ''}
    </div>
    ${got.length ? `<span class="got" role="img" aria-label="收到的回應：${esc(gotLabel)}">${got.map((r) => icon((REACTIONS.find((x) => x.id === r.type) || REACTIONS[0]).icon, 'ic-got')).join('')}</span>` : ''}
  </li>`;
}

function questCard(e) {
  const RESULT = { done: '帶回光點', little: '帶回葉子', 'not-today': '今天沒做' };
  let body;
  if (!e) body = '<span class="quest-title soft">還沒決定，選一件小事就好</span>';
  else if (e.status === 'rest') body = '<span class="quest-title soft">今天休息</span>';
  else {
    body = `<span class="quest-title">${esc(questLabel(myTitle(e), e.minutes))}</span>
      <span class="tags"><span class="tag">${e.visibility === 'private' ? '私人' : '公開'}</span>${e.status === 'onit' ? '<span class="tag">進行中</span>' : ''}${RESULT[e.status] ? `<span class="tag strong">${RESULT[e.status]}</span>` : ''}</span>`;
  }
  return `<section class="card quest-card"><span class="eyebrow">今天的一小步</span>${body}</section>`;
}

/** 首頁底部按鈕：依「今天的狀態」和「現在是早中晚」決定 */
function homeAction(e) {
  const w = windowOf();
  if (!e) return { cta: { label: '出發', action: 'go-setout' }, secondary: { label: '今天休息', action: 'rest-today' } };
  if (e.status === 'setout' || e.status === 'onit') {
    if (w === 'evening') return { cta: { label: '回營', action: 'go-evening' } };
    // 出發時間是伺服器的真實時間；管理者用測試時間時無法比較，就當成早上出發
    const setOutWin = e.setOutAt && (DEMO || getNowOverride() == null) ? windowOf(e.setOutAt) : 'morning';
    if (w === 'midday' && !e.middayAt && setOutWin === 'morning') return { cta: { label: '碰面', action: 'go-midday' } };
    if (e.status === 'setout') return { cta: { label: '我開始了', action: 'start-now' }, note: w === 'morning' ? '開始做的時候按一下，隊友會看到你正在進行' : '' };
    return { note: w === 'morning' ? '加油，中午見' : '加油，晚上見' };
  }
  if (e.status === 'rest') return { note: '好好休息，明天見' };
  return { note: '今天辛苦了，明天見' };
}

/* ---------- 早上出發 ---------- */

function setout() {
  const f = state.form;
  const has = f.title.trim().length > 0;
  const canShrink = has && !!smallerMinutes(f.minutes);
  return `<main class="screen has-cta">
    <header class="page-head with-back">
      <button class="back" data-action="back" aria-label="返回">${backIcon()}</button>
      <div><h1 class="title">${windowOf() === 'morning' ? '早上出發' : '出發'}</h1><p class="muted">選一件今天做得到的小事</p></div>
    </header>
    <section class="card form">
      <label class="field-label" for="q-title">想做什麼？</label>
      <input id="q-title" class="input" data-input="q-title" maxlength="${TITLE_MAX}" placeholder="例如：讀英文" value="${esc(f.title)}" autocomplete="off" enterkeyhint="done">
      <span class="field-label" id="lbl-min">時間</span>
      <div class="chips" role="radiogroup" aria-labelledby="lbl-min">${MINUTES.map((m) => `<button class="chip ${f.minutes === m ? 'on' : ''}" role="radio" aria-checked="${f.minutes === m}" data-action="set-min" data-v="${m}"><span class="num">${m}</span> 分鐘</button>`).join('')}</div>
      <span class="field-label" id="lbl-energy">現在的能量</span>
      <div class="chips grid2" role="radiogroup" aria-labelledby="lbl-energy">${ENERGY.map((x, i) => `<button class="chip ${f.energy === x.id ? 'on' : ''}" role="radio" aria-checked="${f.energy === x.id}" data-action="set-energy" data-v="${x.id}"><span class="meter m${i}" aria-hidden="true"></span>${x.label}</button>`).join('')}</div>
      <span class="field-label" id="lbl-vis">誰看得到</span>
      <div class="seg" role="radiogroup" aria-labelledby="lbl-vis">
        <button class="${f.visibility === 'public' ? 'on' : ''}" role="radio" aria-checked="${f.visibility === 'public'}" data-action="set-vis" data-v="public">公開</button>
        <button class="${f.visibility === 'private' ? 'on' : ''}" role="radio" aria-checked="${f.visibility === 'private'}" data-action="set-vis" data-v="private">${icon('icon_box', 'ic-xs')}私人</button>
      </div>
      <p class="hint">${visHint()}</p>
    </section>
    <section class="card helper">
      <div class="helper-head">${icon('icon_sparkle')}<div><b>不知道做什麼？</b><span class="muted small">一次只給一個建議，也可以把任務縮小</span></div></div>
      <div class="helper-btns">
        <button class="btn btn-pill" data-action="open-suggest">給我一個建議</button>
        <button class="btn btn-pill" data-action="shrink-form" ${canShrink ? '' : 'disabled'}>幫我縮小</button>
      </div>
    </section>
    <div class="cta-bar"><button class="btn btn-primary" data-action="submit-setout" ${has && !state.busy ? '' : 'disabled'}>${icon('icon_backpack', 'ic-btn')}出發</button></div>
  </main>`;
}

function visHint() {
  const f = state.form;
  if (f.visibility === 'private') return '私人：隊友只會看到「正在進行私人任務」，任務名稱只有你看得到。';
  return `公開：隊友會看到「出發了：${esc(questLabel(f.title.trim() || '…', f.minutes))}」`;
}

function backIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/* ---------- 底部面板：建議、選單 ---------- */

function sheet() {
  if (!state.sheet) return '';
  if (state.sheet.type === 'suggest') {
    const s = state.sheet;
    const t = s.list[s.idx];
    const energy = (ENERGY.find((x) => x.id === state.form.energy) || ENERGY[2]).label;
    return `<div class="sheet-wrap" data-action="close-sheet"><section class="sheet" role="dialog" aria-modal="true" aria-label="給你一個建議" data-stop>
      <div class="handle" aria-hidden="true"></div>
      <h2 class="sheet-title">給你一個建議</h2>
      <p class="muted small">依你選的 <span class="num">${state.form.minutes}</span> 分鐘和「${energy}」的能量</p>
      <span class="field-label">想做哪一類？</span>
      <div class="chips wrap">${CATEGORIES.map((c) => `<button class="chip ${s.category === c ? 'on' : ''}" data-action="pick-cat" data-v="${c}">${c}</button>`).join('')}</div>
      ${!s.category ? '<p class="muted small">先選一個類別。</p>' : t ? `<div class="suggest">
          ${icon('icon_sparkle')}
          <div><span class="quest-title">${esc(t.title)}</span><span class="tags"><span class="tag"><span class="num">${t.minutes}</span> 分鐘</span>${t.light ? '<span class="tag">輕鬆</span>' : ''}</span></div>
        </div>
        <div class="sheet-btns">
          <button class="btn btn-primary" data-action="use-suggest">就這個</button>
          <button class="btn btn-ghost" data-action="next-suggest" ${s.list.length > 1 ? '' : 'disabled'}>換一個（<span class="num">${s.idx + 1}/${s.list.length}</span>）</button>
        </div>` : '<p class="muted">這一類目前沒有適合的建議，換個類別或把時間拉長看看。</p>'}
    </section></div>`;
  }
  if (state.sheet.type === 'menu') {
    const canJournal = !!state.crew;
    return `<div class="sheet-wrap" data-action="close-sheet"><section class="sheet" role="dialog" aria-modal="true" aria-label="選單" data-stop>
      <div class="handle" aria-hidden="true"></div>
      <div class="menu-head">${avatar(myChar(), 'idle', { size: 'md' })}<div><h2 class="sheet-title">${esc((state.profile && state.profile.nickname) || '你')}</h2><p class="muted small">${esc((state.user && state.user.email) || '')}</p></div></div>
      <div class="menu-list">
        ${canJournal ? `<button class="btn btn-ghost" data-action="go-journal">${crewIsCurrent() ? '這週的足跡' : '上週的紀念樹'}</button>` : ''}
        ${state.isAdmin && !DEMO ? '<a class="btn btn-ghost" href="admin.html">管理頁</a>' : ''}
        ${DEMO ? '<a class="btn btn-ghost" href="admin.html?demo=1">看看示範管理頁</a>' : ''}
        <button class="btn btn-ghost" data-action="sign-out">登出</button>
      </div>
      <p class="muted tiny">伍伴 Wuplet <span class="num">${APP_VERSION}</span>${state.backend ? ` · ${esc(state.backend.mode === 'demo' ? '示範資料' : 'Firebase ' + state.backend.sdkVersion)}` : ''}</p>
    </section></div>`;
  }
  return '';
}

/* ---------- 任務出發 ---------- */

function launch() {
  const e = myEntry();
  const mates = membersOrdered().filter((m) => m.uid !== me());
  const w = windowOf();
  const line = w === 'morning' ? '生活在 App 外面。<br>中午見！' : w === 'midday' ? '生活在 App 外面。<br>晚上見！' : '去做吧。<br>做完回來說一聲。';
  return `<main class="screen has-cta launch">
    <div class="center">
      <div class="mates-row">${mates.map((m) => avatar(m.char, viewOf(m.uid).state, { size: 'sm' })).join('')}</div>
      <p class="muted small">隊友也各自在路上</p>
      <img class="hero-char big" src="${asset.char(myChar(), 'setout')}" alt="">
      <section class="card quest-card">
        <span class="eyebrow">今天的一小步</span>
        <span class="quest-title">${esc(questLabel(myTitle(e), e && e.minutes))}</span>
        <span class="tags"><span class="tag">${e && e.visibility === 'private' ? '私人' : '公開'}</span></span>
      </section>
      <p class="big-line">${line}</p>
    </div>
    <div class="cta-bar"><button class="btn btn-primary" data-action="launch-done">去做吧</button></div>
  </main>`;
}

/* ---------- 中午碰面 ---------- */

const BADGE = { setout: 'icon_backpack', onit: 'icon_backpack', private: 'icon_box', done: 'icon_orb', little: 'icon_leaf', rest: 'icon_blanket' };

function midday() {
  const e = myEntry();
  if (!e) return home();
  const small = smallerMinutes(e.minutes);
  return `<main class="screen">
    <header class="page-head with-back">
      <button class="back" data-action="back" aria-label="返回">${backIcon()}</button>
      <div><h1 class="title">中午碰面</h1><p class="muted num">${formatHM()}</p></div>
    </header>
    <p class="section-title">大家都還在路上</p>
    <div class="mates-row badges">${membersOrdered().map((m) => {
      const v = viewOf(m.uid);
      const info = mateInfo(m.uid);
      return `<span class="mate">${avatar(m.char, v.state, { size: 'md', badge: BADGE[v.state] })}<span class="mate-name">${m.uid === me() ? '你' : esc((info && info.nickname) || '旅伴')}</span></span>`;
    }).join('')}</div>
    <section class="card quest-card">
      <span class="eyebrow">你的一小步</span>
      <span class="quest-title">${esc(questLabel(myTitle(e), e.minutes))}</span>
      <span class="muted small">${e.status === 'onit' ? '已經開始了，很好' : '還沒開始也沒關係'}</span>
    </section>
    <div class="options">
      <button class="opt" data-action="noon-keep">${icon('icon_backpack', 'opt-ic')}<span><b>保留</b><span class="muted small">照原計畫</span></span></button>
      ${small ? `<button class="opt" data-action="noon-shrink">${icon('icon_sprout', 'opt-ic')}<span><b>縮小成 <span class="num">${small}</span> 分鐘</b><span class="muted small">先做第一步也很好</span></span></button>` : ''}
      <button class="opt" data-action="noon-rest">${icon('icon_blanket', 'opt-ic')}<span><b>今天休息</b><span class="muted small">休息也是前進的一部分</span></span></button>
    </div>
    <p class="muted small center-text">選好就可以關掉 App，晚上見</p>
  </main>`;
}

/* ---------- 晚上回營 ---------- */

function evening() {
  const e = myEntry();
  if (!e) return home();
  const ev = state.evening || { result: null, note: '' };
  const others = countSteps(state.days.filter((d) => !(d.uid === me() && d.date === state.today)));
  const plus = ev.result === 'done' || ev.result === 'little';
  const results = [
    { id: 'done', label: '完成', ic: 'icon_orb' },
    { id: 'little', label: '做了一點', ic: 'icon_leaf' },
    { id: 'not-today', label: '今天沒做', ic: 'icon_blanket' },
  ];
  const mates = membersOrdered().filter((m) => m.uid !== me());
  const mateRows = mates.map((m) => {
    const v = viewOf(m.uid);
    const info = mateInfo(m.uid);
    const entry = entryOf(m.uid);
    const mine = state.reactions.find((r) => r.from === me() && r.to === m.uid);
    const name = esc((info && info.nickname) || '旅伴');
    return `<li class="member">
      ${avatar(m.char, v.state, { size: 'md' })}
      <div class="member-text"><span class="member-name">${name}</span><span class="member-status">${esc(v.sentence)}</span>${entry && entry.publicNote ? `<span class="member-note">「${esc(entry.publicNote)}」</span>` : ''}</div>
      ${entry ? `<span class="reacts" role="group" aria-label="給 ${name} 一個回應">${REACTIONS.map((r) => `<button class="react ${mine && mine.type === r.id ? 'on' : ''}" data-action="react" data-to="${m.uid}" data-v="${r.id}" aria-pressed="${!!(mine && mine.type === r.id)}" aria-label="${r.label}">${icon(r.icon, 'ic-react')}</button>`).join('')}</span>` : ''}
    </li>`;
  }).join('');
  return `<main class="screen has-cta">
    <header class="page-head with-back">
      <button class="back" data-action="back" aria-label="返回">${backIcon()}</button>
      <div><h1 class="title">晚上回營</h1><p class="muted">${esc(questLabel(myTitle(e), e.minutes))}</p></div>
    </header>
    <h2 class="section-title big">今天帶回了什麼？</h2>
    <div class="results" role="radiogroup" aria-label="今天的結果">${results.map((r) => `<button class="result ${ev.result === r.id ? 'on' : ''}" role="radio" data-action="pick-result" data-v="${r.id}" aria-checked="${ev.result === r.id}">${icon(r.ic, 'result-ic')}<span>${r.label}</span></button>`).join('')}</div>
    <p class="result-hint">${ev.result === 'not-today' ? '沒關係，回來說一聲就很好。隊友會看到你在營火旁休息。' : ev.result ? '一小步也算數。' : '沒有失敗，只有帶回來的東西不一樣。'}</p>
    <label class="field-label" for="note">一句心得（選填${e.visibility === 'private' ? '，只有你看得到' : '，隊友看得到'}）</label>
    <textarea id="note" class="input" rows="2" maxlength="${NOTE_MAX}" data-input="note" placeholder="今天想說的一句話">${esc(ev.note)}</textarea>
    <p class="camp-hint">${icon('icon_orb', 'ic-xs')}<span>${plus ? `營火 +1 步，這週一共 <b class="num">${others + 1}</b> 步` : `這週營火 <b class="num">${others}</b> 步`}</span></p>
    ${mates.length ? `<h2 class="section-title">隊友今天</h2><ul class="card crew-list">${mateRows}</ul>` : ''}
    <div class="cta-bar"><button class="btn btn-primary" data-action="submit-evening" ${ev.result && !state.busy ? '' : 'disabled'}>結束今天</button></div>
  </main>`;
}

/* ---------- 一週回顧 ---------- */

function journal() {
  const crew = state.crew;
  if (!crew) return loading();
  const forest = forestBy(crew.forest);
  const next = forestBy(nextForest(crew.forest));
  const steps = countSteps(state.days);
  const dots = treeDots(steps, crew.id);
  const current = crew.weekStart === state.weekStart;
  const weekOver = !current || dayIndex(state.today, crew.weekStart) >= 7;
  const ICON = { done: 'icon_orb', little: 'icon_leaf', rest: 'icon_blanket', setout: 'icon_backpack', onit: 'icon_backpack' };
  let wentOut = false;
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(crew.weekStart, i);
    const e = state.days.find((d) => d.uid === me() && d.date === date);
    const s = e ? e.status : null;
    if (s === 'setout' || s === 'onit') wentOut = true;
    const inner = s && ICON[s] ? icon(ICON[s], `ic-day ${s === 'setout' || s === 'onit' ? 'faded' : ''}`) : s === 'not-today' ? '<span class="ring"></span>' : '';
    const isToday = current && date === state.today;
    return `<li><span class="day-dot ${s ? 'has' : ''} ${isToday ? 'today' : ''}">${inner}</span><span class="day-label">${WEEKDAY_ZH[i]}</span></li>`;
  }).join('');
  const cta = weekOver ? '前往下一座森林' : '回到營地';
  return `<main class="screen has-cta journal">
    <header class="page-head with-back">
      <button class="back" data-action="back" aria-label="返回">${backIcon()}</button>
      <div><h1 class="title">${weekOver ? '一週回顧' : '這週的足跡'}</h1><p class="muted">${esc(forest.zh)} · ${formatMD(crew.weekStart)} – ${formatMD(addDays(crew.weekStart, 6))}</p></div>
    </header>
    <h2 class="section-title">${current ? '這週' : '上週'}你留下了這些</h2>
    <ul class="week">${week}</ul>
    <p class="legend"><span>${icon('icon_orb', 'ic-xs')}完成</span><span>${icon('icon_leaf', 'ic-xs')}做了一點</span><span>${icon('icon_blanket', 'ic-xs')}休息</span><span><span class="ring sm"></span>今天沒做</span>${wentOut ? `<span>${icon('icon_backpack', 'ic-xs faded')}出發了</span>` : ''}</p>
    <section class="tree-card">
      <div class="tree-art">
        <img src="${asset.camp('tree')}" alt="小隊的紀念樹，樹上有 ${steps} 顆光點">
        ${dots.map((d) => `<i class="tree-dot" style="left:${(d.x * 100).toFixed(1)}%;top:${(d.y * 100).toFixed(1)}%;--s:${d.s.toFixed(2)};--d:${d.d.toFixed(2)}s"></i>`).join('')}
      </div>
      <div class="tree-text">
        <span class="eyebrow">小隊的紀念樹</span>
        <p class="tree-line">這週小隊一起帶回 <b class="num">${steps}</b> 步</p>
        <p class="muted small">${steps > 0 ? '一步一顆光點。五種生活，一起走過一週。' : '這週很安靜，紀念樹還是會等你們。'}</p>
      </div>
    </section>
    ${weekOver ? `<section class="card next-card">
      <img src="${asset.forest(next.id)}" alt="">
      <div><span class="eyebrow">下一站</span><b class="next-name">${esc(next.zh)}</b><span class="latin muted small">${esc(next.en)}</span><span class="muted small">下週一會遇到新的同行者</span></div>
    </section>
    <p class="center-text muted">謝謝你這週來過</p>` : ''}
    <div class="cta-bar"><button class="btn btn-primary" data-action="journal-next">${cta}</button></div>
  </main>`;
}

/* ================= 動作 ================= */

const actions = {
  reload: () => location.reload(),
  'clear-fake': () => {
    try { localStorage.removeItem(FAKE_KEY); } catch (e) { /* 忽略 */ }
    location.reload();
  },
  'copy-url': async () => {
    try {
      await navigator.clipboard.writeText(location.href.split('#')[0]);
      toast('網址複製好了，貼到 Chrome 或 Safari 打開');
    } catch (e) { toast('請長按網址列手動複製'); }
  },
  'sign-in': () => {
    // 不能先 await 別的東西，否則瀏覽器會擋登入視窗
    state.loginError = '';
    state.backend.signIn().catch((err) => {
      console.error(err);
      state.loginError = friendlyError(err);
      render();
    });
  },
  'sign-out': async () => {
    state.sheet = null;
    try { await state.backend.signOut(); } catch (err) { onError(err); }
  },
  'open-menu': () => { state.sheet = { type: 'menu' }; render(); },
  'close-sheet': () => { state.sheet = null; render(); },

  'pick-char': (el) => {
    const id = el.dataset.char;
    const p = state.onboard.prefs;
    const i = p.indexOf(id);
    if (i >= 0) p.splice(i, 1);
    else if (p.length < 2) p.push(id);
    else p[1] = id;
    render();
  },
  'finish-onboarding': async () => {
    const nickname = state.onboard.nickname.trim().slice(0, NICK_MAX);
    if (!nickname || state.onboard.prefs.length !== 2 || state.busy) return;
    state.busy = true;
    render();
    try {
      await state.backend.createUser(me(), { nickname, prefs: state.onboard.prefs.slice() });
      toast(`歡迎，${nickname}`);
    } catch (err) { onError(err); }
    state.busy = false;
    render();
  },

  back: () => closeSub(),
  'go-home': () => go('home'),
  'go-setout': () => {
    state.form = { title: '', minutes: 10, energy: 'normal', visibility: 'public', templateId: null };
    openSub('setout');
  },
  'go-midday': () => openSub('midday'),
  'go-evening': () => { state.evening = { result: null, note: '' }; openSub('evening'); },
  'go-journal': () => openSub('journal'),
  'launch-done': () => {
    const w = windowOf();
    closeSub('home');
    toast(w === 'morning' ? '中午見' : w === 'midday' ? '晚上見' : '做完回來說一聲');
  },
  'journal-next': () => {
    const crew = state.crew;
    const current = crew && crew.weekStart === state.weekStart;
    if (current && dayIndex(state.today, crew.weekStart) < 7) return closeSub('home');
    if (current) { state.waiting = { kind: 'tonight' }; return closeSub('waiting'); }
    if (crewIsCurrent()) return closeSub('home');
    if (!state.waiting) state.waiting = { kind: 'matching' };
    return closeSub('waiting');
  },

  'rest-today': async () => {
    if (!state.confirmRest) { state.confirmRest = true; render(); return; }
    state.confirmRest = false;
    try {
      await state.backend.createDay(state.crewId, me(), state.today, { status: 'rest', visibility: 'public' });
      toast('好好休息，明天見');
    } catch (err) { onError(err); }
    render();
  },
  'start-now': async () => {
    try {
      await state.backend.updateDay(state.crewId, me(), state.today, { status: 'onit' });
      toast(windowOf() === 'morning' ? '加油，中午見' : '加油，晚上見');
    } catch (err) { onError(err); }
  },

  'set-min': (el) => { state.form.minutes = Number(el.dataset.v); render(); },
  'set-energy': (el) => { state.form.energy = el.dataset.v; render(); },
  'set-vis': (el) => { state.form.visibility = el.dataset.v; render(); },
  'open-suggest': () => { state.sheet = { type: 'suggest', category: null, list: [], idx: 0 }; render(); },
  'pick-cat': (el) => {
    const list = recommend(state.templates, { category: el.dataset.v, minutes: state.form.minutes, energy: state.form.energy });
    state.sheet = { type: 'suggest', category: el.dataset.v, list, idx: 0 };
    render();
  },
  'next-suggest': () => {
    const s = state.sheet;
    if (s.list.length) s.idx = (s.idx + 1) % s.list.length;
    render();
  },
  'use-suggest': () => {
    const t = state.sheet.list[state.sheet.idx];
    if (t) Object.assign(state.form, { title: t.title, minutes: t.minutes, templateId: t.id });
    state.sheet = null;
    render();
  },
  'shrink-form': () => {
    const s = shrinkQuest(state.form, state.templates);
    if (!s) { toast('已經是最小的一步了'); return; }
    Object.assign(state.form, { title: s.title.slice(0, TITLE_MAX + 6), minutes: s.minutes });
    toast(`縮小成 ${s.minutes} 分鐘`);
    render();
  },
  'submit-setout': async () => {
    const f = state.form;
    const title = f.title.trim();
    if (!title || state.busy) return;
    state.busy = true;
    render();
    try {
      const priv = f.visibility === 'private';
      if (priv) {
        // 私人任務的名稱和範本只存在自己的私人資料裡
        await state.backend.savePrivate(me(), state.today, { title, templateId: f.templateId || null });
        state.privateToday = { title, templateId: f.templateId || null };
        state.privateFor = state.today;
      }
      await state.backend.createDay(state.crewId, me(), state.today, {
        status: 'setout',
        visibility: f.visibility,
        publicTitle: priv ? null : title,
        minutes: f.minutes,
        energy: f.energy,
        templateId: priv ? null : f.templateId,
        setOutSeconds: Math.max(0, Math.round((Date.now() - state.openedAt) / 1000)),
      }, { setOut: true });
      state.busy = false;
      go('launch');
    } catch (err) {
      state.busy = false;
      onError(err);
      render();
    }
  },

  'noon-keep': async () => {
    try {
      await state.backend.updateDay(state.crewId, me(), state.today, {}, { midday: true });
      closeSub('home');
      toast('照原計畫，晚上見');
    } catch (err) { onError(err); }
  },
  'noon-shrink': async () => {
    const e = myEntry();
    if (!e) return;
    const priv = e.visibility === 'private';
    const templateId = priv ? (state.privateToday && state.privateToday.templateId) || null : e.templateId;
    const s = shrinkQuest({ title: myTitle(e), minutes: e.minutes, templateId }, state.templates);
    if (!s) return;
    try {
      if (priv) {
        await state.backend.savePrivate(me(), state.today, { title: s.title });
        state.privateToday = { ...(state.privateToday || {}), title: s.title };
        await state.backend.updateDay(state.crewId, me(), state.today, { minutes: s.minutes }, { midday: true });
      } else {
        await state.backend.updateDay(state.crewId, me(), state.today, { minutes: s.minutes, publicTitle: s.title }, { midday: true });
      }
      closeSub('home');
      toast(`縮小成 ${s.minutes} 分鐘了，晚上見`);
    } catch (err) { onError(err); }
  },
  'noon-rest': async () => {
    try {
      await state.backend.updateDay(state.crewId, me(), state.today, { status: 'rest' }, { midday: true });
      closeSub('home');
      toast('好好休息，明天見');
    } catch (err) { onError(err); }
  },

  'pick-result': (el) => { state.evening.result = el.dataset.v; render(); },
  react: async (el) => {
    const to = el.dataset.to;
    const type = el.dataset.v;
    const mine = state.reactions.find((r) => r.from === me() && r.to === to);
    try {
      if (mine && mine.type === type) await state.backend.removeReaction(state.crewId, { date: state.today, from: me(), to });
      else await state.backend.setReaction(state.crewId, { date: state.today, from: me(), to, type });
    } catch (err) { onError(err); }
  },
  'submit-evening': async () => {
    const e = myEntry();
    const ev = state.evening;
    if (!e || !ev || !ev.result || state.busy) return;
    state.busy = true;
    render();
    const note = ev.note.trim().slice(0, NOTE_MAX) || null;
    try {
      if (e.visibility === 'private') {
        if (note) await state.backend.savePrivate(me(), state.today, { note });
        await state.backend.updateDay(state.crewId, me(), state.today, { status: ev.result });
      } else {
        await state.backend.updateDay(state.crewId, me(), state.today, { status: ev.result, publicNote: note });
      }
      state.busy = false;
      const sunday = dayIndex(state.today, state.crew.weekStart) === 7;
      if (sunday) go('journal');
      else closeSub('home');
      toast(ev.result === 'not-today' ? '謝謝你回來說一聲，明天見' : '營火 +1 步');
    } catch (err) {
      state.busy = false;
      onError(err);
      render();
    }
  },
};

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !app.contains(el)) return;
  // 點在面板裡面（不是按鈕）不關面板
  if (el.dataset.action === 'close-sheet' && ev.target.closest('[data-stop]')) return;
  if (el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    if (el.tagName !== 'A') ev.preventDefault();
    fn(el);
  }
});

app.addEventListener('input', (ev) => {
  const el = ev.target;
  const k = el.dataset && el.dataset.input;
  if (!k) return;
  if (k === 'nickname') state.onboard.nickname = el.value;
  if (k === 'q-title') { state.form.title = el.value; state.form.templateId = null; }
  if (k === 'note' && state.evening) state.evening.note = el.value;
  refreshButtons();
});

app.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.sheet) { state.sheet = null; render(); }
  if (ev.key === 'Enter' && ev.target.id === 'q-title') ev.target.blur();
});

/** 打字時不重畫整頁，只更新按鈕和提示 */
function refreshButtons() {
  if (state.route === 'onboarding') {
    const ok = state.onboard.nickname.trim().length > 0 && state.onboard.prefs.length === 2 && !state.busy;
    const b = app.querySelector('[data-action="finish-onboarding"]');
    if (b) b.disabled = !ok;
  }
  if (state.route === 'setout') {
    const has = state.form.title.trim().length > 0;
    const b = app.querySelector('[data-action="submit-setout"]');
    if (b) b.disabled = !has || state.busy;
    const s = app.querySelector('[data-action="shrink-form"]');
    if (s) s.disabled = !(has && smallerMinutes(state.form.minutes));
    const hint = app.querySelector('.hint');
    if (hint) hint.innerHTML = visHint();
  }
}

/* ================= 資料同步 ================= */

function clearCrewSubs() {
  for (const k of ['crew', 'days', 'reactions']) {
    if (subs[k]) subs[k]();
    subs[k] = null;
  }
  for (const u of Object.values(subs.mates)) u();
  subs.mates = {};
  state.crewId = null;
  state.crew = null;
  state.days = [];
  state.reactions = [];
  state.mates = {};
}

function clearAllSubs() {
  if (subs.profile) subs.profile();
  subs.profile = null;
  clearCrewSubs();
}

function subscribeCrew(crewId) {
  if (state.crewId === crewId && subs.crew) return;
  clearCrewSubs();
  state.crewId = crewId;
  subs.crew = state.backend.watchCrew(crewId, (crew) => {
    state.crew = crew;
    if (!crew) {
      // 小隊被管理者重新配對刪掉了，等個人資料更新
      if (['home', 'midday', 'evening', 'setout', 'launch'].includes(state.route)) {
        state.waiting = { kind: 'matching' };
        go('waiting');
      }
      return;
    }
    if (crew.weekStart === state.weekStart) syncMates();
    if (state.route === 'loading') go(baseRoute());
    else softRender();
  }, onError);
  subs.days = state.backend.watchCrewDays(crewId, (days) => {
    state.days = days;
    ensurePrivate();
    softRender();
  }, onError);
  subscribeReactions();
}

function subscribeReactions() {
  if (subs.reactions) subs.reactions();
  subs.reactions = null;
  state.reactions = [];
  if (!state.crewId) return;
  subs.reactions = state.backend.watchReactions(state.crewId, state.today, (rs) => {
    state.reactions = rs;
    softRender();
  }, (err) => console.warn('reactions', err));
}

function syncMates() {
  const ids = Object.keys((state.crew && state.crew.members) || {}).filter((u) => u !== me());
  for (const [uid, unsub] of Object.entries(subs.mates)) {
    if (!ids.includes(uid)) {
      unsub();
      delete subs.mates[uid];
      delete state.mates[uid];
    }
  }
  for (const uid of ids) {
    if (!subs.mates[uid]) {
      subs.mates[uid] = state.backend.watchUser(uid, (u) => {
        state.mates[uid] = u;
        softRender();
      }, (err) => console.warn('mate', uid, err));
    }
  }
}

async function ensurePrivate() {
  const e = myEntry();
  if (!e || e.visibility !== 'private' || state.privateFor === state.today) return;
  state.privateFor = state.today;
  try {
    state.privateToday = await state.backend.getPrivate(me(), state.today);
    softRender();
  } catch (err) { console.warn('private', err); }
}

async function touchOnce(force = false) {
  if (!state.profile || (!force && state.touched === state.today)) return;
  state.touched = state.today;
  try { await state.backend.touchPresence(me(), state.today); } catch (err) { console.warn('presence', err); }
}

async function onAuth(user) {
  const seq = ++authSeq;
  clearAllSubs();
  state.user = user;
  state.profile = undefined;
  state.joinTried = false;
  state.joining = false;
  state.touched = '';
  state.privateToday = null;
  state.privateFor = '';
  if (!user) {
    state.isAdmin = false;
    go('login');
    return;
  }
  go('loading');
  const admin = await state.backend.isAdmin();
  if (seq !== authSeq) return; // 這段時間又換了帳號
  state.isAdmin = admin;
  if (admin && !DEMO) {
    try {
      const v = Number(localStorage.getItem(FAKE_KEY));
      if (v) setNowOverride(v);
    } catch (e) { /* 不能用 localStorage 就用真實時間 */ }
  }
  refreshClock();
  subs.profile = state.backend.watchUser(user.uid, onProfile, (err) => {
    console.error(err);
    const denied = String((err && err.code) || '').includes('permission-denied');
    state.error = {
      title: denied ? '讀不到你的資料' : '連線出了問題',
      text: denied
        ? '安全規則擋住了。如果你是管理者，請確認 Firestore 的安全規則已經貼上並「發布」。'
        : '可能是網路不穩，請稍後重新整理再試一次。',
      detail: String((err && (err.code || err.message)) || err),
    };
    go('error');
  });
}

function onProfile(profile) {
  state.profile = profile;
  if (!profile) {
    clearCrewSubs();
    if (state.route !== 'onboarding') {
      state.onboard = { nickname: '', prefs: [] };
      go('onboarding');
    }
    return;
  }
  touchOnce();
  syncCrew();
}

async function syncCrew() {
  const p = state.profile;
  if (!p) return;
  const seq = ++syncSeq;
  refreshClock();

  // 這週已經有小隊
  if (p.crewId && p.crewWeek === state.weekStart) {
    state.joining = false;
    subscribeCrew(p.crewId);
    const stay = state.route === 'waiting' && state.waiting && state.waiting.kind === 'tonight';
    if (['loading', 'onboarding', 'login', 'error'].includes(state.route) || (state.route === 'waiting' && !stay)) {
      if (state.crew && state.crew.weekStart === state.weekStart) go('home');
      else go('loading'); // 等小隊資料到了再進首頁
    } else softRender();
    return;
  }
  if (state.joining) return;

  // 這週還沒有小隊：上週的小隊留著，給「看看上週」用
  if (p.crewId && p.crewWeek === prevWeekStart(state.weekStart)) subscribeCrew(p.crewId);
  else clearCrewSubs();

  let meta = null;
  try { meta = await state.backend.getWeekMeta(state.weekStart); } catch (err) { console.warn('week', err); }
  if (seq !== syncSeq) return; // 有更新的同步在跑

  const isNew = p.createdAt != null && p.createdAt >= weekBoundaryMs(state.weekStart);
  if (meta && !isNew && !state.joinTried) {
    // 本週已經配對過、但自己沒有小隊（例如上週出遠門）→ 自動找有空位的小隊
    state.joinTried = true;
    state.joining = true;
    state.waiting = { kind: 'joining' };
    go('waiting');
    const ok = await tryAutoJoin(p);
    state.joining = false;
    if (ok || crewIsCurrent()) return; // 個人資料更新後會自動進首頁
    state.waiting = { kind: 'noSpace' };
    if (state.route === 'waiting') go('waiting');
    return;
  }
  state.waiting = { kind: !meta ? 'matching' : isNew ? 'newWeek' : 'noSpace' };
  if (state.route === 'journal') softRender();
  else go('waiting');
}

async function tryAutoJoin(p) {
  try {
    const crews = await state.backend.listCrewsForWeek(state.weekStart);
    for (const c of openCrewCandidates(crews, p.currentForest || 1)) {
      try {
        await state.backend.joinCrew(c.id, me(), p.prefs, { currentForest: c.forest });
        toast('歡迎回來，已經幫你加入有空位的小隊');
        return true;
      } catch (err) { console.warn('join', c.id, err); }
    }
  } catch (err) { console.warn('join list', err); }
  return false;
}

let lastWindow = windowOf();

function tick() {
  const day = state.today;
  const week = state.weekStart;
  const win = windowOf();
  const windowChanged = win !== lastWindow;
  lastWindow = win;
  refreshClock();
  if (state.weekStart !== week) {
    state.joinTried = false;
    syncCrew();
  } else if (state.today !== day) {
    subscribeReactions();
    state.privateToday = null;
    state.privateFor = '';
    ensurePrivate();
    touchOnce();
  }
  // 只有早中晚換了、或換日時才重畫（避免每 30 秒整頁重畫讓圖片閃一下）
  const changed = windowChanged || state.today !== day || state.weekStart !== week;
  if (changed && !['setout', 'onboarding', 'evening'].includes(state.route) && !state.sheet) softRender();
}

// 管理者在管理頁改了測試時間：其他分頁的 App 跟著換
window.addEventListener('storage', (ev) => {
  if (ev.key !== FAKE_KEY || DEMO || !state.isAdmin) return;
  setNowOverride(Number(ev.newValue) || null);
  state.joinTried = false;
  state.privateToday = null;
  state.privateFor = '';
  refreshClock();
  subscribeReactions();
  ensurePrivate();
  syncCrew();
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.hiddenAt = Date.now(); return; }
  if (state.hiddenAt && Date.now() - state.hiddenAt > 5 * 60e3) {
    state.openedAt = Date.now();
    touchOnce(true);
  }
  tick();
});

/* ================= 啟動 ================= */

async function boot() {
  render();
  try {
    const getJson = (url) => fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return r.json();
    });
    const [backend, forests, templates] = await Promise.all([
      createBackend({ demo: DEMO, scene: SCENE }),
      getJson('content/forests.json'),
      getJson('content/quest_templates.json'),
    ]);
    state.backend = backend;
    state.forests = forests.forests || [];
    state.templates = templates.templates || [];
  } catch (err) {
    console.error(err);
    state.error = {
      title: '載入失敗',
      text: '可能是網路不穩，或 Firebase 暫時連不上。請重新整理再試一次。',
      detail: String((err && err.message) || err),
    };
    go('error');
    return;
  }
  state.backend.onAuth(onAuth);
  setInterval(tick, 30000);
}

boot();
