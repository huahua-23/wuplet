// 伍伴 Wuplet — Firebase 專案設定
// 這段是公開資訊（不是密碼），本來就會出現在網頁裡；資料由 Firestore 安全規則保護。
// 來源：Firebase 控制台 → 專案設定 → 一般設定 → 你的應用程式 → wuplet-web
export const firebaseConfig = {
  apiKey: 'AIzaSyA8pVSsTntDAFYW0HbE6RHtQ7S9QnMVuEs',
  authDomain: 'wuplet.firebaseapp.com',
  projectId: 'wuplet',
  storageBucket: 'wuplet.firebasestorage.app',
  messagingSenderId: '85403605143',
  appId: '1:85403605143:web:e979f40d8d98be12a2f1d2',
};

// Firebase JavaScript SDK 版本，從 Google 的 gstatic 載入。
// 第一個載入失敗時，會依序改用後面的版本。
export const FIREBASE_SDK_VERSIONS = ['13.1.0', '12.0.0', '11.0.0'];
