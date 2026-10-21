/* ============================================================
   storage.js — Generic localStorage wrapper
   ============================================================ */

/**
 * Read JSON from localStorage. Returns defaultValue if missing or corrupt.
 */
export function load(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Write a JSON-serializable value to localStorage.
 */
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage write failed for', key, e);
  }
}

/**
 * Read a raw string from localStorage (no JSON parsing).
 */
export function loadRaw(key, defaultValue = '') {
  return localStorage.getItem(key) ?? defaultValue;
}

/**
 * Write a raw string to localStorage.
 */
export function saveRaw(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('localStorage write failed for', key, e);
  }
}
