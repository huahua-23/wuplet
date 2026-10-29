// 伍伴 Wuplet — 固定設定（角色、狀態、選項）
// 改這裡會影響整個 App，請小心。

export const APP_VERSION = '0.1.0';

export const CHARACTERS = [
  { id: 'sprouty', en: 'Sprouty', zh: '芽芽', main: '#6E9A5B', body: '#D5E5C4', wash: '#EEF4E6', trait: '平靜溫和' },
  { id: 'peachi', en: 'Peachi', zh: '桃桃', main: '#EE8A5C', body: '#FAD6C1', wash: '#FDEDE3', trait: '熱情明朗' },
  { id: 'sunny', en: 'Sunny', zh: '暖暖', main: '#E9A92A', body: '#F9E6AE', wash: '#FDF4D8', trait: '溫暖歡樂' },
  { id: 'leafy', en: 'Leafy', zh: '葉葉', main: '#2F7F78', body: '#C4E0DA', wash: '#E4F1EE', trait: '安靜深思' },
  { id: 'coco', en: 'Coco', zh: '可可', main: '#7A4E33', body: '#E6CFB8', wash: '#F3E8DC', trait: '好奇創造' },
];
export const CHAR_IDS = CHARACTERS.map((c) => c.id);
export const charById = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];

// 每天的狀態。沒有「失敗」。
export const STATUSES = ['setout', 'onit', 'done', 'little', 'not-today', 'rest'];
export const STEP_STATUSES = ['done', 'little'];       // 讓營火 +1 步
export const REPORTED_STATUSES = ['done', 'little', 'not-today'];

export const MINUTES = [5, 10, 15, 20];
export const ENERGY = [
  { id: 'low', label: '沒什麼力氣' },
  { id: 'a-little', label: '一點點' },
  { id: 'normal', label: '還好' },
  { id: 'ready', label: '滿滿的' },
];
export const CATEGORIES = ['閱讀', '語言', '寫作與論文', '運動', '整理', '其他'];

// 營火階段（門檻待驗證，測試後可以調）
export const CAMP_STAGES = [
  { min: 0, id: 'spark', name: '星火' },
  { min: 1, id: 'firstlight', name: '第一盞燈' },
  { min: 5, id: 'leafring', name: '葉子圍成圈' },
  { min: 12, id: 'bright', name: '營地明亮' },
];

export const REACTIONS = [
  { id: 'sprout', label: '芽', icon: 'icon_sprout' },
  { id: 'clap', label: '拍手', icon: 'icon_clap' },
  { id: 'sparkle', label: '星光', icon: 'icon_sparkle' },
];

export const MAX_CREW = 5;
export const MIN_GROUP = 3;          // 一座森林不到 3 人就併到下一座
export const AWAY_HOURS = 48;        // 超過 48 小時沒打開 App = 出遠門
export const TITLE_MAX = 20;
export const NOTE_MAX = 40;
export const NICK_MAX = 12;
export const SMALL_STEP_PREFIX = '先做第一步：';
