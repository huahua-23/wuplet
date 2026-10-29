// 伍伴 Wuplet — 正式資料層：Firebase Authentication（Google 登入）＋ Cloud Firestore
//
// 資料結構
//   users/{uid}                          暱稱、兩個角色志願、所在森林、本週小隊、最後上線時間
//   users/{uid}/journeys/{weekStart}     森林手帳（結算時由管理者寫入）
//   crews/{crewId}                       小隊：weekStart、forest、members {uid: {c 角色, j 加入時間}}、chars、steps、settled
//   crews/{crewId}/days/{date_uid}       每人每日狀態
//   crews/{crewId}/reactions/{date_from_to}  小回應
//   private/{uid}/quests/{date}          私人任務的標題與心得（只有本人讀得到）
//   appOpens/{date_uid}                  每天有沒有打開 App（算測試指標）
//   weeks/{weekStart}                    這週配對過了沒（大家都讀得到，只有時間和隊數）
//   adminOnly/probe                      用來確認目前登入的人是不是管理者
//   adminOnly/before-{weekStart}         配對前每個人的森林與小隊（重新配對時還原用，只有管理者讀得到）
import { firebaseConfig, FIREBASE_SDK_VERSIONS } from './config.js';
import { MAX_CREW } from './constants.js';
import { pickCharacter } from './logic.js';

const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
};

async function loadSdk() {
  let lastErr = null;
  for (const v of FIREBASE_SDK_VERSIONS) {
    const base = `https://www.gstatic.com/firebasejs/${v}`;
    try {
      const [app, auth, fs] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
      ]);
      return { app, auth, fs, version: v };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Firebase SDK 載入失敗');
}

export async function createFirebaseBackend() {
  const sdk = await loadSdk();
  const { initializeApp } = sdk.app;
  const A = sdk.auth;
  const F = sdk.fs;
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  try { auth.languageCode = 'zh-TW'; } catch (e) { /* 不影響登入 */ }
  const db = F.getFirestore(app);
  const { doc, collection, query, where, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, runTransaction, writeBatch, Timestamp, arrayUnion } = F;

  const data = (snap) => snap.data({ serverTimestamps: 'estimate' });

  const normUser = (snap) => {
    const d = data(snap);
    return {
      uid: snap.id,
      nickname: d.nickname || '',
      prefs: Array.isArray(d.prefs) ? d.prefs : [],
      currentForest: d.currentForest || 1,
      crewId: d.crewId || null,
      crewWeek: d.crewWeek || null,
      createdAt: toMs(d.createdAt),
      lastSeenAt: toMs(d.lastSeenAt),
      isTest: !!d.isTest,
    };
  };
  const normCrew = (snap) => {
    const d = data(snap);
    const members = {};
    for (const [uid, m] of Object.entries(d.members || {})) members[uid] = { c: m.c, j: toMs(m.j) };
    return { id: snap.id, weekStart: d.weekStart, forest: d.forest, members, chars: d.chars || [], steps: d.steps || 0, settled: !!d.settled };
  };
  const normDay = (snap) => {
    const d = data(snap);
    return { ...d, id: snap.id, setOutAt: toMs(d.setOutAt), middayAt: toMs(d.middayAt), updatedAt: toMs(d.updatedAt) };
  };
  const normReaction = (snap) => ({ ...data(snap), id: snap.id, at: toMs(data(snap).at) });

  // 寫入 / 讀取上限，避免一次超過 500 筆
  async function commitInChunks(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      for (const op of ops.slice(i, i + 400)) op(batch);
      await batch.commit();
    }
  }

  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  return {
    mode: 'firebase',
    sdkVersion: sdk.version,

    /* ---------- 登入 ---------- */
    onAuth(cb) {
      return A.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email || '', displayName: u.displayName || '' } : null));
    },
    signIn() {
      // 一定要在按鈕的 click 裡直接呼叫，前面不能先 await，才不會被擋彈出視窗
      return A.signInWithPopup(auth, provider);
    },
    signOut() {
      return A.signOut(auth);
    },

    /* ---------- 使用者 ---------- */
    watchUser(uid, cb, onErr) {
      return onSnapshot(doc(db, 'users', uid), (s) => cb(s.exists() ? normUser(s) : null), onErr);
    },
    async getUser(uid) {
      const s = await getDoc(doc(db, 'users', uid));
      return s.exists() ? normUser(s) : null;
    },
    createUser(uid, { nickname, prefs }) {
      return setDoc(doc(db, 'users', uid), {
        nickname, prefs, currentForest: 1, crewId: null, crewWeek: null,
        createdAt: serverTimestamp(), lastSeenAt: serverTimestamp(),
      });
    },
    updateUser(uid, patch) {
      return updateDoc(doc(db, 'users', uid), patch);
    },
    async touchPresence(uid, date) {
      await updateDoc(doc(db, 'users', uid), { lastSeenAt: serverTimestamp() });
      await setDoc(doc(db, 'appOpens', `${date}_${uid}`), { uid, date, at: serverTimestamp() });
    },
    async isAdmin() {
      try {
        await getDoc(doc(db, 'adminOnly', 'probe'));
        return true;
      } catch (e) {
        return false;
      }
    },

    /* ---------- 小隊 ---------- */
    watchCrew(crewId, cb, onErr) {
      return onSnapshot(doc(db, 'crews', crewId), (s) => cb(s.exists() ? normCrew(s) : null), onErr);
    },
    watchCrewDays(crewId, cb, onErr) {
      return onSnapshot(collection(db, 'crews', crewId, 'days'), (qs) => cb(qs.docs.map(normDay)), onErr);
    },
    watchReactions(crewId, date, cb, onErr) {
      return onSnapshot(query(collection(db, 'crews', crewId, 'reactions'), where('date', '==', date)), (qs) => cb(qs.docs.map(normReaction)), onErr);
    },
    async getCrewDays(crewId) {
      const qs = await getDocs(collection(db, 'crews', crewId, 'days'));
      return qs.docs.map(normDay);
    },
    async getCrew(crewId) {
      const s = await getDoc(doc(db, 'crews', crewId));
      return s.exists() ? normCrew(s) : null;
    },
    /** 建立今天的狀態。setOut = true 代表按了「出發」 */
    createDay(crewId, uid, date, fields, { setOut = false } = {}) {
      return setDoc(doc(db, 'crews', crewId, 'days', `${date}_${uid}`), {
        uid, date, crewId,
        status: fields.status,
        visibility: fields.visibility || 'public',
        publicTitle: fields.publicTitle ?? null,
        minutes: fields.minutes ?? null,
        energy: fields.energy ?? null,
        templateId: fields.templateId ?? null,
        publicNote: null,
        setOutAt: setOut ? serverTimestamp() : null,
        setOutSeconds: fields.setOutSeconds ?? null,
        middayAt: null,
        updatedAt: serverTimestamp(),
      });
    },
    /** 更新今天的狀態。midday = true 代表在「中午碰面」做了選擇 */
    updateDay(crewId, uid, date, patch, { midday = false } = {}) {
      const p = { ...patch, updatedAt: serverTimestamp() };
      if (midday) p.middayAt = serverTimestamp();
      return updateDoc(doc(db, 'crews', crewId, 'days', `${date}_${uid}`), p);
    },
    async getPrivate(uid, date) {
      const s = await getDoc(doc(db, 'private', uid, 'quests', date));
      if (!s.exists()) return null;
      const d = data(s);
      return { ...d, updatedAt: toMs(d.updatedAt) };
    },
    /** 私人任務的標題、心得、範本（只有本人讀得到） */
    savePrivate(uid, date, { title, note, templateId }) {
      const patch = { updatedAt: serverTimestamp() };
      if (title !== undefined) patch.title = title;
      if (note !== undefined) patch.note = note;
      if (templateId !== undefined) patch.templateId = templateId;
      return setDoc(doc(db, 'private', uid, 'quests', date), patch, { merge: true });
    },
    setReaction(crewId, { date, from, to, type }) {
      return setDoc(doc(db, 'crews', crewId, 'reactions', `${date}_${from}_${to}`), { date, from, to, type, at: serverTimestamp() });
    },
    removeReaction(crewId, { date, from, to }) {
      return deleteDoc(doc(db, 'crews', crewId, 'reactions', `${date}_${from}_${to}`));
    },
    async getWeekMeta(weekStart) {
      const s = await getDoc(doc(db, 'weeks', weekStart));
      if (!s.exists()) return null;
      const d = data(s);
      return { ...d, matchedAt: toMs(d.matchedAt) };
    },
    async listCrewsForWeek(weekStart) {
      const qs = await getDocs(query(collection(db, 'crews'), where('weekStart', '==', weekStart)));
      return qs.docs.map(normCrew);
    },
    /** 中途回來的人自己加入有空位的小隊（安全規則只允許把自己加進去） */
    async joinCrew(crewId, uid, prefs, userPatch = {}) {
      return runTransaction(db, async (tx) => {
        const ref = doc(db, 'crews', crewId);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('crew-missing');
        const c = snap.data();
        const members = c.members || {};
        if (members[uid]) return { char: members[uid].c };
        if (Object.keys(members).length >= MAX_CREW || c.settled) throw new Error('crew-full');
        const chars = c.chars || [];
        const char = pickCharacter(prefs, chars);
        if (!char) throw new Error('crew-full');
        tx.update(ref, { [`members.${uid}`]: { c: char, j: serverTimestamp() }, chars: [...chars, char] });
        tx.update(doc(db, 'users', uid), { crewId, crewWeek: c.weekStart, ...userPatch });
        return { char };
      });
    },

    /* ---------- 管理者 ---------- */
    async listUsers() {
      const qs = await getDocs(collection(db, 'users'));
      return qs.docs.map(normUser);
    },
    async listAllCrews() {
      const qs = await getDocs(collection(db, 'crews'));
      return qs.docs.map(normCrew);
    },
    async listCrewReactions(crewId) {
      const qs = await getDocs(collection(db, 'crews', crewId, 'reactions'));
      return qs.docs.map(normReaction);
    },
    async listAppOpens() {
      const qs = await getDocs(collection(db, 'appOpens'));
      return qs.docs.map((s) => ({ ...s.data(), id: s.id, at: toMs(s.data().at) }));
    },
    async getWeekBefore(weekStart) {
      const s = await getDoc(doc(db, 'adminOnly', `before-${weekStart}`));
      return s.exists() ? (s.data().before || {}) : null;
    },
    /**
     * 一次寫入：刪掉本週舊小隊（重新配對時，連同每日紀錄和回應）→ 結算上週 → 建立新小隊 → 更新使用者 → 記錄本週已配對
     */
    async commitMatching({ weekStart, deleteCrewIds = [], settle = [], crews = [], userUpdates = {}, before = {} }) {
      const ops = [];
      for (const id of deleteCrewIds) {
        for (const sub of ['days', 'reactions']) {
          const qs = await getDocs(collection(db, 'crews', id, sub));
          qs.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
        }
        ops.push((b) => b.delete(doc(db, 'crews', id)));
      }
      for (const s of settle) {
        ops.push((b) => b.update(doc(db, 'crews', s.crewId), { steps: s.steps, settled: true }));
        for (const uid of s.members) {
          ops.push((b) => b.set(doc(db, 'users', uid, 'journeys', s.weekStart), {
            forest: s.forest, crewId: s.crewId, steps: s.steps, settledAt: serverTimestamp(),
          }));
        }
      }
      for (const c of crews) {
        const members = {};
        for (const [uid, ch] of Object.entries(c.chars)) members[uid] = { c: ch, j: serverTimestamp() };
        ops.push((b) => b.set(doc(db, 'crews', c.id), {
          weekStart, forest: c.forest, members, chars: Object.values(c.chars), steps: 0, settled: false, createdAt: serverTimestamp(),
        }));
      }
      for (const [uid, patch] of Object.entries(userUpdates)) ops.push((b) => b.update(doc(db, 'users', uid), patch));
      ops.push((b) => b.set(doc(db, 'adminOnly', `before-${weekStart}`), { weekStart, before }));
      ops.push((b) => b.set(doc(db, 'weeks', weekStart), { weekStart, matchedAt: serverTimestamp(), crews: crews.length }));
      await commitInChunks(ops);
    },
    /** 管理者把某人加進小隊（不受「只能加自己」限制） */
    async adminAddMember(crewId, uid, char, crewWeek, forest) {
      const batch = writeBatch(db);
      batch.update(doc(db, 'crews', crewId), { [`members.${uid}`]: { c: char, j: serverTimestamp() }, chars: arrayUnion(char) });
      batch.update(doc(db, 'users', uid), { crewId, crewWeek, currentForest: forest });
      await batch.commit();
    },
    async createTestUsers(list) {
      await commitInChunks(list.map((u) => (b) => b.set(doc(db, 'users', u.uid), {
        nickname: u.nickname, prefs: u.prefs, currentForest: 1, crewId: null, crewWeek: null,
        createdAt: Timestamp.fromMillis(u.createdAt), lastSeenAt: serverTimestamp(), isTest: true,
      })));
    },
    async seedDays(crewId, entries) {
      await commitInChunks(entries.map((e) => (b) => b.set(doc(db, 'crews', crewId, 'days', `${e.date}_${e.uid}`), {
        uid: e.uid, date: e.date, crewId, status: e.status, visibility: e.visibility, publicTitle: e.publicTitle ?? null,
        minutes: e.minutes ?? null, energy: e.energy ?? null, templateId: null, publicNote: e.publicNote ?? null,
        setOutAt: e.setOut ? serverTimestamp() : null, setOutSeconds: e.setOutSeconds ?? null, middayAt: null, updatedAt: serverTimestamp(),
      })));
    },
    /** 讓測試使用者「剛剛打開過 App」：更新最後上線時間，並記一筆今天的開啟紀錄 */
    async touchTestUsers(uids, date) {
      const ops = [];
      for (const uid of uids) {
        ops.push((b) => b.update(doc(db, 'users', uid), { lastSeenAt: serverTimestamp() }));
        if (date) ops.push((b) => b.set(doc(db, 'appOpens', `${date}_${uid}`), { uid, date, at: serverTimestamp() }));
      }
      await commitInChunks(ops);
    },
    /** 清空測試資料（正式測試前用）。私人任務只有本人刪得掉，所以不在這裡。 */
    async resetAll(progress = () => {}) {
      const ops = [];
      const crews = await getDocs(collection(db, 'crews'));
      for (const c of crews.docs) {
        for (const sub of ['days', 'reactions']) {
          const qs = await getDocs(collection(db, 'crews', c.id, sub));
          qs.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
        }
        ops.push((b) => b.delete(c.ref));
      }
      progress('小隊');
      const users = await getDocs(collection(db, 'users'));
      for (const u of users.docs) {
        const js = await getDocs(collection(db, 'users', u.id, 'journeys'));
        js.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
        ops.push((b) => b.delete(u.ref));
      }
      progress('使用者');
      for (const name of ['appOpens', 'weeks', 'adminOnly']) {
        const qs = await getDocs(collection(db, name));
        qs.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
      }
      await commitInChunks(ops);
      progress('完成');
      return ops.length;
    },
  };
}
