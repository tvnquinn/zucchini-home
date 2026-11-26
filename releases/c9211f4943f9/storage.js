// One transaction commits a complete state plus the previous valid generation.
// Revision checking prevents two open tabs from overwriting each other's work.
export function openStorage(name = 'zucchini-home') {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Zucchini tabs to finish opening saves.'));
  });
}
export function readStorage(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('saves', 'readonly');
    const req = tx.objectStore('saves').get('state');
    tx.oncomplete = () => resolve(req.result ?? { revision: 0 });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Save read was interrupted.'));
  });
}
export function commitStorage(db, revision, bytes, previous, focusDeadline = null, previousFocusDeadline = null, facings = {}, previousFacings = {}, visitProgress = {}, previousVisitProgress = {}) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('saves', 'readwrite', { durability: 'strict' }); }
    catch (error) {
      if (error.name !== 'TypeError' && error.name !== 'NotSupportedError') throw error;
      tx = db.transaction('saves', 'readwrite');
    }
    const store = tx.objectStore('saves');
    let conflict = false;
    const req = store.get('state');
    req.onsuccess = () => {
      if ((req.result?.revision ?? 0) !== revision) {
        conflict = true;
        tx.abort();
        return;
      }
      store.put({ revision: revision + 1, current: bytes, previous, focusDeadline, previousFocusDeadline, facings, previousFacings, visitProgress, previousVisitProgress }, 'state');
    };
    tx.oncomplete = () => resolve(revision + 1);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => {
      const error = new Error(conflict
        ? 'Another tab saved progress. Reload this tab before continuing.'
        : 'Save failed. Your previous progress is safe. Free some browser storage, then retry.');
      if (conflict) error.name = 'SaveConflict';
      reject(error);
    };
  });
}

// Historical database IDs are retained only to read existing installations.
// Opening an absent legacy database is aborted so fresh installs do not create it.
export function readPreviousStorage(development = false) {
  const name = development ? 'zuzu-phase-b-dev' : 'zuzu-phase-b';
  return new Promise((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
    request.onsuccess = async () => {
      const db = request.result;
      try { resolve(await readStorage(db)); }
      catch (error) { reject(error); }
      finally { db.close?.(); }
    };
    request.onerror = (event) => {
      if (absent) { event?.preventDefault(); resolve({ revision: 0 }); }
      else reject(request.error);
    };
    request.onblocked = () => reject(new Error('Close older game tabs, then retry loading your progress.'));
  });
}


// Sync settings live beside the save under their own key, so the save's commit path never touches them.
// Each is a read then a write in one transaction. A null value means sync is off.
export function readSync(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('saves', 'readonly');
    const req = tx.objectStore('saves').get('sync');
    tx.oncomplete = () => resolve(req.result ?? null);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Sync settings could not be read.'));
  });
}
export function writeSync(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('saves', 'readwrite');
    const store = tx.objectStore('saves');
    store.get('sync').onsuccess = () => store.put(value, 'sync');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Sync settings could not be saved.'));
  });
}
