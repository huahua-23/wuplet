// 伍伴 Wuplet — 選擇資料層：一般用 Firebase；網址有 ?demo=1 時用示範資料
export async function createBackend({ demo = false, scene = '' } = {}) {
  if (demo) {
    const m = await import('./backend-demo.js');
    return m.createDemoBackend({ scene });
  }
  const m = await import('./backend-firebase.js');
  return m.createFirebaseBackend();
}
