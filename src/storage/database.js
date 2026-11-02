const DB_NAME = 'tessera-workspace';
const DB_VERSION = 1;
const WORKSPACE_KEY = 'current';

let databasePromise;

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      const db = request.result;
      if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace');
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
  return databasePromise;
}

async function storeRequest(storeName, mode, action) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

export function readWorkspace() {
  return storeRequest('workspace', 'readonly', function (store) { return store.get(WORKSPACE_KEY); });
}

export function saveWorkspace(workspace) {
  return storeRequest('workspace', 'readwrite', function (store) { return store.put(workspace, WORKSPACE_KEY); });
}

export function listDatasets() {
  return storeRequest('datasets', 'readonly', function (store) { return store.getAll(); });
}

export function saveDataset(dataset) {
  return storeRequest('datasets', 'readwrite', function (store) { return store.put(dataset); });
}

export function removeDataset(id) {
  return storeRequest('datasets', 'readwrite', function (store) { return store.delete(id); });
}

export async function clearLocalData() {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction(['datasets', 'workspace'], 'readwrite');
    transaction.objectStore('datasets').clear();
    transaction.objectStore('workspace').clear();
    transaction.oncomplete = resolve;
    transaction.onerror = function () { reject(transaction.error); };
  });
}
