import { KEYS } from './constants.js';
import { flushConversationWrites, getActiveConvId, getConversations, replaceConversations } from './conversation-manager.js';

const SETTINGS_KEY = 'ai_chat_sync_settings';
const SYNC_KEYS = new Set([KEYS.CONFIGS, KEYS.ACTIVE_CONFIG, KEYS.ACTIVE_CONV, 'ai_chat_params']);
const DEVICE_KEY = 'ai_chat_sync_device_id';
const REVISION_KEY = 'ai_chat_sync_revision';
let settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
let deviceId = localStorage.getItem(DEVICE_KEY);
let revision = Number(localStorage.getItem(REVISION_KEY) || 0);
let timer = null;
let polling = null;
let applyingRemote = false;
let syncPromise = null;
let pushPromise = null;
let resumeTimer = null;

if (!deviceId) {
  deviceId = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(DEVICE_KEY, deviceId);
}

function baseUrl() {
  return String(settings.serverUrl || '').replace(/\/$/, '');
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-AI-Chat-Token': String(settings.token || '') };
}

function rememberRevision(value) {
  revision = Math.max(0, Number(value) || 0);
  localStorage.setItem(REVISION_KEY, String(revision));
}

function sanitizeConfigs(configs) {
  return (Array.isArray(configs) ? configs : []).map(({ key, ...config }) => config);
}

async function snapshot() {
  await flushConversationWrites();
  return {
    configs: sanitizeConfigs(JSON.parse(localStorage.getItem(KEYS.CONFIGS) || '[]')),
    activeConfig: localStorage.getItem(KEYS.ACTIVE_CONFIG) || '',
    conversations: structuredClone(getConversations()),
    activeConv: getActiveConvId(),
    params: JSON.parse(localStorage.getItem('ai_chat_params') || '{}'),
  };
}

async function applySnapshot(data) {
  if (!data || typeof data !== 'object') return false;
  applyingRemote = true;
  try {
    if (Array.isArray(data.conversations)) {
      const localConvs = getConversations();
      const remoteById = new Map(data.conversations.map(c => [c.id, c]));
      const merged = [];
      const seen = new Set();
      for (const conv of localConvs) {
        const rem = remoteById.get(conv.id);
        if (rem) {
          const localSize = Array.isArray(conv.messages) ? conv.messages.length : 0;
          const remSize = Array.isArray(rem.messages) ? rem.messages.length : 0;
          merged.push(remSize >= localSize ? rem : conv);
        } else {
          merged.push(conv);
        }
        seen.add(conv.id);
      }
      for (const conv of data.conversations) {
        if (!seen.has(conv.id)) merged.push(conv);
      }
      await replaceConversations(merged, typeof data.activeConv === 'string' ? data.activeConv : getActiveConvId());
    }
    if (typeof data.activeConv === 'string') localStorage.setItem(KEYS.ACTIVE_CONV, data.activeConv);
    if (Array.isArray(data.configs)) {
      const localConfigs = JSON.parse(localStorage.getItem(KEYS.CONFIGS) || '[]');
      const keysById = new Map(localConfigs.map(item => [item.id, item.key || '']));
      localStorage.setItem(KEYS.CONFIGS, JSON.stringify(data.configs.map(item => ({ ...item, key: keysById.get(item.id) || '' }))));
    }
    if (typeof data.activeConfig === 'string') localStorage.setItem(KEYS.ACTIVE_CONFIG, data.activeConfig);
    if (data.params && typeof data.params === 'object') localStorage.setItem('ai_chat_params', JSON.stringify(data.params));
    return true;
  } finally {
    applyingRemote = false;
  }
}

function syncMode() {
  return ['two-way', 'pull-only', 'push-only'].includes(settings.mode) ? settings.mode : 'two-way';
}

export function getSyncSettings() { return { ...settings, mode: syncMode() }; }
export function isSyncEnabled() { return Boolean(settings.enabled && baseUrl() && settings.token); }
export function getSyncServerUrl() { return baseUrl(); }
export function getSyncHeaders() { return headers(); }

export function saveSyncSettings(next) {
  settings = { ...settings, ...next, enabled: Boolean(next.enabled) };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  rememberRevision(0);
  stopSync();
  if (isSyncEnabled()) startSync();
}

export async function syncNow({ pushFirst = false } = {}) {
  if (!isSyncEnabled()) throw new Error('请先填写同步服务器地址和同步口令');
  if (document.hidden) return { revision, paused: true };
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    if (syncMode() === 'push-only') return { revision, mode: 'push-only' };
    if (pushFirst && syncMode() !== 'pull-only') await pushSnapshot();
    let response;
    try {
      response = await fetch(`${baseUrl()}/api/sync`, { headers: headers(), cache: 'no-store' });
    } catch {
      throw new Error('无法连接电脑：请确认手机已连接同一 Wi-Fi、地址正确且电脑防火墙已放行 5200 端口');
    }
    if (!response.ok) throw new Error(response.status === 401 ? '同步口令错误' : `服务器错误 HTTP ${response.status}`);
    const state = await response.json();
    const nextRevision = Number(state.revision || 0);
    if (nextRevision <= revision) return state;
    rememberRevision(nextRevision);
    if (state.updatedBy !== deviceId && await applySnapshot(state.data)) {
      window.dispatchEvent(new CustomEvent('ai-chat-sync-applied'));
    }
    return state;
  })();
  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

export async function pushSnapshot() {
  if (!isSyncEnabled() || syncMode() === 'pull-only' || document.hidden) return;
  if (pushPromise) return pushPromise;
  pushPromise = (async () => {
    let response;
    try {
      response = await fetch(`${baseUrl()}/api/sync`, { method: 'POST', headers: headers(), body: JSON.stringify({ deviceId, data: await snapshot() }) });
    } catch {
      throw new Error('无法连接电脑：请确认手机已连接同一 Wi-Fi、地址正确且电脑防火墙已放行 5200 端口');
    }
    if (!response.ok) throw new Error(response.status === 401 ? '同步口令错误' : `服务器错误 HTTP ${response.status}`);
    const state = await response.json();
    rememberRevision(state.revision || revision);
    return state;
  })();
  try {
    return await pushPromise;
  } finally {
    pushPromise = null;
  }
}

function queuePush() {
  if (applyingRemote || !isSyncEnabled() || document.hidden) return;
  clearTimeout(timer);
  timer = setTimeout(() => pushSnapshot().catch(() => {}), 700);
}

function runScheduledSync() {
  if (document.hidden || !isSyncEnabled()) return;
  if (syncMode() === 'push-only') pushSnapshot().catch(() => {});
  else syncNow().catch(() => {});
}

export function startSync() {
  if (!isSyncEnabled() || document.hidden) return;
  stopSync();
  runScheduledSync();
  polling = window.setInterval(runScheduledSync, 3000);
}

export function stopSync() {
  if (polling) window.clearInterval(polling);
  polling = null;
  clearTimeout(timer);
  clearTimeout(resumeTimer);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSync();
    return;
  }
  if (!isSyncEnabled()) return;
  // Give WebView networking a brief moment to resume, then perform one serialized
  // sync before restarting polling. This avoids a burst of stale background calls.
  resumeTimer = window.setTimeout(startSync, 250);
});

const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function(key, value) {
  originalSetItem.call(this, key, value);
  if (this === localStorage && SYNC_KEYS.has(key)) queuePush();
};
window.addEventListener('ai-chat-conversations-changed', queuePush);
