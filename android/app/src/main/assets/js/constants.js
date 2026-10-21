/* ============================================================
   constants.js — App-wide constants and shared utilities
   ============================================================ */

/** localStorage keys */
export const KEYS = {
  CONFIGS:        'ai_chat_configs',
  ACTIVE_CONFIG:  'ai_chat_active_config',
  CONVERSATIONS:  'ai_chat_conversations',
  ACTIVE_CONV:    'ai_chat_active_conv',
};

/** Default config blueprint */
export const DEFAULT_CONFIG = Object.freeze({
  id:           '',
  name:         '默认配置',
  apiType:      'openai',
  url:          'https://api.openai.com/v1',
  key:          '',
  defaultModel: 'gpt-4o',
  models:       ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'],
  useProxy:     false,
  // 'auto' 按模型名自动决定是否发送 temperature / top_p；'always' 强制发送；'never' 从不发送
  samplingMode: 'auto',
});

/** Generate a unique short ID */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** Escape HTML entities */
export function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

/** Convert visible newline markers from imported or model-generated text. */
export function normalizeVisibleNewlines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n|\/n/g, '\n');
}

/** Split a textarea list while accepting old visible newline markers. */
export function splitVisibleLines(text) {
  return normalizeVisibleNewlines(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** Truncate text for auto-titling */
export function autoTitle(text) {
  const t = text.replace(/\n/g, ' ').trim();
  return t.length > 30 ? t.substring(0, 30) + '...' : (t || '新对话');
}
