const DB_NAME = 'tessera-workspace';
const DB_VERSION = 2;
const MAX_REVISIONS_PER_PROJECT = 20;
const DEFAULT_PROJECTS = [
  { id: 'default', name: 'Q3 revenue review', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'retention', name: 'Customer retention', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'research', name: 'Product research', createdAt: '2026-01-01T00:00:00.000Z' }
];

let databasePromise;

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function (event) {
      const db = request.result;
      const transaction = request.transaction;
      if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('revisions')) {
        const revisions = db.createObjectStore('revisions', { keyPath: 'id' });
        revisions.createIndex('projectId', 'projectId', { unique: false });
      }
      const datasets = transaction.objectStore('datasets');
      if (!datasets.indexNames.contains('projectId')) datasets.createIndex('projectId', 'projectId', { unique: false });
      if (event.oldVersion < 2) migrateLegacyWorkspace(transaction);
    };
    request.onsuccess = function () {
      const db = request.result;
      db.onversionchange = function () { db.close(); databasePromise = null; };
      resolve(db);
    };
    request.onerror = function () { databasePromise = null; reject(request.error); };
    request.onblocked = function () { reject(new Error('Close other Tessera tabs to finish the workspace update.')); };
  });
  return databasePromise;
}

function migrateLegacyWorkspace(transaction) {
  const oldWorkspace = transaction.objectStore('workspace');
  const savedRequest = oldWorkspace.get('current');
  savedRequest.onsuccess = function () {
    const legacy = savedRequest.result && typeof savedRequest.result === 'object' ? savedRequest.result : {};
    const projects = Array.isArray(legacy.projects) && legacy.projects.length ? legacy.projects : DEFAULT_PROJECTS;
    const activeProjectId = projects.some(function (project) { return project.id === legacy.activeProjectId; }) ? legacy.activeProjectId : projects[0].id;
    const projectStore = transaction.objectStore('projects');
    projects.forEach(function (project) {
      if (project && typeof project.id === 'string') {
        projectStore.put({ ...project, createdAt: project.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    });
    const workspace = { ...legacy, projectId: activeProjectId, activeProjectId, revision: Number(legacy.revision) || 0 };
    delete workspace.projects;
    transaction.objectStore('workspaces').put(workspace);
    transaction.objectStore('meta').put({ key: 'activeProjectId', value: activeProjectId });
    if (!savedRequest.result) transaction.objectStore('workspaces').put({ projectId: 'default', revision: 0 });

    const datasetCursor = transaction.objectStore('datasets').openCursor();
    datasetCursor.onsuccess = function () {
      const cursor = datasetCursor.result;
      if (!cursor) return;
      const dataset = cursor.value;
      if (!dataset.projectId) {
        dataset.projectId = activeProjectId;
        cursor.update(dataset);
      }
      cursor.continue();
    };
  };
}

function requestValue(request, transaction, resolve, reject) {
  let value;
  request.onsuccess = function () { value = request.result; };
  request.onerror = function () { reject(request.error); };
  transaction.oncomplete = function () { resolve(value); };
  transaction.onerror = function () { reject(transaction.error || new Error('Local storage transaction failed.')); };
  transaction.onabort = function () { reject(transaction.error || new Error('Local storage transaction was interrupted.')); };
}

async function readRequest(storeName, action) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction(storeName, 'readonly');
    requestValue(action(transaction.objectStore(storeName)), transaction, resolve, reject);
  });
}

async function writeTransaction(storeNames, action) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction(storeNames, 'readwrite');
    let result;
    transaction.oncomplete = function () { resolve(result); };
    transaction.onerror = function () { reject(transaction.error || new Error('Local storage transaction failed.')); };
    transaction.onabort = function () { reject(transaction.error || new Error('Local storage transaction was interrupted.')); };
    try { result = action(transaction); } catch (error) { transaction.abort(); reject(error); }
  });
}

function putProjectIfMissing(transaction, projectId) {
  transaction.objectStore('projects').put({
    id: projectId,
    name: projectId === 'default' ? 'Q3 revenue review' : 'Untitled project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function writeWorkspaceInTransaction(transaction, workspace) {
  const projectId = workspace.projectId || workspace.activeProjectId || 'default';
  const current = Number.isInteger(workspace.revision) ? workspace.revision : 0;
  const record = { ...workspace, projectId, revision: current + 1, updatedAt: new Date().toISOString() };
  const projects = transaction.objectStore('projects');
  projects.get(projectId).onsuccess = function (event) {
    if (!event.target.result) putProjectIfMissing(transaction, projectId);
    else projects.put({ ...event.target.result, updatedAt: record.updatedAt });
  };
  transaction.objectStore('workspaces').put(record);
  transaction.objectStore('meta').put({ key: 'activeProjectId', value: projectId });
  const revisions = transaction.objectStore('revisions');
  revisions.put({ ...record, id: projectId + ':' + String(record.revision).padStart(10, '0') });
  revisions.index('projectId').getAll(projectId).onsuccess = function (event) {
    const all = event.target.result.sort(function (a, b) { return b.revision - a.revision; });
    all.slice(MAX_REVISIONS_PER_PROJECT).forEach(function (item) { revisions.delete(item.id); });
  };
  return record;
}

export async function readWorkspace(projectId) {
  if (!projectId) {
    const active = await readRequest('meta', function (store) { return store.get('activeProjectId'); });
    projectId = active?.value || 'default';
  }
  return readRequest('workspaces', function (store) { return store.get(projectId); });
}

export async function saveWorkspace(workspace) {
  return writeTransaction(['projects', 'workspaces', 'revisions', 'meta'], function (transaction) {
    return writeWorkspaceInTransaction(transaction, workspace);
  });
}

export async function saveDatasetAndWorkspace(dataset, workspace) {
  return writeTransaction(['datasets', 'projects', 'workspaces', 'revisions', 'meta'], function (transaction) {
    transaction.objectStore('datasets').put({ ...dataset, projectId: dataset.projectId || workspace.projectId || 'default' });
    return writeWorkspaceInTransaction(transaction, workspace);
  });
}

export async function listDatasets(projectId) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction('datasets', 'readonly');
    const store = transaction.objectStore('datasets');
    const request = projectId ? store.index('projectId').getAll(projectId) : store.getAll();
    requestValue(request, transaction, resolve, reject);
  });
}

export async function listProjects() {
  return readRequest('projects', function (store) { return store.getAll(); });
}

export async function ensureProjects(projects) {
  return writeTransaction('projects', function (transaction) {
    const store = transaction.objectStore('projects');
    projects.forEach(function (project) {
      const request = store.get(project.id);
      request.onsuccess = function () {
        if (!request.result) store.put(project);
      };
    });
  });
}

export async function saveProject(project) {
  const now = new Date().toISOString();
  return writeTransaction('projects', function (transaction) {
    transaction.objectStore('projects').put({ ...project, createdAt: project.createdAt || now, updatedAt: now });
  });
}

export async function saveDataset(dataset) {
  return writeTransaction('datasets', function (transaction) {
    transaction.objectStore('datasets').put({ ...dataset, projectId: dataset.projectId || 'default' });
  });
}

export async function removeDataset(id) {
  return writeTransaction('datasets', function (transaction) { transaction.objectStore('datasets').delete(id); });
}

export async function listWorkspaceRevisions(projectId) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const transaction = db.transaction('revisions', 'readonly');
    const request = transaction.objectStore('revisions').index('projectId').getAll(projectId);
    requestValue(request, transaction, function (records) { resolve(records.sort(function (a, b) { return b.revision - a.revision; })); }, reject);
  });
}

export async function clearLocalData() {
  const db = await openDatabase();
  return writeTransaction(Array.from(db.objectStoreNames), function (transaction) {
    Array.from(db.objectStoreNames).forEach(function (name) { transaction.objectStore(name).clear(); });
  });
}
