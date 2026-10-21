/* ============================================================
   config-manager.js — API configuration state & operations
   ============================================================ */

import { KEYS, DEFAULT_CONFIG, generateId } from './constants.js';
import { load, save, loadRaw, saveRaw } from './storage.js';

/** In-memory list of all config objects */
const storedConfigs = load(KEYS.CONFIGS, []);
let configs = storedConfigs.map(config => {
  const { proxyUrl: _removedProxyUrl, ...rest } = config || {};
  return rest;
});
if (storedConfigs.some(config => Object.prototype.hasOwnProperty.call(config || {}, 'proxyUrl'))) {
  save(KEYS.CONFIGS, configs);
}

/** ID of the currently active config */
let activeConfigId = loadRaw(KEYS.ACTIVE_CONFIG, '');

// ---- Public getters ----

export function getConfigs()                    { return configs; }
export function getActiveConfigId()             { return activeConfigId; }

export function getActiveConfig() {
  const config = configs.find(c => c.id === activeConfigId) || configs[0] || null;
  if (config && !['openai', 'gemini'].includes(config.apiType)) config.apiType = 'openai';
  return config;
}

// ---- Lifecycle ----

/** Ensure at least one config exists. Returns the new ID if created. */
export function ensureConfigs() {
  if (configs.length === 0) {
    const c = { ...DEFAULT_CONFIG, id: generateId() };
    configs = [c];
    persist();
    activate(c.id);
    return c.id;
  }
  if (!configs.find(c => c.id === activeConfigId)) {
    activate(configs[0].id);
  }
  return null;
}

// ---- CRUD ----

export function addConfig(data) {
  const c = { ...data, id: generateId() };
  configs.push(c);
  persist();
  return c;
}

export function updateConfig(id, data) {
  const idx = configs.findIndex(c => c.id === id);
  if (idx < 0) return false;
  configs[idx] = { ...data, id };
  persist();
  return true;
}

export function deleteConfig(id) {
  if (configs.length <= 1) return false;
  configs = configs.filter(c => c.id !== id);
  if (activeConfigId === id) {
    activate(configs[0].id);
  }
  persist();
  return true;
}

// ---- Activation ----

export function activate(id) {
  activeConfigId = id;
  saveRaw(KEYS.ACTIVE_CONFIG, id);
}

/** Get the default model string for the active config. */
export function getDefaultModel() {
  const cfg = getActiveConfig();
  return cfg?.defaultModel || cfg?.models?.[0] || 'gpt-4o';
}

/** Get model list for the active config. */
export function getActiveModels() {
  const cfg = getActiveConfig();
  return cfg?.models || [];
}

// ---- Internal ----

function persist() {
  save(KEYS.CONFIGS, configs);
}
