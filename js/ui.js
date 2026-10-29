// 伍伴 Wuplet — 畫面小工具
import { charById } from './constants.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const asset = {
  char: (c, state) => `assets/characters/${c}_${state}.webp`,
  icon: (n) => `assets/icons/${n}.webp`,
  camp: (id) => `assets/camp/camp_${id}.webp`,
  forest: (id) => `assets/forests/forest_${id}.webp`,
};

/** 圓形角色頭像。state = idle / setout / onit / done / little / rest / away / private */
export function avatar(charId, state = 'idle', { size = 'md', badge = null, label = '' } = {}) {
  const c = charById(charId);
  return `<span class="av av-${size}" style="--wash:${c.wash}" ${label ? `aria-label="${esc(label)}" role="img"` : 'aria-hidden="true"'}>`
    + `<span class="av-in"><img src="${asset.char(c.id, state)}" alt=""></span>`
    + (badge ? `<img class="av-badge" src="${asset.icon(badge)}" alt="">` : '')
    + '</span>';
}

export function icon(name, cls = 'ic') {
  return `<img class="${cls}" src="${asset.icon(name)}" alt="" aria-hidden="true">`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** 把 Firebase 的錯誤碼翻成看得懂的話 */
export function friendlyError(err) {
  const code = (err && (err.code || err.message)) || '';
  if (code.includes('unauthorized-domain')) return '這個網址還沒加進 Firebase 的授權網域。';
  if (code.includes('popup-blocked')) return '瀏覽器擋住了登入視窗，請允許這個網站開彈出式視窗後再試一次。';
  if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) return '登入視窗被關掉了，再按一次就好。';
  if (code.includes('operation-not-allowed')) return 'Firebase 還沒開啟 Google 登入。';
  if (code.includes('network-request-failed') || code.includes('unavailable')) return '網路不太穩，請稍後再試。';
  if (code.includes('permission-denied') || code.includes('insufficient permissions')) return '沒有權限讀寫這筆資料（安全規則擋住了）。';
  if (code.includes('crew-full')) return '這個小隊已經滿了。';
  return '出了點問題，請稍後再試。';
}

/** 是不是在 LINE、Instagram、Facebook 等 App 的內建瀏覽器裡（Google 不讓這裡登入） */
export function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/\bLine\//i.test(ua)) return 'line';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  return null;
}
