// Tiny IndexedDB key-value store. Everything stays on this device.

const DB_NAME = 'handschrift';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

// Change listeners (used by cloud sync). `quiet` writes don't notify, e.g.
// when cloud data is written into the local cache.
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const notify = (key, quiet) => (result) => {
  if (!quiet) listeners.forEach((fn) => fn(key));
  return result;
};

export const get = (key) => run('readonly', (s) => s.get(key));
export const set = (key, value, { quiet = false } = {}) =>
  run('readwrite', (s) => s.put(value, key)).then(notify(key, quiet));
export const del = (key, { quiet = false } = {}) =>
  run('readwrite', (s) => s.delete(key)).then(notify(key, quiet));

// Ask the browser not to evict our data (Safari deletes site data after
// 7 days without a visit unless the app is on the home screen).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) {
    /* ignore */
  }
  return false;
}
