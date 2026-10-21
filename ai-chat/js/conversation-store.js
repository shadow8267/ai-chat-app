/* ============================================================
   conversation-store.js — Permanent IndexedDB content storage
   ============================================================ */

const DB_NAME = 'ai_chat_content_db';
const DB_VERSION = 1;
const CONVERSATION_STORE = 'conversations';
const META_STORE = 'metadata';
const SNAPSHOT_STORE = 'snapshots';

let dbPromise = null;
let writeQueue = Promise.resolve();

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function openConversationDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATION_STORE)) {
        db.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        const store = db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('无法打开会话数据库'));
    };
    request.onblocked = () => reject(new Error('会话数据库升级被其他页面阻止'));
  });
  return dbPromise;
}

export async function getAllStoredConversations() {
  const db = await openConversationDatabase();
  const transaction = db.transaction(CONVERSATION_STORE, 'readonly');
  return requestResult(transaction.objectStore(CONVERSATION_STORE).getAll());
}

export async function getStoredConversation(id) {
  const db = await openConversationDatabase();
  const transaction = db.transaction(CONVERSATION_STORE, 'readonly');
  return requestResult(transaction.objectStore(CONVERSATION_STORE).get(id));
}

export function enqueueConversationChanges(conversations, changedIds, deletedIds = []) {
  const snapshot = (Array.isArray(conversations) ? conversations : [])
    .filter(item => changedIds.has(item.id))
    .map(item => structuredClone(item));
  const removed = [...deletedIds];
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const db = await openConversationDatabase();
    const transaction = db.transaction(CONVERSATION_STORE, 'readwrite');
    const store = transaction.objectStore(CONVERSATION_STORE);
    snapshot.forEach(item => store.put(item));
    removed.forEach(id => store.delete(id));
    await transactionDone(transaction);
  });
  return writeQueue;
}

export function replaceAllStoredConversations(conversations) {
  const snapshot = structuredClone(Array.isArray(conversations) ? conversations : []);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const db = await openConversationDatabase();
    const transaction = db.transaction(CONVERSATION_STORE, 'readwrite');
    const store = transaction.objectStore(CONVERSATION_STORE);
    store.clear();
    snapshot.forEach(item => store.put(item));
    await transactionDone(transaction);
  });
  return writeQueue;
}

export async function waitForConversationWrites() {
  return writeQueue;
}

export async function getContentMetadata(key, defaultValue = null) {
  const db = await openConversationDatabase();
  const transaction = db.transaction(META_STORE, 'readonly');
  const record = await requestResult(transaction.objectStore(META_STORE).get(key));
  return record ? record.value : defaultValue;
}

export async function setContentMetadata(key, value) {
  const db = await openConversationDatabase();
  const transaction = db.transaction(META_STORE, 'readwrite');
  transaction.objectStore(META_STORE).put({ key, value });
  await transactionDone(transaction);
}

export async function getStoredSnapshots() {
  const db = await openConversationDatabase();
  const transaction = db.transaction(SNAPSHOT_STORE, 'readonly');
  const snapshots = await requestResult(transaction.objectStore(SNAPSHOT_STORE).getAll());
  return snapshots.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function putStoredSnapshot(snapshot) {
  const db = await openConversationDatabase();
  const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite');
  transaction.objectStore(SNAPSHOT_STORE).put(structuredClone(snapshot));
  await transactionDone(transaction);
}

export async function deleteStoredSnapshot(id) {
  const db = await openConversationDatabase();
  const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite');
  transaction.objectStore(SNAPSHOT_STORE).delete(id);
  await transactionDone(transaction);
}

export async function trimStoredSnapshots(maxEntries) {
  const snapshots = await getStoredSnapshots();
  const stale = snapshots.slice(Math.max(0, Number(maxEntries) || 0));
  if (!stale.length) return;
  const db = await openConversationDatabase();
  const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite');
  const store = transaction.objectStore(SNAPSHOT_STORE);
  stale.forEach(item => store.delete(item.id));
  await transactionDone(transaction);
}
