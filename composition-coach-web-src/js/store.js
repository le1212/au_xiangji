/* 会话存档：IndexedDB 存「一次拍摄会话」= 诊断帧序列 + 成片 */

const DB_NAME = 'composition-coach';
const STORE = 'sessions';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function saveSession(session) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(session);
    t.oncomplete = () => resolve(session.id);
    t.onerror = () => reject(t.error);
  });
}

/** 档案列表投影：不搬 dataUrl 大图（原生分辨率成片后单条可达数 MB），
    只取列表卡片与"恢复未存档会话"所需字段；完整记录用 getSession(id) */
export async function listSessions() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const s = cursor.value;
      const frames = (s.frames || []).map((f, i) => {
        const light = { ts: f.ts, diag: f.diag };
        if (i === 0 && f.thumb) light.thumb = f.thumb; // 列表卡片封面用
        return light;
      });
      out.push({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        frames,
        finalShot: s.finalShot ? { ts: s.finalShot.ts, thumb: s.finalShot.thumb, aspect: s.finalShot.aspect } : null,
      });
      cursor.continue();
    };
    t.oncomplete = () => resolve(out.sort((a, b) => b.startedAt - a.startedAt));
    t.onerror = () => reject(t.error);
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
