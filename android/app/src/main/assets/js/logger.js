/* ============================================================
   logger.js — Device-local diagnostic logs (never LAN-synced)
   ============================================================ */

const LOG_KEY = 'ai_chat_device_logs';
const LEGACY_DETAIL_KEY = 'ai_chat_device_log_details';
const SETTINGS_KEY = 'ai_chat_log_settings';
const DETAIL_DB_NAME = 'ai_chat_logs_db';
const DETAIL_STORE_NAME = 'full_details';
const MAX_LOGS = 600;
const MAX_DETAIL_ENTRIES = 80;

let detailDbPromise = null;
const pendingDetails = new Map();

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function readLogs() {
  try {
    const logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(logs) ? logs : [];
  } catch {
    return [];
  }
}

function readLegacyDetails() {
  try {
    const details = JSON.parse(localStorage.getItem(LEGACY_DETAIL_KEY) || '{}');
    return details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  } catch {
    return {};
  }
}

function writeLogs(logs) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(-MAX_LOGS)));
    return true;
  } catch {
    return false;
  }
}

function openDetailDb() {
  if (detailDbPromise) return detailDbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  detailDbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DETAIL_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DETAIL_STORE_NAME)) {
          request.result.createObjectStore(DETAIL_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return detailDbPromise;
}

async function saveIndexedDetail(id, payload) {
  const db = await openDetailDb();
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(DETAIL_STORE_NAME, 'readwrite');
      tx.objectStore(DETAIL_STORE_NAME).put({ id, payload: cloneJson(payload) || {} });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function loadIndexedDetails() {
  const db = await openDetailDb();
  if (!db) return {};
  return new Promise(resolve => {
    try {
      const tx = db.transaction(DETAIL_STORE_NAME, 'readonly');
      const request = tx.objectStore(DETAIL_STORE_NAME).getAll();
      request.onsuccess = () => resolve(Object.fromEntries((request.result || []).map(item => [item.id, item.payload])));
      request.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
}

async function removeIndexedDetails(ids) {
  if (!ids.size) return;
  const db = await openDetailDb();
  if (!db) return;
  try {
    const tx = db.transaction(DETAIL_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DETAIL_STORE_NAME);
    ids.forEach(id => store.delete(id));
  } catch {
    // Summary logs remain usable if IndexedDB cleanup is unavailable.
  }
}

function queueFullDetail(id, payload) {
  const cloned = cloneJson(payload);
  if (!cloned || typeof cloned !== 'object') return false;
  pendingDetails.set(id, cloned);
  // Full content is deliberately kept out of localStorage. This prevents one
  // long novel response from making the entire log array fail to save.
  void saveIndexedDetail(id, cloned).then(ok => {
    if (!ok) console.warn('full log detail could not be stored for', id);
  });
  return true;
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const safe = {};
  if (payload.request && typeof payload.request === 'object') {
    const { messages, ...requestMeta } = payload.request;
    safe.request = {
      ...requestMeta,
      messageCount: Array.isArray(messages) ? messages.length : requestMeta.messageCount,
    };
  }
  if (payload.response && typeof payload.response === 'object') {
    const { content, reasoning, body, ...responseMeta } = payload.response;
    safe.response = {
      ...responseMeta,
      outputLength: typeof content === 'string' ? content.length : responseMeta.outputLength,
      reasoningLength: typeof reasoning === 'string' ? reasoning.length : responseMeta.reasoningLength,
      bodyLength: typeof body === 'string' ? body.length : responseMeta.bodyLength,
      error: responseMeta.error || (responseMeta.error ? String(responseMeta.error).slice(0, 500) : undefined),
    };
  }
  return safe;
}

function getCurrentDetail(id, indexedDetails = {}, legacyDetails = null) {
  const legacy = legacyDetails || readLegacyDetails();
  return pendingDetails.get(id) || indexedDetails[id] || legacy[id] || null;
}

function getPayloadForLog(entry, indexedDetails = {}, legacyDetails = null) {
  const full = entry?.contentMode === 'full' ? getCurrentDetail(entry.id, indexedDetails, legacyDetails) : null;
  return full && typeof full === 'object' ? full : entry?.payload || {};
}

function saveSummaryEntry(entry) {
  const logs = readLogs();
  const index = logs.findIndex(item => item?.id === entry.id);
  if (index >= 0) logs[index] = entry;
  else logs.push(entry);
  if (writeLogs(logs)) return true;
  // If old logs are already too large, preserve the newest summaries by
  // trimming only log history; never clear conversations or other data.
  return writeLogs(logs.slice(-240));
}

export function getLogSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { includeContent: saved.includeContent === true };
  } catch {
    return { includeContent: false };
  }
}

export function saveLogSettings(next = {}) {
  const previous = getLogSettings();
  const settings = {
    ...previous,
    ...next,
    includeContent: next.includeContent === undefined ? previous.includeContent : next.includeContent === true,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('log settings write failed', error);
  }
  return settings;
}

/**
 * Create a summary log. With full recording enabled, the summary is written
 * synchronously and the full payload is stored separately in IndexedDB.
 */
export function logEvent(kind, event, details = {}, message = '', payload = {}) {
  const settings = getLogSettings();
  const contentMode = settings.includeContent ? 'full' : 'summary';
  const id = `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    time: new Date().toISOString(),
    kind: String(kind || 'operation').slice(0, 30),
    event: String(event || 'unknown').slice(0, 100),
    message: String(message || '').slice(0, 1200),
    details: details && typeof details === 'object' ? cloneJson(details) || {} : {},
    payload: { ...summarizePayload(payload), detailAvailable: contentMode === 'full' },
    contentMode,
  };
  saveSummaryEntry(entry);
  if (contentMode === 'full') queueFullDetail(id, payload);
  return entry;
}

/** Update one request lifecycle entry while preserving its full request payload. */
export async function updateLog(id, patch = {}) {
  const logs = readLogs();
  const current = logs.find(item => item?.id === id);
  if (!current) return null;
  const indexedDetails = await loadIndexedDetails();
  const legacyDetails = readLegacyDetails();
  const basePayload = getPayloadForLog(current, indexedDetails, legacyDetails);
  const nextPayload = {
    ...(basePayload && typeof basePayload === 'object' ? basePayload : {}),
    ...(patch.payload && typeof patch.payload === 'object' ? patch.payload : {}),
  };
  const next = {
    ...current,
    ...(patch.event ? { event: String(patch.event).slice(0, 100) } : {}),
    ...(patch.message !== undefined ? { message: String(patch.message || '').slice(0, 1200) } : {}),
    ...(patch.details && typeof patch.details === 'object'
      ? { details: { ...(current.details || {}), ...(cloneJson(patch.details) || {}) } }
      : {}),
    payload: { ...summarizePayload(nextPayload), detailAvailable: current.contentMode === 'full' && Boolean(getCurrentDetail(id, indexedDetails) || nextPayload) },
  };
  saveSummaryEntry(next);
  if (current.contentMode === 'full') queueFullDetail(id, nextPayload);
  return next;
}

export async function getLogs() {
  const indexedDetails = await loadIndexedDetails();
  const legacyDetails = readLegacyDetails();
  return readLogs().map(entry => {
    const full = entry?.contentMode === 'full'
      ? getCurrentDetail(entry.id, indexedDetails, legacyDetails)
      : null;
    if (!full || typeof full !== 'object') return entry;
    return {
      ...entry,
      payload: {
        ...(entry.payload && typeof entry.payload === 'object' ? entry.payload : {}),
        ...full,
        detailAvailable: true,
      },
    };
  });
}

export function summarizeCacheUsage(logs = readLogs()) {
  const completed = (Array.isArray(logs) ? logs : []).filter(entry => (
    entry?.event === 'chat_completion_finished'
    && entry?.details
    && typeof entry.details === 'object'
  ));
  const usages = completed.map(entry => entry.details.usage).filter(usage => usage && typeof usage === 'object');
  const measurable = usages.filter(usage => usage.cacheStatus === 'hit' || usage.cacheStatus === 'miss');
  const hitRequests = measurable.filter(usage => usage.cacheStatus === 'hit').length;
  const sum = (items, key) => items.reduce((total, item) => {
    const value = Number(item?.[key]);
    return total + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);
  const totalInputTokens = sum(usages, 'inputTokens');
  const measurableInputTokens = sum(measurable, 'inputTokens');
  const cachedReadTokens = sum(measurable, 'cachedReadTokens');
  const cacheWriteTokens = sum(usages, 'cacheWriteTokens');
  return {
    completedRequests: completed.length,
    usageReportedRequests: usages.length,
    measurableRequests: measurable.length,
    hitRequests,
    missRequests: measurable.length - hitRequests,
    unavailableRequests: completed.length - measurable.length,
    requestHitRate: measurable.length ? hitRequests / measurable.length : null,
    totalInputTokens,
    measurableInputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    tokenReuseRate: measurableInputTokens ? cachedReadTokens / measurableInputTokens : null,
  };
}

export async function clearLogs({ kind = 'all', beforeDays = null } = {}) {
  const cutoff = Number.isFinite(Number(beforeDays)) && Number(beforeDays) > 0
    ? Date.now() - Number(beforeDays) * 24 * 60 * 60 * 1000
    : null;
  const logs = readLogs();
  const removedIds = new Set();
  const kept = logs.filter(entry => {
    const matchesKind = kind === 'all' || entry.kind === kind;
    const matchesDate = cutoff !== null && new Date(entry.time).getTime() < cutoff;
    const remove = matchesKind && (cutoff !== null ? matchesDate : true);
    if (remove) removedIds.add(entry.id);
    return !remove;
  });
  removedIds.forEach(id => pendingDetails.delete(id));
  await removeIndexedDetails(removedIds);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(kept.slice(-MAX_LOGS)));
  } catch {
    localStorage.setItem(LOG_KEY, JSON.stringify(kept.slice(-240)));
  }
  return kept.length;
}

/** Export summaries plus full IndexedDB details and legacy details for backup. */
export async function exportLogsData() {
  const indexedDetails = await loadIndexedDetails();
  return {
    summaries: readLogs(),
    details: indexedDetails,
    legacyDetails: readLegacyDetails(),
  };
}

/** Restore summaries, full IndexedDB details and legacy details from a backup. */
export async function importLogsData(data = {}) {
  if (!data || typeof data !== 'object') return;
  const summaries = Array.isArray(data.summaries) ? data.summaries : [];
  if (summaries.length) {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(summaries.slice(-MAX_LOGS)));
    } catch {
      localStorage.setItem(LOG_KEY, JSON.stringify(summaries.slice(-240)));
    }
  }
  const details = data.details && typeof data.details === 'object' && !Array.isArray(data.details)
    ? data.details
    : {};
  const ids = Object.keys(details);
  if (ids.length) {
    const db = await openDetailDb();
    if (db) {
      try {
        const tx = db.transaction(DETAIL_STORE_NAME, 'readwrite');
        ids.forEach(id => tx.objectStore(DETAIL_STORE_NAME).put({ id, payload: cloneJson(details[id]) || {} }));
        await new Promise(resolve => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
      } catch {
        // Details restoration failure must not block the rest of the import.
      }
    }
  }
  if (data.legacyDetails && typeof data.legacyDetails === 'object') {
    try {
      localStorage.setItem(LEGACY_DETAIL_KEY, JSON.stringify(data.legacyDetails));
    } catch {
      // Ignore legacy detail write failures; summaries remain usable.
    }
  }
}
