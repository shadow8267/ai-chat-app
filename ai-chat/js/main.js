/* ============================================================
   main.js — Entry point, event wiring, orchestration
   ============================================================ */

import { KEYS, normalizeVisibleNewlines } from './constants.js';
import { load } from './storage.js';
import { ensureConfigs, getActiveConfig } from './config-manager.js';
import { ensureConversations, initializeConversations, replaceConversations, flushConversationWrites, setConversationStorageErrorHandler, addUserMessage, addDiscussionMessage, getDiscussionMessages, updateDiscussionMessage, truncateDiscussionAfter, getActiveConvId, getActiveConv, getActiveMessages, getConversations, persistConversations, deleteConversation, getAllAiVersionGroups, setActiveVersion, getActiveVersion, getVisibleMessagesThrough, updateMessage, updateAiMessage, truncateAfter, forkConversation } from './conversation-manager.js';
import { migrateLegacyConversationsIfNeeded } from './conversation-migration.js';
import { getStoredSnapshots, putStoredSnapshot, deleteStoredSnapshot, trimStoredSnapshots } from './conversation-store.js';
import { installCustomSelects, installCustomSelectDismissers } from './custom-select.js?v=1';
import { sendMessage, sendDiscussionMessage } from './chat-engine.js?v=6';
import { clearLogs, getLogs, getLogSettings, saveLogSettings, logEvent, summarizeCacheUsage, exportLogsData, importLogsData } from './logger.js';
import {
  openSidebarIfWide,
  renderConfigSelect, renderModelSelect, renderConvList, setSearchQuery,
  renderChatMessages, getSelectedModel,
  scrollToBottom, createScrollFollower, setChatPinned,
  installChatViewportAnchor, installMineNavigator,
  appendAiPlaceholder, showThinkBlock, updateThinkText, updateStreamText, finalizeStreamGroup,
  setSendButtonNormal, setSendButtonStop,
  getInputText, clearInput, setStatus,
  openSettings, closeSettings, addNewConfig, saveConfigForm, deleteConfigForm, cancelEdit,
  handleConfigListClick, setDialogService,
} from './ui-renderer.js?v=96';
import { activate as activateConfig } from './config-manager.js';
import { activateConv, createConversation } from './conversation-manager.js';
import { getSyncSettings, isSyncEnabled, saveSyncSettings, startSync, stopSync, syncNow, pushSnapshot } from './sync-manager.js';
import { getWritingAgentState, updateWritingAgentState } from './conversation-manager.js';
import { addDirective, toggleDirective, removeDirective, replaceMemory, addSuggestions, generateAgentText, reviewAgentDraft, extractMemory, extractInitialMemory, reviseMemory, organizeWorldview, parseExtractionResult, extractionCategories, mergeExtractionIntoMemory, getAgentPromptSettings, updateAgentPrompt, addPromptTemplate, removePromptTemplate, togglePromptTemplate, buildMainCreationSystemInstruction } from './writing-agent.js?v=7';

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L18.8 8.7l-3.5-3.5L4 16.5Z"></path><path d="m14 6 3.5 3.5"></path></svg>';
const REGENERATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4L3 10"></path><path d="M3 5v5h5"></path><path d="M4 13a8 8 0 0 0 14.7 4L21 14"></path><path d="M21 19v-5h-5"></path></svg>';

// ---- Chat parameters (persisted to localStorage) ----
const SK_PARAMS = 'ai_chat_params';
function readStoredObject(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const savedParams = readStoredObject(SK_PARAMS);
const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
};
// Some OpenAI-compatible gateways reject exact zero sampling values even though
// upstream models may document them. Keep the controls in the portable range.
const params = {
  temperature: clamp(savedParams.temperature ?? 0.7, 0.01, 2, 0.7),
  topP: clamp(savedParams.topP ?? 1.0, 0.05, 1, 1.0),
  topK: Math.round(clamp(savedParams.topK ?? 40, 1, 100, 40)),
  maxTokens: Math.round(clamp(savedParams.maxTokens ?? 4096, 64, 32768, 4096) / 64) * 64,
  geminiSafety: {
    hateSpeech: ['default', 'block_low', 'block_medium', 'block_only_high', 'off'].includes(savedParams.geminiSafety?.hateSpeech) ? savedParams.geminiSafety.hateSpeech : 'default',
    harassment: ['default', 'block_low', 'block_medium', 'block_only_high', 'off'].includes(savedParams.geminiSafety?.harassment) ? savedParams.geminiSafety.harassment : 'default',
    dangerous: ['default', 'block_low', 'block_medium', 'block_only_high', 'off'].includes(savedParams.geminiSafety?.dangerous) ? savedParams.geminiSafety.dangerous : 'default',
    sexual: ['default', 'block_low', 'block_medium', 'block_only_high', 'off'].includes(savedParams.geminiSafety?.sexual) ? savedParams.geminiSafety.sexual : 'default',
  },
  reasoningEffort: ['', 'low', 'medium', 'high', 'max'].includes(savedParams.reasoningEffort) ? savedParams.reasoningEffort : '',
  systemPromptEnabled: savedParams.systemPromptEnabled === true,
  systemPrompt: typeof savedParams.systemPrompt === 'string' ? savedParams.systemPrompt : '',
};
function persistParams() {
  localStorage.setItem(SK_PARAMS, JSON.stringify(params));
}
export function getChatParams() { return { ...params, agentTask: document.getElementById('agentDetailInput')?.value || '' }; }

function withMainCreationContext(options = {}) {
  const additionalSystemInstruction = buildMainCreationSystemInstruction();
  return additionalSystemInstruction
    ? { ...options, additionalSystemInstruction }
    : { ...options };
}

// ---- Stream state ----
let isStreaming = false;
let abortCtrl = null;
let isDiscussionStreaming = false;
let discussionAbortCtrl = null;
let discussionStream = null;
let discussionStreamSequence = 0;
let agentAbortCtrl = null;
let agentDraftText = '';
let agentResultText = '';
let agentReviewText = '';
let agentExtraction = null;
let agentThinkText = '';
let agentDraftTask = '';
let agentDraftUpdatedAt = 0;
let agentCandidatesDraftUpdatedAt = 0;
let agentRequestContext = null;
let agentWorldviewResultText = '';
let agentMemoryResultText = '';
let agentDetailTab = 'overview';

function setAgentDetailTab(tab) {
  const allowed = ['overview', 'knowledge', 'writing', 'review'];
  agentDetailTab = allowed.includes(tab) ? tab : 'overview';
  document.querySelectorAll('[data-agent-detail-tab]').forEach(button => {
    const active = button.dataset.agentDetailTab === agentDetailTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-agent-detail-panel]').forEach(panel => {
    panel.hidden = panel.dataset.agentDetailPanel !== agentDetailTab;
  });
}

function setAgentActionStatus(text, error = false) {
  ['agentDetailWritingStatus', 'agentDetailStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', Boolean(error));
  });
}

function animateAgentButton(id, state = 'clicked') {
  const button = document.getElementById(id);
  if (!button) return;
  button.classList.remove('is-clicked', 'is-success', 'is-error');
  void button.offsetWidth;
  button.classList.add(`is-${state}`);
  window.setTimeout(() => button.classList.remove(`is-${state}`), 650);
}

function getAgentDraftValue() {
  return (document.getElementById('agentDetailDraft')?.value || agentDraftText || '').trim();
}

function persistAgentWorkspace(extra = {}) {
  const current = getWritingAgentState().workspace || {};
  updateWritingAgentState({
    workspace: {
      ...current,
      draft: {
        text: agentDraftText,
        reasoning: agentThinkText,
        task: agentDraftTask,
        updatedAt: agentDraftUpdatedAt,
      },
      review: {
        text: agentReviewText,
        draftUpdatedAt: agentDraftUpdatedAt,
        updatedAt: agentReviewText ? (Number(current.review?.updatedAt) || Date.now()) : 0,
      },
      memoryCandidates: agentExtraction ? {
        source: extra.candidateSource || current.memoryCandidates?.source || 'draft',
        data: agentExtraction,
        sourceDraftUpdatedAt: agentCandidatesDraftUpdatedAt,
        updatedAt: Date.now(),
      } : null,
    },
  });
}

function loadAgentWorkspace() {
  const state = getWritingAgentState();
  const workspace = state.workspace || {};
  agentDraftText = normalizeVisibleNewlines(workspace.draft?.text || '');
  agentThinkText = normalizeVisibleNewlines(workspace.draft?.reasoning || '');
  agentDraftTask = normalizeVisibleNewlines(workspace.draft?.task || '');
  agentDraftUpdatedAt = Number(workspace.draft?.updatedAt) || 0;
  // Legacy lastPreflight remains stored for data compatibility, but it described a writing plan
  // and must not be presented as a review of the current draft.
  agentReviewText = normalizeVisibleNewlines(workspace.review?.text || '');
  agentExtraction = workspace.memoryCandidates?.data || null;
  agentCandidatesDraftUpdatedAt = Number(workspace.memoryCandidates?.sourceDraftUpdatedAt) || 0;
  agentResultText = '';
  agentWorldviewResultText = '';
  agentMemoryResultText = '';
}

function isAgentRequestCurrent(conversationId) {
  return Boolean(agentRequestContext && agentRequestContext.conversationId === conversationId && getActiveConvId() === conversationId);
}

function normalizeModelName(model) {
  return String(model || '').trim().replace(/^models\//i, '').trim();
}

function isGeminiModel(model = getSelectedModel()) {
  const config = getActiveConfig();
  const modelName = normalizeModelName(model);
  const configuredModels = Array.isArray(config?.models) ? config.models.map(normalizeModelName) : [];
  const knownGeminiName = /^gemini(?:[.-]|$)/i.test(modelName);
  const belongsToGeminiConfig = config?.apiType === 'gemini' && (!modelName || configuredModels.includes(modelName) || modelName === normalizeModelName(config?.defaultModel));
  return knownGeminiName || belongsToGeminiConfig || config?.apiType === 'gemini';
}

function updateGeminiSettingsVisibility(model = getSelectedModel()) {
  const selectedModel = model?.target?.value ?? model;
  const visible = isGeminiModel(selectedModel);
  document.querySelectorAll('.gemini-only-setting').forEach(element => { element.hidden = !visible; });
}

function updateGeminiConfigHint() {
  const apiType = document.getElementById('editApiType')?.value;
  const hint = document.getElementById('geminiApiHint');
  if (hint) hint.hidden = apiType !== 'gemini';
}

// ---- Init ----

const THEME_KEY = 'ai_chat_theme';
const THEME_IDS = ['original', 'current', 'linear', 'liquid-glass'];

function applyTheme(themeName, persist = true) {
  const theme = THEME_IDS.includes(themeName) ? themeName : 'current';
  const previousTheme = document.documentElement.dataset.theme;
  const themeChanged = Boolean(previousTheme && previousTheme !== theme);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const commitTheme = () => {
    THEME_IDS.forEach(id => {
      const link = document.getElementById(`theme-${id}`);
      if (link) link.disabled = id !== theme;
    });
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.theme-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.theme === theme);
    });
  };

  if (themeChanged && !reduceMotion && typeof document.startViewTransition === 'function') {
    clearTimeout(applyTheme.transitionTimer);
    document.documentElement.classList.remove('theme-transition');
    document.startViewTransition(commitTheme);
  } else {
    if (themeChanged && !reduceMotion) {
      document.documentElement.classList.add('theme-transition');
      clearTimeout(applyTheme.transitionTimer);
      applyTheme.transitionTimer = setTimeout(() => document.documentElement.classList.remove('theme-transition'), 340);
    }
    commitTheme();
  }

  if (persist) localStorage.setItem(THEME_KEY, theme);
}

/* ==========================================================================
   自定义背景图片（所有主题通用）
   --------------------------------------------------------------------------
   图片以 dataURL 存 localStorage；上传的照片会先缩到长边 1600px 再存，
   免得一张手机照就把 localStorage 撑爆。
   实际渲染在 css/style.css 的 html.app-bg-custom::before —— 单独一层是为了
   能对图片做 filter: blur()（高斯模糊）而不连带糊掉页面内容。
   ========================================================================== */
const APP_BG_KEY = 'ai_chat_app_background';
const APP_BG_BLUR_KEY = 'ai_chat_app_background_blur';
const APP_BG_LEGACY_KEY = 'ai_chat_liquid_glass_wallpaper';   // 旧版「液态玻璃壁纸」，读到就迁移
const APP_BG_MAX_EDGE = 1600;
const APP_BG_BLUR_MAX = 40;

/** 应用背景图与模糊强度（blurPx = 0 表示不模糊） */
function applyAppBackground(dataUrl, blurPx) {
  const root = document.documentElement;
  const hasImage = !!dataUrl;
  if (hasImage) root.style.setProperty('--app-bg-image', `url("${dataUrl}")`);
  else root.style.removeProperty('--app-bg-image');

  const blur = Math.max(0, Math.min(APP_BG_BLUR_MAX, Number(blurPx) || 0));
  root.style.setProperty('--app-bg-blur', `${blur}px`);
  root.classList.toggle('app-bg-custom', hasImage);
  root.classList.toggle('app-bg-blurred', hasImage && blur > 0);
  return blur;
}

async function shrinkImageForBackground(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, APP_BG_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * 液态玻璃主题：两侧栏是「脱离文档流、从窗口左右整块滑出」的浮动面板，
 * 内容区要靠 .main 的 padding 给它们让位 —— 面板收起时 padding 必须归零，
 * 所以把收起状态同步到 <html> 上供主题 CSS 使用。
 * 用 class 而不是 CSS 的 :has()，老一点的 WebView 也稳。
 */
function syncLiquidGlassPanelState() {
  const root = document.documentElement;
  root.classList.toggle('lg-left-collapsed', !!document.getElementById('sidebar')?.classList.contains('collapsed'));
  root.classList.toggle('lg-right-collapsed', !!document.getElementById('rightPanel')?.classList.contains('collapsed'));
}

function installAppBackground() {
  const section = document.getElementById('appBgSection');
  if (!section) return;
  const fileInput = document.getElementById('appBgFile');
  const pickBtn = document.getElementById('appBgPickBtn');
  const resetBtn = document.getElementById('appBgResetBtn');
  const status = document.getElementById('appBgStatus');
  const blurInput = document.getElementById('appBgBlur');
  const blurValue = document.getElementById('appBgBlurValue');
  const nativeHint = document.getElementById('appBgNativeHint');

  // 旧版「液态玻璃壁纸」键做一次迁移，用户不必重新设一张
  let stored = localStorage.getItem(APP_BG_KEY) || '';
  if (!stored) {
    const legacy = localStorage.getItem(APP_BG_LEGACY_KEY) || '';
    if (legacy) {
      stored = legacy;
      localStorage.setItem(APP_BG_KEY, legacy);
      localStorage.removeItem(APP_BG_LEGACY_KEY);
    }
  }

  // 背景设置只在液态玻璃主题下出现；监听 data-theme，applyTheme() 无需改动
  const syncVisibility = () => {
    section.hidden = document.documentElement.dataset.theme !== 'liquid-glass';
  };
  new MutationObserver(syncVisibility).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });
  syncVisibility();

  const initialBlur = applyAppBackground(stored, localStorage.getItem(APP_BG_BLUR_KEY));
  if (blurInput) blurInput.value = String(initialBlur);
  if (blurValue) blurValue.textContent = `${initialBlur} px`;
  const syncStatus = text => {
    if (status) status.textContent = text || (stored ? '已应用背景图' : '未设置');
  };
  syncStatus();

  // 要透出真实手机壁纸，必须原生把 WebView 与窗口都设为透明 —— 在那之前不能
  // 靠 UA 判断：WebView 不透明时「透出来」的是白底，比默认底色更难看。
  // 所以这里只暴露一个接口，等原生侧真的做好了透明再调用它。
  window.__aiChatEnableNativeWallpaper = () => {
    document.documentElement.classList.add('lg-native-wallpaper');
    if (nativeHint) nativeHint.hidden = false;
  };

  pickBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (status) status.textContent = '处理中…';
    try {
      const dataUrl = await shrinkImageForBackground(file);
      stored = dataUrl;
      localStorage.setItem(APP_BG_KEY, dataUrl);
      const blur = applyAppBackground(dataUrl, blurInput ? Number(blurInput.value) : 0);
      if (blurValue) blurValue.textContent = `${blur} px`;
      syncStatus('已应用背景图');
    } catch (error) {
      if (status) status.textContent = '设置失败：' + (error?.message || '图片无法读取或过大');
    }
  });
  resetBtn?.addEventListener('click', () => {
    stored = '';
    localStorage.removeItem(APP_BG_KEY);
    applyAppBackground('', blurInput ? Number(blurInput.value) : 0);
    syncStatus('已恢复默认背景');
  });
  blurInput?.addEventListener('input', () => {
    const value = Math.max(0, Math.min(APP_BG_BLUR_MAX, Number(blurInput.value) || 0));
    applyAppBackground(stored, value);
    localStorage.setItem(APP_BG_BLUR_KEY, String(value));
    if (blurValue) blurValue.textContent = `${value} px`;
  });
}

function promoteModalLayers() {
  ['appDialog', 'themeModal', 'settingsModal', 'logsModal', 'logDetailModal', 'discussionDetailModal', 'agentDetailModal', 'systemPromptModal', 'syncModal', 'aiMessageEditModal', 'revisionModal', 'dataCenterModal'].forEach(id => {
    const modal = document.getElementById(id);
    if (modal && modal.parentElement !== document.documentElement) {
      document.documentElement.appendChild(modal);
    }
  });
}

function showModal(id) {
  promoteModalLayers();
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('show');
  modal.style.setProperty('display', 'flex', 'important');
  modal.style.setProperty('visibility', 'visible', 'important');
  modal.style.setProperty('opacity', '1', 'important');
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('show');
  modal.style.removeProperty('display');
  modal.style.removeProperty('visibility');
  modal.style.removeProperty('opacity');
}

let activeDialog = null;

function dialogIconSvg(type) {
  if (type === 'danger') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 19h18.4L12 3Z"></path><path d="M12 8v5M12 16.5v.5"></path></svg>';
  if (type === 'prompt') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"></path><path d="M8 9h8M8 13h5"></path></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10v6M12 7.5v.5"></path></svg>';
}

function settleAppDialog(value) {
  const dialog = document.getElementById('appDialog');
  const resolver = activeDialog?.resolve;
  const previousFocus = activeDialog?.previousFocus;
  activeDialog = null;
  hideModal('appDialog');
  dialog?.setAttribute('aria-hidden', 'true');
  previousFocus?.focus?.({ preventScroll: true });
  resolver?.(value);
}

function openAppDialog({ mode = 'confirm', title = '请确认', message = '', value = '', inputLabel = '名称', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  if (activeDialog) settleAppDialog(activeDialog.mode === 'prompt' ? null : false);
  const dialog = document.getElementById('appDialog');
  const field = document.getElementById('appDialogField');
  const input = document.getElementById('appDialogInput');
  const cancelButton = document.getElementById('appDialogCancelBtn');
  const confirmButton = document.getElementById('appDialogConfirmBtn');
  if (!dialog || !field || !input || !cancelButton || !confirmButton) return Promise.resolve(mode === 'alert');

  document.getElementById('appDialogTitle').textContent = title;
  document.getElementById('appDialogMessage').textContent = message;
  document.getElementById('appDialogInputLabel').textContent = inputLabel;
  document.getElementById('appDialogIcon').innerHTML = dialogIconSvg(mode === 'prompt' ? 'prompt' : danger ? 'danger' : 'info');
  dialog.classList.toggle('danger', danger);
  field.hidden = mode !== 'prompt';
  input.value = mode === 'prompt' ? String(value ?? '') : '';
  cancelButton.hidden = mode === 'alert';
  cancelButton.textContent = cancelText;
  confirmButton.textContent = confirmText;
  confirmButton.classList.toggle('btn-danger', danger);
  dialog.setAttribute('aria-hidden', 'false');
  showModal('appDialog');

  return new Promise(resolve => {
    activeDialog = { mode, resolve, previousFocus: document.activeElement };
    window.requestAnimationFrame(() => {
      if (mode === 'prompt') {
        input.focus();
        input.select();
      } else {
        confirmButton.focus();
      }
    });
  });
}

const appDialog = {
  alert(message, options = {}) {
    return openAppDialog({ mode: 'alert', message, title: options.title || '提示', confirmText: options.confirmText || '知道了' });
  },
  confirm(message, options = {}) {
    return openAppDialog({ mode: 'confirm', message, ...options });
  },
  prompt(message, value = '', options = {}) {
    return openAppDialog({ mode: 'prompt', message, value, ...options });
  },
};

setDialogService(appDialog);

function openThemeModal() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'current', false);
  showModal('themeModal');
}

function closeThemeModal() {
  hideModal('themeModal');
}

/** 拖动调整输入框高度时允许缩到的最小高度（约 3 行正文） */
const RESIZE_FLOOR_HEIGHT = 72;

function installTextareaResizeHandles() {
  const eligibleSelector = [
    '.modal textarea:not(#userInput)',
    '.discussion-composer textarea',
    '.discussion-detail-composer textarea',
    '.edit-textarea',
    '.agent-detail-editor',
    '.data-center-editor',
  ].join(',');

  const enhance = textarea => {
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.closest('.textarea-resize-shell')) return;
    const computed = window.getComputedStyle(textarea);
    if (textarea.id === 'userInput') return;
    const originalFlex = computed.flex;
    const shell = document.createElement('div');
    shell.className = 'textarea-resize-shell';
    if (originalFlex && originalFlex !== '0 1 auto') shell.style.flex = originalFlex;
    textarea.parentNode.insertBefore(shell, textarea);
    shell.appendChild(textarea);
    const handle = document.createElement('button');
    handle.className = 'textarea-resize-handle';
    handle.type = 'button';
    handle.tabIndex = -1;
    handle.setAttribute('aria-label', '调整输入框高度');
    handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19h10V9"></path><path d="m19 9-5 5"></path><path d="m19 14-5 5"></path></svg>';
    shell.appendChild(handle);

    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startY = event.clientY;
      textarea.focus({ preventScroll: true });
      const startHeight = textarea.getBoundingClientRect().height;
      // 允许缩到 CSS 里设定的 min-height 以内：不少输入框的 min-height 是 220~340px
      // （那是用来定初始高度的），却被当成了拖动下限，导致几乎缩不动。
      const cssMinHeight = Number.parseFloat(computed.minHeight);
      const minHeight = Number.isFinite(cssMinHeight) && cssMinHeight > 0
        ? Math.min(cssMinHeight, RESIZE_FLOOR_HEIGHT)
        : RESIZE_FLOOR_HEIGHT;
      const cssMaxHeight = Number.parseFloat(computed.maxHeight);
      const viewportLimit = Math.max(minHeight, (window.visualViewport?.height || window.innerHeight) * .82);
      const maxHeight = Number.isFinite(cssMaxHeight) && cssMaxHeight > 0
        ? Math.max(minHeight, Math.min(cssMaxHeight, viewportLimit))
        : viewportLimit;
      textarea.classList.add('is-resizing');
      const move = moveEvent => {
        const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + moveEvent.clientY - startY));
        textarea.style.height = `${Math.round(nextHeight)}px`;
      };
      const end = () => {
        textarea.classList.remove('is-resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move, { passive: true });
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', end, { once: true });
    });
  };

  const scan = root => {
    if (root instanceof HTMLTextAreaElement && root.matches(eligibleSelector)) enhance(root);
    root.querySelectorAll?.(eligibleSelector).forEach(enhance);
  };
  scan(document);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) scan(node);
  }))).observe(document.documentElement, { childList: true, subtree: true });
}

function installKeyboardAvoidance() {
  const root = document.documentElement;
  const body = document.body;
  let stableHeight = window.innerHeight;
  let nativeInset = 0;
  // 系统栏（导航栏/手势条）高度，CSS px。原生报来的 keyboardCss 已经扣掉了它，
  // 但键盘顶边其实是 innerHeight - (keyboardCss + 系统栏)，所以必须单独记一份。
  let nativeSafeBottom = 0;
  let frame = 0;
  let revealTimers = [];

  // 可编辑控件集合。原来 needsFocusedReveal 是一份手工白名单（只列了 8 个选择器），
  // 于是后加的弹窗（重命名对话 #appDialogInput、手动编辑正文 #aiMessageEditInput、
  // 系统提示词 #systemPromptInput、局域网同步 #syncToken 等）全被漏掉 ——
  // 键盘弹出后输入框落在键盘下方，用户看不到自己输入的内容。
  // 改为通用规则：任何获得焦点的输入控件都要被滚入可视区。
  const EDITABLE_SELECTOR = 'textarea, input, select, [contenteditable="true"]';
  const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit'];
  const isEditableTarget = target => {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return !!target.matches?.(EDITABLE_SELECTOR);
  };
  const hasFocusedEditor = () => isEditableTarget(document.activeElement);
  /** 需要「滚入可视区」的控件；主输入框由 composer 自己的键盘布局处理，排除以免与它抢滚动 */
  const needsFocusedReveal = target => {
    if (!isEditableTarget(target)) return false;
    if (target.id === 'userInput') return false;
    if (NON_TEXT_INPUT_TYPES.includes(target.type)) return false;
    return true;
  };
  const findScrollContainer = target => {
    let current = target?.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) return current;
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const revealFocusedEditor = target => {
    if (!needsFocusedReveal(target) || document.activeElement !== target) return;
    const container = findScrollContainer(target);
    const rect = target.getBoundingClientRect();
    const viewportTop = Math.max(0, window.visualViewport?.offsetTop || 0);
    const fallbackCoveredHeight = body.classList.contains('keyboard-fallback') ? nativeInset + nativeSafeBottom : 0;
    const viewportBottom = viewportTop + Math.max(1, window.visualViewport?.height || window.innerHeight) - fallbackCoveredHeight;
    const inOverlay = !!target.closest('.modal-overlay, .conversation-manage-overlay');
    const composer = inOverlay ? null : document.querySelector('.input-area');
    const composerTop = composer?.getBoundingClientRect().top;
    const safeBottom = Math.min(viewportBottom - 16, Number.isFinite(composerTop) ? composerTop - 12 : viewportBottom - 16);
    let delta = 0;
    if (rect.bottom > safeBottom) delta = rect.bottom - safeBottom;
    else if (rect.top < viewportTop + 12) delta = rect.top - (viewportTop + 12);
    if (Math.abs(delta) < 2) return;
    if (container === document.documentElement || container === document.body || container === document.scrollingElement) {
      // 没有可滚动的祖先：直接 window.scrollBy 在「固定高度 + overflow:hidden」的
      // body 上是无效的（弹窗里就是这个情况），改用 scrollIntoView 让它自己找
      // 需要的滚动容器，浏览器会把嵌套的滚动祖先一起滚。
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      } else {
        window.scrollBy({ top: delta, behavior: 'auto' });
      }
    } else {
      container.scrollTop += delta;
    }
  };
  const scheduleFocusedReveal = target => {
    if (!needsFocusedReveal(target)) return;
    // 键盘是异步出现的，各 ROM 的通知时机差别很大 —— 连续多试几次。
    // 每次都会重新算 delta，已经到位时 delta 为 0，不会乱滚。
    revealTimers.forEach(window.clearTimeout);
    revealTimers = [180, 450, 800, 1300].map(delay => window.setTimeout(() => {
      if (!needsFocusedReveal(document.activeElement)) return;
      window.requestAnimationFrame(() => revealFocusedEditor(document.activeElement));
    }, delay));
  };
  const updateViewport = () => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const layoutHeight = Math.max(1, Math.round(window.innerHeight));
      const visualHeight = Math.max(1, Math.round(window.visualViewport?.height || layoutHeight));
      if (!hasFocusedEditor() && layoutHeight > stableHeight) stableHeight = layoutHeight;

      // adjustResize is the primary path: when Android shrinks WebView, use its new
      // layout height and do not translate the composer. Native inset is only a
      // fallback for older ROMs whose WebView height remains unchanged.
      const layoutResized = hasFocusedEditor() && stableHeight - layoutHeight > 80;
      const visualResized = hasFocusedEditor() && layoutHeight - visualHeight > 80;
      const fallbackInset = !layoutResized && !visualResized && nativeInset > 80 ? nativeInset : 0;
      // ⚠️ 兜底路径（WebView 不随键盘缩放，只有原生 inset 报到）下，innerHeight 与
      // visualViewport.height 都还是整屏高 —— 必须把键盘占掉的高度减掉，否则
      // --app-height 依旧是整屏高 → 弹窗的 max-height 不缩小、也不会变成可滚动，
      // 焦点控件就被键盘盖住（这正是「手动编辑正文」正文被挡的原因）。
      // 另外键盘顶边 = innerHeight - (keyboardCss + 系统栏 bottom)：原生报的
      // keyboardCss 扣掉了系统栏，所以要把系统栏加回来，否则弹窗底部还差一截。
      const fallbackCovered = fallbackInset > 0 ? fallbackInset + nativeSafeBottom : 0;
      const appHeight = visualResized
        ? visualHeight
        : (fallbackCovered > 0 ? Math.max(1, layoutHeight - fallbackCovered) : layoutHeight);
      const keyboardOpen = layoutResized || visualResized || fallbackCovered > 0;

      root.style.setProperty('--app-height', `${appHeight}px`);
      // 键盘高度已经并进 --app-height（整块布局自己变矮了），所以 composer 不能再位移一次，
      // 否则会被顶到屏幕中间。下面 revealFocusedEditor 里仍用 nativeInset 算「被遮住多少」，
      // 因为那两个视口高度在兜底路径下并没有变小。
      root.style.setProperty('--keyboard-fallback-inset', '0px');
      body.classList.toggle('keyboard-open', keyboardOpen);
      body.classList.toggle('keyboard-fallback', fallbackInset > 0);
      // 不把 keyboardOpen 作为前置条件：键盘检测一旦失手（焦点判定异常、老 ROM 的
      // 视口不变化等），输入框就会一直留在键盘下面。改成无条件检查，
      // revealFocusedEditor 内部会先算 delta，桌面端正常情况不会产生任何滚动。
      if (needsFocusedReveal(document.activeElement)) scheduleFocusedReveal(document.activeElement);
    });
  };

  window.__aiChatAndroidInsets = (inset, top = 0, right = 0, bottom = 0, left = 0) => {
    nativeInset = Math.max(0, Number(inset) || 0);
    nativeSafeBottom = Math.max(0, Number(bottom) || 0);
    root.style.setProperty('--android-safe-top', `${Math.max(0, Number(top) || 0)}px`);
    root.style.setProperty('--android-safe-right', `${Math.max(0, Number(right) || 0)}px`);
    root.style.setProperty('--android-safe-bottom', `${Math.max(0, Number(bottom) || 0)}px`);
    root.style.setProperty('--android-safe-left', `${Math.max(0, Number(left) || 0)}px`);
    updateViewport();
  };
  window.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  document.addEventListener('focusin', event => {
    if (!isEditableTarget(event.target)) return;
    updateViewport();
    scheduleFocusedReveal(event.target);
  });
  document.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!hasFocusedEditor()) {
        nativeInset = 0;
        stableHeight = Math.max(stableHeight, window.innerHeight);
        updateViewport();
      }
    }, 120);
  });
  updateViewport();
}

function installAppLifecycle() {
  let suspended = false;
  let resumeTimer = 0;

  const suspend = () => {
    if (suspended) return;
    suspended = true;
    window.clearTimeout(resumeTimer);
    // Android may suspend or tear down sockets while the app is in background.
    // Abort proactively so the request follows the normal stopped path instead of
    // surfacing a delayed "Failed to fetch" error when the app returns.
    abortCtrl?.abort();
    discussionAbortCtrl?.abort();
    agentAbortCtrl?.abort();
    // Flush the debounced conversation writes immediately so the latest partial
    // response survives a background kill / crash.
    void flushConversationWrites().catch(() => {});
    stopSync();
  };
  const resume = () => {
    suspended = false;
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      if (isSyncEnabled()) startSync();
      if (!isStreaming && !isDiscussionStreaming && !agentAbortCtrl) setStatus(true, '就绪');
    }, 300);
  };

  window.__aiChatAppPause = suspend;
  window.__aiChatAppResume = resume;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else resume();
  });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
}

async function init() {
  installKeyboardAvoidance();
  installTextareaResizeHandles();
  installCustomSelects();
  installCustomSelectDismissers();
  installAppBackground();
  installChatViewportAnchor();
  installMineNavigator();
  syncLiquidGlassPanelState();
  installAppLifecycle();
  applyTheme(localStorage.getItem(THEME_KEY) || 'current', false);
  ensureConfigs();
  setStatus(false, '正在加载本地会话…');
  const migration = await migrateLegacyConversationsIfNeeded();
  await initializeConversations(migration.conversations);
  ensureConversations();
  await flushConversationWrites();
  setConversationStorageErrorHandler(error => {
    setStatus(false, `本地保存失败：${error?.message || '请立即导出数据并检查存储空间'}`);
  });
  loadAgentWorkspace();
  logEvent('operation', 'app_started', {}, 'AI Chat 已启动');

  openSidebarIfWide();
  renderConfigSelect();
  renderModelSelect();
  updateGeminiSettingsVisibility();
  renderConvList();
  renderChatMessages();
  renderDiscussionViews();
  applyReadingSettings();
  setStatus(true, '就绪');
  if (isSyncEnabled()) startSync();
  renderAgentPage();
}

// ---- Send / Stop ----

function finishStream() {
  isStreaming = false;
  abortCtrl = null;
  setSendButtonNormal();
}

function switchRightPanelPage(page) {
  const pages = {
    params: { panelId: 'paramsPage', tabId: 'paramsPageTab', title: '生成参数' },
    discussion: { panelId: 'discussionPage', tabId: 'discussionPageTab', title: '当前对话讨论' },
    agent: { panelId: 'agentPage', tabId: 'agentPageTab', title: '创作工作台' },
  };
  const activePage = pages[page] ? page : 'params';
  Object.entries(pages).forEach(([key, item]) => {
    const active = key === activePage;
    document.getElementById(item.panelId)?.classList.toggle('active', active);
    document.getElementById(item.tabId)?.classList.toggle('active', active);
    document.getElementById(item.tabId)?.setAttribute('aria-selected', String(active));
  });
  const title = document.getElementById('rightPanelTitle');
  if (title) title.textContent = pages[activePage].title;
}

function renderAgentPage() {
  const state = getWritingAgentState();
  const worldviewSwitch = document.getElementById('agentApplyWorldviewToMain');
  const memorySwitch = document.getElementById('agentApplyMemoryToMain');
  if (worldviewSwitch) worldviewSwitch.checked = state.applyWorldviewToMain;
  if (memorySwitch) memorySwitch.checked = state.applyMemoryToMain;
  const compactSummary = document.getElementById('agentCompactSummary');
  if (compactSummary) {
    const world = state.worldview?.trim() ? `世界观 ${state.worldview.trim().length} 字` : '未填写世界观';
    const savedMemory = state.memory?.trim() ? `作品记忆 ${state.memory.trim().length} 字` : '未填写作品记忆';
    const draftState = agentDraftText.trim() ? `有 ${agentDraftText.trim().length} 字待确认草稿` : '暂无待确认草稿';
    compactSummary.textContent = `${world} · ${savedMemory} · ${draftState}。工作台始终可用，草稿与记忆候选仍需手动确认。`;
  }
  const hint = document.getElementById('agentContextSwitchHint');
  if (hint) {
    const enabled = [
      state.applyWorldviewToMain ? '世界观' : '',
      state.applyMemoryToMain ? '作品记忆' : '',
    ].filter(Boolean);
    hint.textContent = enabled.length
      ? `主页正文将读取：${enabled.join('、')}。当前对话讨论仍不会读取创作资料。`
      : '两个开关均关闭，主页正文只使用自身对话和已启用的主页系统提示词。';
  }
}

function setAgentTargetText(target, text) {
  const normalized = normalizeVisibleNewlines(text);
  if ('value' in target) target.value = normalized;
  else target.textContent = normalized;
}

function getAgentTargetText(target) {
  return 'value' in target ? target.value : target.textContent;
}

function agentCallbacks(target, kind, conversationId) {
  const thinkTarget = document.getElementById('agentDetailThink');
  let firstContentLogged = false;
  const updateTarget = (text, skipNormalize = false) => {
    if (!isAgentRequestCurrent(conversationId)) {
      logEvent('agent', 'agent_stream_dropped', { kind, conversationId, activeConvId: getActiveConvId() }, '创作工作台流式内容因会话校验未通过被丢弃');
      return;
    }
    if (!firstContentLogged && String(text || '').trim()) {
      firstContentLogged = true;
      logEvent('agent', 'agent_stream_first_content', { kind, length: String(text || '').length }, '创作工作台收到首个内容分片');
    }
    // Streaming chunks skip normalization to avoid O(n^2) regex scans; the
    // final write normalizes once.
    const normalized = skipNormalize ? String(text || '') : normalizeVisibleNewlines(text);
    if (kind === 'draft') agentDraftText = normalized;
    else if (kind === 'review') agentReviewText = normalized;
    else agentResultText = normalized;
    setAgentTargetText(target, normalized);
    renderAgentPage();
    renderAgentDetail();
  };
  return {
    onThink(text) {
      if (kind !== 'draft' || !isAgentRequestCurrent(conversationId)) return;
      agentThinkText = normalizeVisibleNewlines(text || '');
      if (thinkTarget) {
        thinkTarget.hidden = !agentThinkText;
        thinkTarget.textContent = agentThinkText;
      }
    },
    onContent: text => updateTarget(text, true),
    onDone(think, text) {
      logEvent('agent', 'agent_stream_done', { kind, thinkLength: String(think || '').length, contentLength: String(text || '').length, current: isAgentRequestCurrent(conversationId) }, '创作工作台流式完成');
      if (!isAgentRequestCurrent(conversationId)) return;
      if (kind === 'draft') agentThinkText = normalizeVisibleNewlines(think || agentThinkText || '');
      updateTarget(text, false);
    },
    onError(message) {
      logEvent('agent', 'agent_stream_error', { kind, message: String(message || '').slice(0, 500), current: isAgentRequestCurrent(conversationId) }, `创作工作台流式错误：${message}`);
      if (!isAgentRequestCurrent(conversationId)) return;
      setAgentActionStatus(`操作失败：${message}`, true);
      renderAgentDetail();
    },
    onAbort() {
      logEvent('agent', 'agent_stream_aborted', { kind, current: isAgentRequestCurrent(conversationId) }, '创作工作台流式中止');
      if (!isAgentRequestCurrent(conversationId)) return;
      setAgentActionStatus('操作已停止；未完成内容不会写入正文或作品记忆。');
      renderAgentDetail();
    },
  };
}

function agentActionButtonId(action) {
  return action === 'generate' ? 'agentDetailGenerateBtn'
    : action === 'extract' ? 'agentDetailExtractBtn'
      : action === 'initial-memory' ? 'agentDetailDiscoverMemoryBtn'
        : 'agentDetailPreflightBtn';
}

async function runAgentAction(action) {
  if (agentAbortCtrl) {
    setAgentActionStatus('已有创作任务正在运行。可以等待完成，或点击“停止当前任务”。', true);
    return;
  }
  const mode = getWritingAgentState().mode;

  const draft = getAgentDraftValue();
  if ((action === 'preflight' || action === 'extract') && !draft) {
    setAgentActionStatus(action === 'preflight' ? '请先生成或填写续写草稿，再检查草稿。' : '请先生成或填写续写草稿，再整理记忆候选。', true);
    return;
  }
  const target = action === 'generate'
    ? document.getElementById('agentDetailDraft')
    : action === 'preflight'
      ? document.getElementById('agentDetailPreflightResult')
      : document.getElementById('agentDetailResult');
  if (!target) return;

  const conversationId = getActiveConvId();
  const ac = new AbortController();
  agentAbortCtrl = ac;
  agentRequestContext = { action, conversationId };
  const startedAt = Date.now();
  const kind = action === 'generate' ? 'draft' : action === 'preflight' ? 'review' : 'candidates';
  const buttonId = agentActionButtonId(action);
  animateAgentButton(buttonId, 'clicked');

  if (action === 'generate') {
    agentDraftText = '';
    agentThinkText = '';
    agentReviewText = '';
    agentExtraction = null;
    agentResultText = '';
    agentCandidatesDraftUpdatedAt = 0;
    agentDraftUpdatedAt = 0;
    agentDraftTask = (document.getElementById('agentDetailInput')?.value || '').trim();
  } else if (action === 'preflight') {
    agentReviewText = '';
  } else {
    agentResultText = '';
    agentExtraction = null;
  }

  const pendingText = action === 'generate' ? '正在生成续写草稿…'
    : action === 'preflight' ? '正在检查当前草稿…'
      : action === 'initial-memory' ? '正在扫描现有正文并整理记忆候选…'
        : '正在从当前草稿整理记忆候选…';
  setAgentTargetText(target, pendingText);
  setAgentActionStatus(pendingText);
  renderAgentDetail();
  logEvent('agent', 'agent_action_started', { action, mode, model: getSelectedModel(), conversationId }, `创作工作台开始执行：${action}`);

  let requestResult = null;
  let candidateSource = 'draft';
  try {
    const callbacks = agentCallbacks(target, kind, conversationId);
    if (action === 'generate') {
      requestResult = await generateAgentText(getSelectedModel(), ac, callbacks, getChatParams(), agentDraftTask);
    } else if (action === 'preflight') {
      requestResult = await reviewAgentDraft(getSelectedModel(), ac, callbacks, getChatParams(), draft, document.getElementById('agentDetailInput')?.value || agentDraftTask);
    } else if (action === 'initial-memory') {
      candidateSource = 'existing-story';
      requestResult = await extractInitialMemory(getSelectedModel(), ac, callbacks, getChatParams());
    } else {
      requestResult = await extractMemory(getSelectedModel(), ac, callbacks, getChatParams(), draft);
    }

    if (!isAgentRequestCurrent(conversationId)) {
      setAgentActionStatus('会话已切换或校验未通过，本次生成结果未写入；请回到原会话重新操作。', true);
      return;
    }
    if (requestResult?.status !== 'success') {
      if (requestResult?.status === 'aborted') setAgentActionStatus('操作已停止；结果没有写入正文或作品记忆。');
      else setAgentActionStatus(`操作未完成：${requestResult?.error || '请检查模型配置后重试'}`, true);
      animateAgentButton(buttonId, requestResult?.status === 'aborted' ? 'clicked' : 'error');
      return;
    }

    if (action === 'generate') {
      agentDraftText = normalizeVisibleNewlines(requestResult.contentText || '');
      agentThinkText = normalizeVisibleNewlines(requestResult.thinkText || '');
      agentDraftUpdatedAt = Date.now();
      const taskInput = document.getElementById('agentDetailInput');
      if (taskInput) taskInput.value = agentDraftTask;
      if (!requestResult.contentText?.trim() && requestResult.thinkText?.trim()) {
        setAgentActionStatus('模型只输出了思考内容，正文为空；请尝试更换模型或降低思考强度后重新生成。', true);
      } else if (!requestResult.contentText?.trim()) {
        setAgentActionStatus('模型返回的正文为空；请检查模型配置后重新生成。', true);
      } else {
        setAgentActionStatus('续写草稿已生成。你可以编辑、检查，或确认加入正文；系统不会自动运行记忆任务。');
      }
    } else if (action === 'preflight') {
      agentReviewText = normalizeVisibleNewlines(requestResult.contentText || '');
      updateWritingAgentState({ lastPreflight: agentReviewText });
      setAgentActionStatus('草稿检查已完成；结论仅供参考，不会自动改写草稿或记忆。');
    } else {
      agentResultText = normalizeVisibleNewlines(requestResult.contentText || '');
      agentExtraction = parseExtractionResult(agentResultText);
      agentCandidatesDraftUpdatedAt = action === 'extract' ? agentDraftUpdatedAt : 0;
      const count = agentExtraction ? extractionCategories().reduce((total, { key }) => total + (agentExtraction[key] || []).length, 0) : 0;
      if (!agentExtraction) {
        setAgentActionStatus('模型没有返回可识别的结构化候选；正文和作品记忆均未修改。', true);
      } else {
        setAgentActionStatus(count ? `已整理出 ${count} 条待确认记忆；勾选后才会写入。` : '未发现需要长期保存的新信息。');
      }
    }

    persistAgentWorkspace({ candidateSource });
    animateAgentButton(buttonId, 'success');
    logEvent('agent', 'agent_action_finished', {
      action, mode, model: getSelectedModel(), conversationId,
      durationMs: Date.now() - startedAt,
      draftLength: agentDraftText.length,
      reviewLength: agentReviewText.length,
    }, `创作工作台执行完成：${action}`);
  } finally {
    if (agentRequestContext?.conversationId === conversationId) {
      agentAbortCtrl = null;
      agentRequestContext = null;
    }
    renderAgentPage();
    renderAgentDetail();
  }
}

function applyAgentDraft() {
  if (agentAbortCtrl) {
    setAgentActionStatus('请先等待当前创作任务完成，或停止任务。', true);
    return;
  }
  const draftEl = document.getElementById('agentDetailDraft');
  const text = (draftEl?.value || agentDraftText).trim();
  if (!text || text.startsWith('错误：')) {
    setAgentActionStatus('当前没有可加入正文的有效草稿。', true);
    setStatus(false, '当前没有可加入正文的有效草稿');
    return;
  }
  const conv = getActiveConv();
  if (!conv) return;

  const task = agentDraftTask.trim() || (document.getElementById('agentDetailInput')?.value || '').trim() || '请自然承接当前正文继续创作。';
  addUserMessage(task);
  const activeConv = getActiveConv();
  activeConv.messages.push({ role: 'ai', content: text, reasoning: agentThinkText || null, agentDraft: true });
  persistConversations();
  const appliedDraft = text;
  agentDraftText = '';
  agentThinkText = '';
  agentReviewText = '';
  agentDraftTask = '';
  agentDraftUpdatedAt = 0;
  agentExtraction = null;
  agentResultText = '';
  agentCandidatesDraftUpdatedAt = 0;
  updateWritingAgentState({ lastDraft: appliedDraft, lastPreflight: '' });
  persistAgentWorkspace();
  if (draftEl) draftEl.value = '';
  const think = document.getElementById('agentDetailThink');
  if (think) { think.textContent = ''; think.hidden = true; }
  renderChatMessages();
  renderConvList();
  renderAgentPage();
  renderAgentDetail();
  animateAgentButton('agentDetailApplyDraftBtn', 'success');
  setAgentActionStatus('续写草稿已加入正文；临时草稿、检查和候选已清空。');
  setStatus(true, '续写草稿已加入正文');
}

function applyAgentResult() {
  if (agentExtraction) {
    const selected = {};
    document.querySelectorAll('[data-agent-suggestion]').forEach(input => {
      selected[input.dataset.agentSuggestion] = input.checked;
    });
    const memory = getWritingAgentState().memory;
    const selectedItems = {};
    for (const { key } of extractionCategories()) {
      selectedItems[key] = [];
      document.querySelectorAll(`[data-agent-suggestion^="${key}:"]`).forEach(input => {
        if (!input.checked) return;
        const text = input.closest('.agent-item')?.querySelector('.agent-item-text')?.textContent?.trim();
        if (text) selectedItems[key].push(text);
      });
    }
    const editedExtraction = selectedItems;
    const nextMemory = mergeExtractionIntoMemory(memory, editedExtraction);
    addSuggestions({ type: 'memory-update', extraction: editedExtraction, status: 'accepted' });
    replaceMemory(nextMemory);
    const count = Object.values(selectedItems).reduce((total, items) => total + items.length, 0);
    agentExtraction = null;
    agentResultText = '';
    agentCandidatesDraftUpdatedAt = 0;
    persistAgentWorkspace();
    setAgentActionStatus(`已将 ${count} 条已勾选内容写入作品记忆，候选已清空。`);
    renderAgentPage();
    renderAgentDetail();
    setStatus(true, `已将 ${count} 条创作记忆写入作品记忆`);
    return;
  }
  setAgentActionStatus('当前没有可写入的记忆候选，请先从草稿、现有正文或新增设定整理。', true);
  setStatus(false, '当前没有可写入的记忆候选');
}

async function handleSendOrStop() {
  if (isDiscussionStreaming || agentAbortCtrl) {
    setStatus(false, agentAbortCtrl ? '请等待创作工作台任务结束后再继续正文' : '请等待讨论结束后再继续正文');
    return;
  }
  // STOP: abort immediately
  if (isStreaming && abortCtrl) {
    abortCtrl.abort();
    return;
  }

  const text = getInputText();
  if (!text) return;

  // Add user message — versions of previous AI messages stay in storage
  addUserMessage(text);
  logEvent('operation', 'message_sent', { channel: 'main', length: text.length }, '发送正文消息');
  clearInput();
  renderChatMessages();
  scrollToBottom({ force: true });   // 自己刚发出的消息，强制滚到底
  renderConvList();

  await new Promise(r => requestAnimationFrame(r));
  const { thinkEl, thinkBlock, contentEl, group } = appendAiPlaceholder();

  // Create abort controller BEFORE the async call
  const ac = new AbortController();
  abortCtrl = ac;
  isStreaming = true;
  setSendButtonStop();
  setStatus(true, '生成中...');

  // Main chat reads only the creative materials explicitly enabled for it.
  // Long-term rules and style templates remain exclusive to the creative workbench.
  await sendMessage(getSelectedModel(), ac, {
    onThink(thinkText) {
      showThinkBlock(thinkBlock);
      updateThinkText(thinkEl, thinkText);
    },
    onContent(fullText) {
      updateStreamText(contentEl, fullText);
    },
    onDone(thinkText, fullText) {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '就绪');
      finishStream();
    },
    onError(msg) {
      contentEl.textContent = '错误: ' + msg;
      contentEl.classList.remove('streaming');
      setStatus(false, '错误');
      finishStream();
    },
    onAbort() {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '已停止');
      finishStream();
    },
  }, getChatParams(), withMainCreationContext({ conversationId: getActiveConvId(), requestKind: 'send', logLabel: '正文发送请求' }));
}

// ---- Current conversation discussion ----

function discussionMarkdown(text) {
  if (!text) return '';
  try {
    const el = document.createElement('div');
    el.textContent = text;
    return marked.parse(el.innerHTML);
  } catch {
    const el = document.createElement('div');
    el.textContent = text;
    return el.innerHTML;
  }
}

function currentDiscussionStream() {
  return discussionStream?.conversationId === getActiveConvId() ? discussionStream : null;
}

/** 讨论页的思考块：结构与正文的 .think-block 一致，点击标题即可折叠 */
function discussionThinkMarkup(label, text) {
  return `<div class="discussion-think">
    <div class="discussion-think-head" role="button" tabindex="0" aria-label="折叠或展开思考过程" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="discussion-think-toggle">&#9660;</span> ${escapeHtml2(label)}
    </div>
    <div class="discussion-think-body">${escapeHtml2(text)}</div>
  </div>`;
}

function discussionStreamContent(stream) {
  if (!stream) return '';
  if (stream.phase === 'error') {
    return `<div class="discussion-stream-error">错误：${escapeHtml2(stream.error || '讨论请求失败')}</div>`;
  }
  const thinking = stream.thinkText
    ? discussionThinkMarkup(stream.contentText ? '思考过程' : '思考中', stream.thinkText)
    : '';
  const content = stream.contentText ? discussionMarkdown(stream.contentText) : '';
  return thinking + content + (!thinking && !content ? '<div class="discussion-stream-waiting">正在等待回复…</div>' : '');
}

function discussionStreamMarkup(stream, index = null) {
  const indexAttr = Number.isInteger(index) ? ` data-discussion-index="${index}"` : '';
  const phaseClass = stream.phase === 'error' ? ' error' : ' streaming';
  return `<div class="discussion-msg-wrap discussion-stream-wrap" data-discussion-stream-id="${stream.id}"${indexAttr}><div class="discussion-msg ai markdown-body${phaseClass}">${discussionStreamContent(stream)}</div></div>`;
}

function renderDiscussionMessages(listId = 'discussionList') {
  const list = document.getElementById(listId);
  if (!list) return;
  const prevScrollTop = list.scrollTop;
  const follower = discussionFollower(listId);
  const wasPinnedBeforeRender = follower ? follower.isPinned() : true;
  const messages = getDiscussionMessages();
  const stream = currentDiscussionStream();
  const replacesMessage = stream?.mode === 'replace' && Number.isInteger(stream.targetIndex);
  const renderedMessages = messages.map((m, index) => {
    if (replacesMessage && index === stream.targetIndex) return discussionStreamMarkup(stream, index);
    const content = m.role === 'ai' ? discussionMarkdown(m.content) : (() => {
      const el = document.createElement('div');
      el.textContent = m.content;
      return el.innerHTML;
    })();
    const thinking = m.reasoning ? discussionThinkMarkup('思考过程', m.reasoning) : '';
    const actions = listId === 'discussionDetailList' ? `<div class="discussion-action-row">
      ${m.role === 'user' ? `<button class="action-btn" data-discussion-action="edit" data-discussion-index="${index}" title="编辑">${EDIT_ICON}</button>` : `<button class="action-btn" data-discussion-action="copy" data-discussion-index="${index}" title="复制">${COPY_ICON}</button><button class="action-btn" data-discussion-action="regenerate" data-discussion-index="${index}" title="重新生成">${REGENERATE_ICON}</button>`}
    </div>` : '';
    return `<div class="discussion-msg-wrap" data-discussion-index="${index}"><div class="discussion-msg ${m.role === 'ai' ? 'ai markdown-body' : 'user'}">${thinking}${content}</div>${actions}</div>`;
  });
  if (stream && !replacesMessage) renderedMessages.push(discussionStreamMarkup(stream));
  list.innerHTML = renderedMessages.length
    ? renderedMessages.join('')
    : '<div class="discussion-empty">围绕这段故事，和 AI 聊聊你的想法。</div>';
  // 重绘会重置滚动位置：贴底时继续贴底，否则尽量停在原处（不要跳回顶部）
  if (list) {
    if (wasPinnedBeforeRender) list.scrollTop = list.scrollHeight;
    else list.scrollTop = prevScrollTop;
    follower.setPinned(follower.isAtBottom());
  }
}

/* ---- 讨论列表的滚动跟随：与正文共用 ui-renderer 的 createScrollFollower ---- */
const DISCUSSION_PIN_THRESHOLD = 40;
const discussionFollowers = new Map();

function discussionFollower(listId) {
  if (!discussionFollowers.has(listId)) {
    const list = document.getElementById(listId);
    discussionFollowers.set(listId, list ? createScrollFollower(list, { threshold: DISCUSSION_PIN_THRESHOLD }) : null);
  }
  return discussionFollowers.get(listId);
}

function scrollDiscussionToBottom(options = {}) {
  scrollDiscussionListToBottom('discussionList', options);
}

function renderDiscussionViews() {
  renderDiscussionMessages('discussionList');
  renderDiscussionMessages('discussionDetailList');
}

function scrollDiscussionListToBottom(listId, options = {}) {
  discussionFollower(listId)?.scrollToBottom(options);
}

function beginDiscussionStream(mode = 'append', targetIndex = null) {
  const stream = {
    id: `discussion-${Date.now()}-${++discussionStreamSequence}`,
    conversationId: getActiveConvId(),
    mode,
    targetIndex: Number.isInteger(targetIndex) ? targetIndex : null,
    thinkText: '',
    contentText: '',
    phase: 'streaming',
    error: '',
  };
  discussionStream = stream;
  isDiscussionStreaming = true;
  renderDiscussionViews();
  return stream;
}

function updateDiscussionStream(requestId, patch) {
  if (!discussionStream || discussionStream.id !== requestId) return false;
  Object.assign(discussionStream, patch);
  document.querySelectorAll(`[data-discussion-stream-id="${requestId}"] .discussion-msg`).forEach(element => {
    element.classList.toggle('streaming', discussionStream.phase === 'streaming');
    element.classList.toggle('error', discussionStream.phase === 'error');
    element.innerHTML = discussionStreamContent(discussionStream);
  });
  scrollDiscussionListToBottom('discussionList');
  scrollDiscussionListToBottom('discussionDetailList');
  return true;
}

function isDiscussionRequestCurrent(requestId) {
  return Boolean(discussionStream && discussionStream.id === requestId);
}

function startDiscussionEdit(index) {
  if (isStreaming || isDiscussionStreaming) return;
  const messages = getDiscussionMessages();
  const message = messages[index];
  const wrap = document.querySelector(`#discussionDetailList .discussion-msg-wrap[data-discussion-index="${index}"]`);
  if (!message || message.role !== 'user' || !wrap) return;
  const msg = wrap.querySelector('.discussion-msg');
  if (!msg) return;
  wrap.classList.add('editing');
  msg.innerHTML = `<textarea class="edit-textarea discussion-edit-textarea">${escapeHtml2(message.content)}</textarea><div class="edit-actions"><button class="btn btn-sm" data-discussion-action="save-edit" data-discussion-index="${index}">保存</button><button class="btn btn-ghost btn-sm" data-discussion-action="cancel-edit" data-discussion-index="${index}">取消</button></div>`;
  const textarea = msg.querySelector('textarea');
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function regenerateDiscussionFromUser() {
  if (isStreaming || isDiscussionStreaming) return;
  const stream = beginDiscussionStream('append');
  const requestId = stream.id;
  const ac = new AbortController();
  discussionAbortCtrl = ac;
  setDiscussionButtonStop();
  setStatus(true, '讨论重新生成中...');
  await sendDiscussionMessage(getSelectedModel(), ac, {
    onThink(thinkText) {
      updateDiscussionStream(requestId, { thinkText });
    },
    onContent(fullText) {
      updateDiscussionStream(requestId, { contentText: fullText });
    },
    onDone() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '就绪');
    },
    onError(msg) {
      if (!updateDiscussionStream(requestId, { phase: 'error', error: msg })) return;
      finishDiscussionStream(requestId, { keepState: true });
      setStatus(false, '讨论重新生成失败');
    },
    onAbort() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '已停止讨论');
    },
  }, getChatParams(), { conversationId: stream.conversationId });
}

async function regenerateDiscussion(index) {
  if (isStreaming || isDiscussionStreaming) return;
  const messages = getDiscussionMessages();
  if (messages[index]?.role !== 'ai') return;
  const stream = beginDiscussionStream('replace', index);
  const requestId = stream.id;
  const ac = new AbortController();
  discussionAbortCtrl = ac;
  setDiscussionButtonStop();
  setStatus(true, '讨论重新生成中...');
  await sendDiscussionMessage(getSelectedModel(), ac, {
    onThink(thinkText) {
      updateDiscussionStream(requestId, { thinkText });
    },
    onContent(fullText) {
      updateDiscussionStream(requestId, { contentText: fullText });
    },
    onDone() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '就绪');
    },
    onError(msg) {
      if (!updateDiscussionStream(requestId, { phase: 'error', error: msg })) return;
      finishDiscussionStream(requestId, { keepState: true });
      setStatus(false, '讨论重新生成失败');
    },
    onAbort() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '已停止讨论');
    },
  }, getChatParams(), { regenerateIndex: index, conversationId: stream.conversationId });
}

function setDiscussionButtonStop() {
  ['discussionSendBtn', 'discussionDetailSendBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.textContent = '停止'; btn.classList.add('stop'); }
  });
}

function setDiscussionButtonNormal() {
  const buttons = [document.getElementById('discussionSendBtn'), document.getElementById('discussionDetailSendBtn')];
  buttons.forEach(btn => {
    if (btn) { btn.textContent = btn.id === 'discussionDetailSendBtn' ? '发送讨论' : '讨论'; btn.classList.remove('stop'); }
  });
}

function finishDiscussionStream(requestId = discussionStream?.id, options = {}) {
  if (requestId && discussionStream?.id !== requestId) return false;
  isDiscussionStreaming = false;
  discussionAbortCtrl = null;
  if (!options.keepState) discussionStream = null;
  setDiscussionButtonNormal();
  return true;
}

async function handleDiscussionSendOrStop(inputId = 'discussionInput') {
  if (isDiscussionStreaming && discussionAbortCtrl) {
    discussionAbortCtrl.abort();
    return;
  }
  if (isStreaming || agentAbortCtrl) {
    setStatus(false, agentAbortCtrl ? '请等待创作工作台任务结束后再讨论' : '请等待正文生成结束后再讨论');
    return;
  }
  const input = document.getElementById(inputId);
  const text = input?.value.trim();
  if (!input || !text) return;

  const conversationId = getActiveConvId();
  addDiscussionMessage('user', text, null, conversationId);
  logEvent('operation', 'message_sent', { channel: 'discussion', length: text.length }, '发送当前对话讨论消息');
  input.value = '';
  const stream = beginDiscussionStream('append');
  scrollDiscussionToBottom({ force: true });   // 自己刚发的消息，强制看到
  const requestId = stream.id;

  const ac = new AbortController();
  discussionAbortCtrl = ac;
  setDiscussionButtonStop();
  setStatus(true, '讨论中...');

  await sendDiscussionMessage(getSelectedModel(), ac, {
    onThink(thinkText) {
      updateDiscussionStream(requestId, { thinkText });
    },
    onContent(fullText) {
      updateDiscussionStream(requestId, { contentText: fullText });
    },
    onDone() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '就绪');
    },
    onError(msg) {
      if (!updateDiscussionStream(requestId, { phase: 'error', error: msg })) return;
      finishDiscussionStream(requestId, { keepState: true });
      setStatus(false, '讨论失败');
    },
    onAbort() {
      if (!isDiscussionRequestCurrent(requestId)) return;
      finishDiscussionStream(requestId);
      renderDiscussionViews();
      setStatus(true, '已停止讨论');
    },
  }, getChatParams(), { conversationId });
}

// ---- Regenerate ----

async function handleRegenerate() {
  if (isStreaming || isDiscussionStreaming) return;
  logEvent('operation', 'regenerate', {}, '重新生成正文回复');
  // Do not send the response being regenerated back as context.
  // Previous AI versions are kept for viewing, but the API must only see
  // the conversation path before the latest response.
  const requestMessages = getActiveMessages().map(m => ({ ...m }));
  while (requestMessages.length && requestMessages[requestMessages.length - 1].role === 'ai') {
    requestMessages.pop();
  }
  // Keep the request alive even if the conversation has no earlier user turn;
  // sendMessage will still handle validation and report any real API error.
  // Don't remove old AI message — it becomes a version
  await new Promise(r => requestAnimationFrame(r));
  const { thinkEl, thinkBlock, contentEl, group } = appendAiPlaceholder();
  const ac = new AbortController();
  abortCtrl = ac;
  isStreaming = true;
  setSendButtonStop();
  setStatus(true, '重新生成中...');
  await sendMessage(getSelectedModel(), ac, {
    onThink(thinkText) { showThinkBlock(thinkBlock); updateThinkText(thinkEl, thinkText); },
    onContent(fullText) { updateStreamText(contentEl, fullText); },
    onDone(thinkText, fullText) {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '就绪');
      finishStream();
    },
    onError(msg) {
      contentEl.textContent = '错误: ' + msg;
      contentEl.classList.remove('streaming');
      setStatus(false, '错误');
      finishStream();
    },
    onAbort() {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '已停止');
      finishStream();
    },
  }, getChatParams(), withMainCreationContext({ requestMessages, requestKind: 'regenerate', logLabel: '正文重新生成请求' }));
}

// ---- Manual AI message editing ----

let aiMessageEditContext = null;

function openAiMessageEditDialog(rawIdx) {
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) return;
  const conversationId = getActiveConvId();
  const message = getActiveConv()?.messages?.[rawIdx];
  const input = document.getElementById('aiMessageEditInput');
  if (!message || message.role !== 'ai' || !input) return;
  aiMessageEditContext = { conversationId, rawIdx };
  input.value = normalizeVisibleNewlines(message.content || '');
  showModal('aiMessageEditModal');
  window.requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function closeAiMessageEditDialog() {
  aiMessageEditContext = null;
  hideModal('aiMessageEditModal');
}

async function saveAiMessageEdit() {
  if (!aiMessageEditContext || isStreaming || isDiscussionStreaming || agentAbortCtrl) return;
  const input = document.getElementById('aiMessageEditInput');
  const content = normalizeVisibleNewlines(input?.value || '').trim();
  if (!content) {
    await appDialog.alert('正文不能为空。若确实不需要这段内容，请使用数据中心处理。', { title: '无法保存正文' });
    input?.focus();
    return;
  }
  const { conversationId, rawIdx } = aiMessageEditContext;
  if (getActiveConvId() !== conversationId) {
    closeAiMessageEditDialog();
    await appDialog.alert('当前对话已经切换，本次修改未保存。', { title: '对话已切换' });
    return;
  }
  const message = getActiveConv()?.messages?.[rawIdx];
  if (!message || message.role !== 'ai') {
    closeAiMessageEditDialog();
    await appDialog.alert('目标正文已不存在或位置已经变化，本次修改未保存。', { title: '无法保存正文' });
    return;
  }
  const wasIncomplete = message.incomplete === true;
  if (!updateAiMessage(rawIdx, content, { markComplete: true })) return;
  closeAiMessageEditDialog();
  renderChatMessages();
  logEvent('operation', 'ai_message_manually_edited', {
    conversationId,
    messageIndex: rawIdx,
    contentLength: content.length,
    completedInterruptedMessage: wasIncomplete,
  }, '手动修改主页 AI 正文');
  setStatus(true, wasIncomplete ? '正文已保存，并标记为完整' : '正文已保存');
}

// ---- AI revision ----

let revisionContext = null;

function openRevisionDialog(rawIdx) {
  if (isStreaming || isDiscussionStreaming) return;
  const conv = getActiveConv();
  const msg = conv?.messages?.[rawIdx];
  if (!msg || msg.role !== 'ai') return;
  revisionContext = { rawIdx, original: msg.content };
  const modal = document.getElementById('revisionModal');
  const original = document.getElementById('revisionOriginal');
  const input = document.getElementById('revisionInput');
  if (!modal || !original || !input) return;
  original.textContent = msg.content;
  input.value = '';
  showModal('revisionModal');
  window.requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

function closeRevisionDialog() {
  revisionContext = null;
  hideModal('revisionModal');
}

async function submitRevision() {
  if (!revisionContext || isStreaming || isDiscussionStreaming) return;
  const request = document.getElementById('revisionInput')?.value.trim();
  if (!request) return;
  const { rawIdx, original } = revisionContext;
  // The original text is included explicitly in the revision instruction;
  // do not also send the target assistant message in the conversation history.
  const source = getVisibleMessagesThrough(rawIdx - 1).map(m => ({ ...m }));
  closeRevisionDialog();
  await new Promise(r => requestAnimationFrame(r));
  const { thinkEl, thinkBlock, contentEl, group } = appendAiPlaceholder();
  const ac = new AbortController();
  abortCtrl = ac;
  isStreaming = true;
  setSendButtonStop();
  setStatus(true, '修订中...');
  const instruction = `请修订下面这段小说内容。只按“修改要求”处理，尽量保留原文的剧情、人物关系、叙事视角、语气、节奏和其他未被要求修改的内容。直接输出修订后的完整文本，不要解释修改过程。\n\n原文：\n---\n${original}\n---\n\n修改要求：\n${request}`;
  await sendMessage(getSelectedModel(), ac, {
    onThink(thinkText) { showThinkBlock(thinkBlock); updateThinkText(thinkEl, thinkText); },
    onContent(fullText) { updateStreamText(contentEl, fullText); },
    onDone(thinkText, fullText) {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '就绪');
      finishStream();
    },
    onError(msg) {
      contentEl.textContent = '错误: ' + msg;
      contentEl.classList.remove('streaming');
      setStatus(false, '修订失败');
      finishStream();
    },
    onAbort() {
      finalizeStreamGroup(group, contentEl);
      renderChatMessages();
      setStatus(true, '已停止');
      finishStream();
    },
  }, getChatParams(), withMainCreationContext({ requestMessages: source, instruction, reviseIndex: rawIdx, requestKind: 'revise', logLabel: '正文修订请求' }));
}

// ---- Edit message ----

function escapeHtml2(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function startEditMode(btn) {
  const rawIdx = parseInt(btn.dataset.rawIdx, 10);
  const renderIdx = parseInt(btn.dataset.renderIdx, 10);
  const msgEl = document.getElementById('msg-' + renderIdx); // this IS the .msg.user div
  if (!msgEl) return;
  const origText = getActiveConv().messages[rawIdx].content;
  msgEl.parentElement._editOrig = origText; // store on parent for cancel

  msgEl.innerHTML = `<textarea class="edit-textarea">${escapeHtml2(origText)}</textarea>
    <div class="edit-actions">
      <button class="btn btn-sm" onclick="window.__saveEdit(${rawIdx}, ${renderIdx})">保存并重新生成</button>
      <button class="btn btn-ghost btn-sm" onclick="window.__cancelEdit(${renderIdx})">取消</button>
    </div>`;
  const ta = msgEl.querySelector('.edit-textarea');
  ta.focus({ preventScroll: true });
  // 编辑框按内容自适应高度：CSS 里的 min-height（桌面 220px / 移动端 180px）是给
  // 长正文留的余量，套在一条短消息上就会在文字下方空出一大片，把「保存并重新生成」
  // 推到很远的地方。这里先把 min-height 清掉再量内容高度，然后把 min-height 设回
  // 「内容高度」（封顶 120px）—— 既贴合内容，拖拽手柄的下限也还是合理的。
  ta.style.minHeight = '0px';
  ta.style.height = 'auto';
  const naturalHeight = Math.max(52, ta.scrollHeight + 2);
  ta.style.height = Math.min(naturalHeight, 200) + 'px';
  ta.style.minHeight = Math.min(naturalHeight, 120) + 'px';

  // 消息原地变成编辑框后高度会变，浏览器不会自己把视野带过去 —— 用户看到的是
  // 「消息已经变成输入框跑到上面去了，还得自己往上滚才找得到」。这里把它拉回视口，
  // 并在键盘弹起（视口变矮）后再校正几次（键盘出现时机各 ROM 差别很大）。
  revealMessageInChat(msgEl);
}

/**
 * 把某条消息滚进聊天区可视范围（靠上对齐），并临时解除「跟随底部」，
 * 免得编辑期间的重绘又把视野拽回列表底部。
 */
function revealMessageInChat(msgEl) {
  const scroller = document.getElementById('chatScroll');
  if (!scroller || !msgEl) return;
  setChatPinned(false);
  const place = () => {
    if (!msgEl.isConnected) return;
    const sRect = scroller.getBoundingClientRect();
    const mRect = msgEl.getBoundingClientRect();
    // 已经完整可见就别动它，避免桌面上点一下编辑也跟着跳一下
    if (mRect.top >= sRect.top + 8 && mRect.bottom <= sRect.bottom - 8) return;
    const delta = mRect.top - sRect.top - 12;
    if (Math.abs(delta) > 2) scroller.scrollTop += delta;
  };
  window.requestAnimationFrame(place);
  [160, 420, 760, 1200].forEach(delay => window.setTimeout(place, delay));
}

// These are exposed on window for inline onclick handlers
window.__saveEdit = function(rawIdx, renderIdx) {
  const msgEl = document.getElementById('msg-' + renderIdx);
  if (!msgEl) return;
  const ta = msgEl.querySelector('.edit-textarea');
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;

  updateMessage(rawIdx, newText);
  truncateAfter(rawIdx + 1);
  renderChatMessages();
  renderConvList();
  setTimeout(() => { handleRegenerate(); }, 100);
};

window.__cancelEdit = function(renderIdx) {
  const msgEl = document.getElementById('msg-' + renderIdx);
  if (!msgEl) return;
  const orig = msgEl.parentElement._editOrig || '';
  msgEl.textContent = orig;
};

// ---- Conversation switching (blocked during stream) ----

async function handleFork(rawMessageIndex) {
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) return;
  const source = getActiveConv();
  if (!source) return;

  const defaultTitle = `分支：${source.title || '新对话'}`;
  const title = await appDialog.prompt('从当前消息创建一个独立故事分支。', defaultTitle, { title: '创建对话分支', inputLabel: '分支名称', confirmText: '创建' });
  if (title === null) return;

  const branch = forkConversation(rawMessageIndex, title);
  if (!branch) {
    setStatus(false, '无法从该消息创建分支');
    return;
  }
  logEvent('operation', 'conversation_forked', {
    sourceConversationId: source.id,
    sourceMessageIndex: rawMessageIndex,
    branchConversationId: branch.id,
  }, '创建故事分支');
  renderConvList();
  renderChatMessages();
  renderDiscussionViews();
  setStatus(true, '已创建分支');
}

async function renameConversation(id) {
  if (isStreaming || isDiscussionStreaming) return;
  const conv = getConversations().find(item => item.id === id);
  if (!conv) return;
  const title = await appDialog.prompt('输入一个便于识别的对话名称。', conv.title || '新对话', { title: '重命名对话', inputLabel: '对话名称', confirmText: '保存' });
  if (title === null) return;
  const nextTitle = title.trim();
  if (!nextTitle) {
    setStatus(false, '对话名称不能为空');
    return;
  }
  const previousTitle = conv.title || '新对话';
  conv.title = nextTitle.slice(0, 100);
  persistConversations();
  logEvent('operation', 'conversation_renamed', { conversationId: id, previousTitle, title: conv.title }, '修改对话名称');
  renderConvList();
  renderChatMessages();
  setStatus(true, '对话名称已修改');
}

function safeSwitchConv(id) {
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) {
    setStatus(false, '生成、讨论或创作任务进行中，暂时不能切换会话');
    return;
  }
  persistAgentWorkspace();
  activateConv(id);
  loadAgentWorkspace();
  logEvent('operation', 'conversation_switched', { conversationId: id }, '切换对话');
  renderConvList();
  renderChatMessages();
  renderDiscussionViews();
  renderAgentPage();
  renderAgentDetail();
}

function safeNewChat() {
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) {
    setStatus(false, '生成、讨论或创作任务进行中，暂时不能新建会话');
    return;
  }
  persistAgentWorkspace();
  createConversation();
  loadAgentWorkspace();
  logEvent('operation', 'conversation_created', {}, '创建新对话');
  renderConvList();
  renderChatMessages();
  renderDiscussionViews();
  renderAgentPage();
  renderAgentDetail();
}

// ---- Config select change ----

function onConfigChange() {
  const sel = document.getElementById('configSelect');
  activateConfig(sel.value);
  renderModelSelect();
  updateGeminiSettingsVisibility();
  window.requestAnimationFrame(() => updateGeminiSettingsVisibility());
  setStatus(true, '就绪');
}

// ---- Export / Import ----

function downloadExport(content, filename, mimeType) {
  const bridge = window.AndroidExport;
  if (bridge && typeof bridge.begin === 'function') {
    try {
      const bytes = new TextEncoder().encode(content);
      bridge.begin(filename, mimeType);
      for (let offset = 0; offset < bytes.length; offset += 24576) {
        const chunk = bytes.subarray(offset, Math.min(offset + 24576, bytes.length));
        let binary = '';
        for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
        bridge.append(btoa(binary));
      }
      bridge.complete();
      return true;
    } catch (error) {
      console.error('Android export failed:', error);
      try { bridge.cancel(); } catch {}
      return false;
    }
  }
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

function isDataMutationBlocked(action = '修改数据') {
  if (!isStreaming && !isDiscussionStreaming && !agentAbortCtrl) return false;
  setStatus(false, `生成、讨论或创作任务进行中，暂时不能${action}`);
  return true;
}

async function exportData() {
  try {
    await flushConversationWrites();
    const logData = await exportLogsData();
    const snapshots = await getStoredSnapshots();
    const data = {
      version: 3,
      storage: 'indexeddb',
      exportedAt: new Date().toISOString(),
      configs: JSON.parse(localStorage.getItem(KEYS.CONFIGS) || '[]'),
      conversations: structuredClone(getConversations()),
      activeConfig: localStorage.getItem(KEYS.ACTIVE_CONFIG) || '',
      activeConv: getActiveConvId(),
      params: JSON.parse(localStorage.getItem('ai_chat_params') || '{}'),
      theme: localStorage.getItem(THEME_KEY) || '',
      readingSettings: load(READING_KEY, null),
      logSettings: getLogSettings(),
      syncSettings: load('ai_chat_sync_settings', null),
      logs: logData,
      snapshots: snapshots.map(snapshot => ({ ...snapshot, data: structuredClone(snapshot.data) })),
    };
    const filename = 'ai-chat-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    if (downloadExport(JSON.stringify(data, null, 2), filename, 'application/json')) setStatus(true, '已导出完整备份（含日志、快照与设置）');
  } catch (error) {
    setStatus(false, `导出失败：${error.message || '无法读取会话数据库'}`);
  }
}

function importData() {
  if (isDataMutationBlocked('导入并替换数据')) return;
  const fileInput = document.getElementById('importFile');
  fileInput.click();
}

function handleImportFile(e) {
  if (isDataMutationBlocked('导入并替换数据')) { e.target.value = ''; return; }
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(ev) {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.configs && !data.conversations) throw new Error('无效的备份文件');
      const confirmed = await appDialog.confirm('导入会替换当前全部配置、会话、日志、本地快照和界面设置，现有数据将无法自动恢复。', { title: '导入并替换全部数据？', confirmText: '继续导入', danger: true });
      if (!confirmed || isDataMutationBlocked('导入并替换数据')) return;
      localStorage.setItem(KEYS.CONFIGS, JSON.stringify(data.configs || []));
      localStorage.setItem(KEYS.ACTIVE_CONFIG, data.activeConfig || '');
      if (data.params && typeof data.params === 'object') localStorage.setItem('ai_chat_params', JSON.stringify(data.params));
      if (typeof data.theme === 'string' && data.theme) localStorage.setItem(THEME_KEY, data.theme);
      if (data.readingSettings && typeof data.readingSettings === 'object') localStorage.setItem(READING_KEY, JSON.stringify(data.readingSettings));
      if (data.logSettings && typeof data.logSettings === 'object') saveLogSettings(data.logSettings);
      if (data.syncSettings && typeof data.syncSettings === 'object') localStorage.setItem('ai_chat_sync_settings', JSON.stringify(data.syncSettings));
      await replaceConversations(data.conversations || [], data.activeConv || '');
      if (data.logs && typeof data.logs === 'object') await importLogsData(data.logs);
      if (Array.isArray(data.snapshots)) {
        for (const snapshot of data.snapshots) {
          if (snapshot?.id && snapshot?.data) await putStoredSnapshot(snapshot);
        }
      }
      location.reload();
    } catch (err) {
      await appDialog.alert(`导入失败：${err.message}`, { title: '无法导入数据' });
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ---- Export current conversation as Markdown ----
function exportCurrentConv() {
  const conv = getActiveConv();
  if (!conv) return;
  let md = `# ${conv.title}\n\n`;
  if (conv.forkedFrom) {
    md += `> 分支来源：${conv.forkedFrom.title || '原对话'}（消息 ${conv.forkedFrom.messageIndex + 1}）\n\n`;
  }
  for (const msg of conv.messages) {
    if (msg.role === 'user') {
      md += `**你：** ${msg.content}\n\n`;
    } else {
      if (msg.reasoning) md += `> <details><summary>思考过程</summary>\n\n${msg.reasoning}\n\n</details>\n\n`;
      md += `**AI：** ${msg.content}\n\n`;
    }
    md += '---\n\n';
  }
  const filename = (conv.title || 'conversation') + '-' + new Date().toISOString().slice(0, 10) + '.md';
  if (downloadExport(md, filename, 'text/markdown')) setStatus(true, '已导出对话');
}

// ---- Conversation list management ----

let suppressConversationClickUntil = 0;
let conversationMenuId = null;

function closeConversationMenu() {
  document.getElementById('conversationManageOverlay')?.classList.remove('show');
  conversationMenuId = null;
}

function openConversationMenu(id) {
  const conv = getConversations().find(item => item.id === id);
  if (!conv) return;
  conversationMenuId = id;
  document.getElementById('conversationManageTitle').textContent = conv.title || '新对话';
  document.getElementById('conversationManageOverlay')?.classList.add('show');
}

function installConversationLongPress() {
  const list = document.getElementById('convList');
  if (!list) return;
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let pressedItem = null;
  let longPressed = false;

  const cancelPress = () => {
    window.clearTimeout(timer);
    timer = 0;
    pressedItem?.classList.remove('long-pressing');
    pressedItem = null;
  };

  list.addEventListener('pointerdown', event => {
    if (!isMobileLayout() || event.pointerType === 'mouse' || event.target.closest('button')) return;
    pressedItem = event.target.closest('.conv-item');
    if (!pressedItem) return;
    startX = event.clientX;
    startY = event.clientY;
    longPressed = false;
    pressedItem.classList.add('long-pressing');
    timer = window.setTimeout(() => {
      longPressed = true;
      suppressConversationClickUntil = Date.now() + 700;
      navigator.vibrate?.(30);
      openConversationMenu(pressedItem.dataset.convId);
      cancelPress();
    }, 520);
  });
  list.addEventListener('pointermove', event => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancelPress();
  });
  list.addEventListener('pointerup', event => {
    if (longPressed) event.preventDefault();
    cancelPress();
  });
  list.addEventListener('pointercancel', cancelPress);
  list.addEventListener('contextmenu', event => {
    if (!isMobileLayout()) return;
    const item = event.target.closest('.conv-item');
    if (!item) return;
    event.preventDefault();
    suppressConversationClickUntil = Date.now() + 700;
    openConversationMenu(item.dataset.convId);
  });
}

async function handleConvClick(e) {
  if (Date.now() < suppressConversationClickUntil) {
    e.preventDefault();
    return;
  }
  const item = e.target.closest('.conv-item');
  if (!item) return;
  const id = item.dataset.convId;
  if (e.target.closest('[data-action="rename"]')) {
    renameConversation(id);
  } else if (e.target.closest('[data-action="delete"]')) {
    if (isStreaming || isDiscussionStreaming || agentAbortCtrl) { setStatus(false, '生成、讨论或创作任务进行中，暂时不能删除会话'); return; }
    const conv = getConversations().find(item => item.id === id);
    const confirmed = await appDialog.confirm(`“${conv?.title || '新对话'}”及其讨论和创作资料将被永久删除。`, { title: '删除对话？', confirmText: '删除', danger: true });
    if (!confirmed) return;
    deleteConversation(id);
    loadAgentWorkspace();
    renderConvList();
    renderChatMessages();
    renderDiscussionViews();
    renderAgentPage();
    renderAgentDetail();
  } else {
    safeSwitchConv(id);
  }
}

// ---- Sidebar collapse toggles ----
function isMobileLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}
function closeMobilePanels() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('rightPanel')?.classList.remove('mobile-open');
  document.getElementById('sidebarOverlay')?.classList.remove('show');
}
function toggleLeftSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (isMobileLayout()) {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    document.getElementById('rightPanel')?.classList.remove('mobile-open');
    document.getElementById('sidebarOverlay')?.classList.toggle('show', open);
    return;
  }
  const collapsed = sidebar.classList.toggle('collapsed');
  document.getElementById('collapseLeft')?.classList.toggle('active', collapsed);
  syncLiquidGlassPanelState();
}
function toggleRightPanel() {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  if (isMobileLayout()) {
    const open = !panel.classList.contains('mobile-open');
    panel.classList.toggle('mobile-open', open);
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('show');
    return;
  }
  panel.classList.toggle('collapsed');
  document.getElementById('collapseRight')?.classList.toggle('active', panel.classList.contains('collapsed'));
  syncLiquidGlassPanelState();
}

// ---- Data center ----

const MAX_DATA_SNAPSHOTS = 30;
let dataSnapshots = [];

async function readDataSnapshots() {
  dataSnapshots = await getStoredSnapshots();
  return dataSnapshots;
}

function currentDataSnapshot() {
  return {
    configs: JSON.parse(localStorage.getItem(KEYS.CONFIGS) || '[]'),
    activeConfig: localStorage.getItem(KEYS.ACTIVE_CONFIG) || '',
    conversations: structuredClone(getConversations()),
    activeConv: getActiveConvId(),
    params: JSON.parse(localStorage.getItem('ai_chat_params') || '{}'),
  };
}

async function renderDataSnapshots() {
  const list = document.getElementById('dataSnapshotList');
  if (!list) return;
  const snapshots = await readDataSnapshots();
  if (!snapshots.length) {
    list.innerHTML = '<div class="param-hint">暂无本地快照</div>';
    return;
  }
  list.innerHTML = snapshots.map(snapshot => `<div class="data-snapshot-item">
    <div class="data-snapshot-meta"><strong>${escapeHtml2(snapshot.name || '未命名快照')}</strong><span>${escapeHtml2(new Date(snapshot.createdAt).toLocaleString('zh-CN'))} · ${(snapshot.data?.conversations || []).length} 个对话</span></div>
    <div class="data-snapshot-actions"><button class="btn btn-ghost btn-sm" type="button" data-snapshot-restore="${snapshot.id}">恢复</button><button class="btn btn-danger btn-sm" type="button" data-snapshot-delete="${snapshot.id}">删除</button></div>
  </div>`).join('');
}

async function createDataSnapshot() {
  const input = document.getElementById('dataSnapshotName');
  const name = input?.value.trim() || `本地快照 ${new Date().toLocaleString('zh-CN')}`;
  try {
    await flushConversationWrites();
    await putStoredSnapshot({ id: `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: name.slice(0, 80), createdAt: new Date().toISOString(), data: currentDataSnapshot() });
    await trimStoredSnapshots(MAX_DATA_SNAPSHOTS);
    if (input) input.value = '';
    await renderDataSnapshots();
    setDataCenterSaveStatus('dataSnapshotStatus', `已保存快照：${name}`);
    setStatus(true, '本地数据快照已保存');
  } catch {
    setDataCenterSaveStatus('dataSnapshotStatus', '保存失败：本地存储空间不足', true);
  }
}

async function restoreDataSnapshot(id) {
  if (isDataMutationBlocked('恢复本地快照')) return;
  const snapshot = (await readDataSnapshots()).find(item => item.id === id);
  if (!snapshot?.data) return;
  const confirmed = await appDialog.confirm(`恢复到“${snapshot.name}”后，当前对话、讨论、作品记忆、配置和参数将被替换；本机日志不受影响。`, { title: '恢复本地快照？', confirmText: '恢复', danger: true });
  if (!confirmed || isDataMutationBlocked('恢复本地快照')) return;
  const data = snapshot.data;
  localStorage.setItem(KEYS.CONFIGS, JSON.stringify(data.configs || []));
  localStorage.setItem(KEYS.ACTIVE_CONFIG, data.activeConfig || '');
  localStorage.setItem('ai_chat_params', JSON.stringify(data.params || {}));
  await replaceConversations(data.conversations || [], data.activeConv || '');
  setDataCenterSaveStatus('dataSnapshotStatus', `已恢复快照：${snapshot.name}，正在刷新页面。`);
  setStatus(true, '本地数据快照已恢复');
  setTimeout(() => location.reload(), 150);
}

async function deleteDataSnapshot(id) {
  const snapshot = (await readDataSnapshots()).find(item => item.id === id);
  if (!snapshot) return;
  const confirmed = await appDialog.confirm(`本地快照“${snapshot.name}”删除后无法恢复。`, { title: '删除本地快照？', confirmText: '删除', danger: true });
  if (!confirmed) return;
  await deleteStoredSnapshot(id);
  await renderDataSnapshots();
  setDataCenterSaveStatus('dataSnapshotStatus', '本地快照已删除。');
}

function dataCenterConv() {
  const id = document.getElementById('dataCenterConversation')?.value || getActiveConvId();
  return getConversations().find(conv => conv.id === id) || getActiveConv();
}

function renderDataCenter() {
  const select = document.getElementById('dataCenterConversation');
  if (!select) return;
  const conversations = getConversations();
  const selectedId = select.value || getActiveConvId();
  select.innerHTML = conversations.map(conv => `<option value="${conv.id}">${escapeHtml2(conv.title || '新对话')}</option>`).join('');
  if (selectedId && conversations.some(conv => conv.id === selectedId)) select.value = selectedId;
  const conv = dataCenterConv();
  if (!conv) return;
  const agent = conv.writingAgent || {};
  document.getElementById('dataCenterConversationData').value = JSON.stringify({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    messages: conv.messages || [],
    forkedFrom: conv.forkedFrom || null,
  }, null, 2);
  document.getElementById('dataCenterDiscussionData').value = JSON.stringify(conv.discussionMessages || [], null, 2);
  document.getElementById('dataCenterMemoryData').value = agent.memory || '';
  document.getElementById('dataCenterConversationMeta').textContent = `${(conv.messages || []).length} 条消息`;
  document.getElementById('dataCenterDiscussionMeta').textContent = `${(conv.discussionMessages || []).length} 条消息`;
  renderDataSnapshots();
}

function openDataCenter() {
  const activeId = getActiveConvId();
  renderDataCenter();
  const select = document.getElementById('dataCenterConversation');
  if (select && activeId) select.value = activeId;
  showModal('dataCenterModal');
}

function switchDataCenterConversation() {
  const id = document.getElementById('dataCenterConversation')?.value;
  if (!id || id === getActiveConvId()) {
    renderDataCenter();
    return;
  }
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) {
    setStatus(false, '生成、讨论或创作任务进行中，暂时不能切换会话');
    renderDataCenter();
    return;
  }
  persistAgentWorkspace();
  activateConv(id);
  loadAgentWorkspace();
  renderConvList();
  renderChatMessages();
  renderDiscussionViews();
  renderAgentPage();
  renderDataCenter();
  setStatus(true, '已切换数据中心会话');
}

function closeDataCenter() { hideModal('dataCenterModal'); }

function parseDataCenterJson(id) {
  try { return JSON.parse(document.getElementById(id).value || ''); }
  catch (error) { setStatus(false, `数据格式错误：${error.message}`); return null; }
}

function setDataCenterSaveStatus(id, text, error = false) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.classList.toggle('error', error); }
}

function saveDataCenterConversation() {
  if (isDataMutationBlocked('保存对话数据')) return;
  const conv = dataCenterConv();
  const data = parseDataCenterJson('dataCenterConversationData');
  if (!conv || !data || !Array.isArray(data.messages)) { setDataCenterSaveStatus('conversationSaveStatus', '保存失败：请检查 JSON 格式', true); return; }
  conv.title = String(data.title || conv.title || '新对话');
  conv.createdAt = Number(data.createdAt) || conv.createdAt;
  conv.messages = data.messages;
  if (data.forkedFrom) conv.forkedFrom = data.forkedFrom;
  else delete conv.forkedFrom;
  persistConversations();
  renderConvList(); renderChatMessages(); renderDataCenter();
  setDataCenterSaveStatus('conversationSaveStatus', `已保存 ${conv.messages.length} 条对话消息`);
  setStatus(true, '对话数据已保存');
}

function saveDataCenterDiscussion() {
  if (isDataMutationBlocked('保存讨论数据')) return;
  const conv = dataCenterConv();
  const data = parseDataCenterJson('dataCenterDiscussionData');
  if (!conv || !Array.isArray(data)) { setDataCenterSaveStatus('discussionSaveStatus', '保存失败：必须是消息数组', true); return; }
  conv.discussionMessages = data;
  persistConversations();
  renderDiscussionViews(); renderDataCenter();
  setDataCenterSaveStatus('discussionSaveStatus', `已保存 ${data.length} 条讨论消息`);
  setStatus(true, '讨论数据已保存');
}

function saveDataCenterMemory() {
  if (isDataMutationBlocked('保存作品记忆')) return;
  const conv = dataCenterConv();
  if (!conv) { setDataCenterSaveStatus('memorySaveStatus', '保存失败：没有选择会话', true); return; }
  if (!conv.writingAgent || typeof conv.writingAgent !== 'object') conv.writingAgent = { mode: 'off', memory: '', directives: [], suggestions: [], lastPreflight: '' };
  conv.writingAgent.memory = document.getElementById('dataCenterMemoryData').value;
  persistConversations();
  renderAgentPage(); renderDataCenter();
  setDataCenterSaveStatus('memorySaveStatus', `已保存作品记忆（${conv.writingAgent.memory.length} 字）`);
  setStatus(true, '作品记忆已保存');
}

async function clearDataCenterConversation() {
  if (isDataMutationBlocked('清空正文数据')) return;
  const confirmed = await appDialog.confirm('正文消息将被全部清空，但会话本身、讨论和创作资料会保留。', { title: '清空正文数据？', confirmText: '清空', danger: true });
  if (!confirmed || isDataMutationBlocked('清空正文数据')) return;
  const conv = dataCenterConv();
  if (!conv) return;
  conv.messages = [];
  persistConversations(); renderChatMessages(); renderConvList(); renderDataCenter();
}

async function clearDataCenterDiscussion() {
  if (isDataMutationBlocked('清空讨论数据')) return;
  const confirmed = await appDialog.confirm('当前对话的全部讨论记录将被清空，正文不会受到影响。', { title: '清空讨论数据？', confirmText: '清空', danger: true });
  if (!confirmed || isDataMutationBlocked('清空讨论数据')) return;
  const conv = dataCenterConv();
  if (!conv) return;
  conv.discussionMessages = [];
  persistConversations(); renderDiscussionViews(); renderDataCenter();
}

async function clearDataCenterMemory() {
  if (isDataMutationBlocked('清空作品记忆')) return;
  const confirmed = await appDialog.confirm('当前会话的作品记忆将被清空，正文和世界观不会受到影响。', { title: '清空作品记忆？', confirmText: '清空', danger: true });
  if (!confirmed || isDataMutationBlocked('清空作品记忆')) return;
  const conv = dataCenterConv();
  if (!conv?.writingAgent) return;
  conv.writingAgent.memory = '';
  persistConversations(); renderAgentPage(); renderDataCenter();
}

// ---- Logs modal ----

let allLogs = [];

function escapeLogText(text) {
  const el = document.createElement('div');
  el.textContent = String(text ?? '');
  return el.innerHTML;
}

function formatLogDetails(details) {
  if (!details || typeof details !== 'object' || !Object.keys(details).length) return '';
  try { return JSON.stringify(details); } catch { return ''; }
}

function formatCachePercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '暂无数据';
}

function formatTokenCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)).toLocaleString('zh-CN') : '0';
}

function renderCacheStats() {
  const content = document.getElementById('cacheStatsContent');
  const summaryText = document.getElementById('cacheStatsSummaryText');
  if (!content || !summaryText) return;
  const summary = summarizeCacheUsage(allLogs);
  const availability = summary.measurableRequests
    ? `服务商提供了 ${summary.measurableRequests} 次可统计数据`
    : summary.completedRequests
      ? '服务商尚未提供可识别的缓存统计'
      : '暂无已完成的模型请求';
  summaryText.textContent = summary.measurableRequests
    ? `${summary.hitRequests}/${summary.measurableRequests} 次命中 · ${formatCachePercent(summary.requestHitRate)}`
    : availability;
  content.innerHTML = `<div class="cache-stats-heading"><div><span>${escapeLogText(availability)}</span></div><small>只统计服务商实际返回的数据</small></div>
    <div class="cache-stats-grid">
      <div class="cache-stat"><span>可统计请求</span><strong>${formatTokenCount(summary.measurableRequests)}</strong></div>
      <div class="cache-stat"><span>命中请求</span><strong>${formatTokenCount(summary.hitRequests)}</strong></div>
      <div class="cache-stat"><span>请求命中率</span><strong>${formatCachePercent(summary.requestHitRate)}</strong></div>
      <div class="cache-stat"><span>总输入 Tokens</span><strong>${formatTokenCount(summary.totalInputTokens)}</strong></div>
      <div class="cache-stat"><span>缓存读取 Tokens</span><strong>${formatTokenCount(summary.cachedReadTokens)}</strong></div>
      <div class="cache-stat"><span>Token 复用率</span><strong>${formatCachePercent(summary.tokenReuseRate)}</strong></div>
    </div>
    <div class="cache-stats-note">未提供缓存字段的请求不计入命中率；缓存写入 Tokens 仅在服务商明确返回时累计${summary.cacheWriteTokens ? `，当前为 ${formatTokenCount(summary.cacheWriteTokens)}` : ''}。</div>`;
}

function renderLogs() {
  const list = document.getElementById('logsList');
  const filter = document.getElementById('logFilter').value;
  const logs = filter === 'all' ? allLogs : allLogs.filter(item => item.kind === filter);
  if (!logs.length) {
    list.innerHTML = '<div class="logs-empty">暂无匹配日志</div>';
    return;
  }
  list.innerHTML = [...logs].reverse().map(item => {
    const detail = formatLogDetails(item.details);
    const content = [item.message, detail].filter(Boolean).join(detail && item.message ? ' · ' : '');
    const logId = String(item.id || '');
    const index = allLogs.indexOf(item);
    const detailBadge = item.contentMode === 'full' && item.payload?.detailAvailable !== false
      ? '<span class="log-detail-badge">完整</span>'
      : '<span class="log-detail-badge summary">摘要</span>';
    return `<div class="log-entry clickable" data-log-id="${escapeLogText(logId)}" data-log-index="${index}" role="button" tabindex="0" title="点击查看日志详情">
      <span class="log-time">${escapeLogText(item.time || '')}</span>
      <span class="log-kind">${escapeLogText(item.kind || 'operation')}</span>
      <span class="log-content"><span class="log-event">${escapeLogText(item.event || '')}</span>${escapeLogText(content)}${detailBadge}</span>
    </div>`;
  }).join('');
}

async function refreshLogs() {
  const list = document.getElementById('logsList');
  list.innerHTML = '<div class="logs-empty">正在读取日志…</div>';
  try {
    allLogs = await getLogs();
    renderCacheStats();
    renderLogs();
  } catch (error) {
    list.innerHTML = `<div class="logs-empty">读取本机日志失败：${escapeLogText(error?.message || '存储不可用')}</div>`;
  }
}

function openLogs() {
  showModal('logsModal');
  refreshLogs();
}

function closeLogs() {
  closeLogDetail();
  hideModal('logsModal');
}

function openLogDetail(index, id = '') {
  const entry = id
    ? allLogs.find(item => String(item?.id || '') === String(id))
    : allLogs[index];
  if (!entry) return;
  closeLogDetail();
  const title = document.getElementById('logDetailTitle');
  const meta = document.getElementById('logDetailMeta');
  const body = document.getElementById('logDetailBody');
  title.textContent = entry.event || '日志详情';
  meta.textContent = [entry.time, entry.kind].filter(Boolean).join(' · ');

  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const fullAvailable = entry.contentMode === 'full' && payload.detailAvailable !== false;
  const sections = [];
  if (entry.message) {
    sections.push(`<section class="log-detail-section"><h4>说明</h4><div class="log-detail-empty">${escapeLogText(entry.message)}</div></section>`);
  }
  if (Object.keys(details).length) {
    sections.push(`<section class="log-detail-section"><h4>摘要数据</h4><pre class="log-detail-code">${escapeLogText(JSON.stringify(details, null, 2))}</pre></section>`);
  }
  if (payload.request) {
    sections.push(`<section class="log-detail-section"><h4>发送内容或摘要</h4><pre class="log-detail-code">${escapeLogText(JSON.stringify(payload.request, null, 2))}</pre></section>`);
  }
  if (payload.response) {
    sections.push(`<section class="log-detail-section"><h4>收到内容或摘要</h4><pre class="log-detail-code">${escapeLogText(JSON.stringify(payload.response, null, 2))}</pre></section>`);
  }
  if (!payload.request && !payload.response) {
    sections.push(`<div class="log-detail-empty">${fullAvailable ? '已开启完整记录，但本次请求没有可读取的模型输入输出内容。' : '这条日志只保存了事件摘要。请先开启“记录完整模型输入输出”，再发起新的模型请求；历史日志不会补录。'}</div>`);
  }
  body.innerHTML = sections.join('');
  body.scrollTop = 0;
  showModal('logDetailModal');
}

function closeLogDetail() {
  hideModal('logDetailModal');
}

const READING_KEY = 'ai_chat_reading_settings';
const readingDefaults = { fontSize: '16', lineHeight: '1.85', showThinking: '1' };
const readingSettings = { ...readingDefaults, ...readStoredObject(READING_KEY) };

function applyReadingSettings() {
  const body = document.getElementById('discussionDetailList');
  const mainFont = document.getElementById('mainFontSize');
  const mainLine = document.getElementById('mainLineHeight');
  const showThinking = document.getElementById('showThinking');
  const root = document.documentElement;
  root.style.setProperty('--reading-main-font-size', `${readingSettings.fontSize}px`);
  root.style.setProperty('--reading-main-line-height', readingSettings.lineHeight);
  if (body) {
    body.style.fontSize = `${readingSettings.fontSize}px`;
    body.style.lineHeight = readingSettings.lineHeight;
  }
  if (mainFont) mainFont.value = readingSettings.fontSize;
  if (mainLine) mainLine.value = readingSettings.lineHeight;
  // 思考内容总开关：正文与讨论页共用，靠 body 上的类让 CSS 统一收起
  const thinkingHidden = readingSettings.showThinking === '0';
  if (showThinking) showThinking.value = thinkingHidden ? '0' : '1';
  document.body.classList.toggle('hide-thinking', thinkingHidden);
}

function persistReadingSettings() {
  localStorage.setItem(READING_KEY, JSON.stringify(readingSettings));
}

function renderAgentPromptControls() {
  const controls = document.getElementById('agentPromptControls');
  const templates = document.getElementById('agentPromptTemplates');
  if (!controls || !templates) return;
  const settings = getAgentPromptSettings();
  const labels = [
    ['generate', '生成续写草稿'],
    ['preflight', '检查当前草稿'],
    ['initial-memory', '从正文整理初始记忆'],
    ['extract', '从当前草稿整理记忆'],
    ['manual-memory', 'AI 定向补充作品记忆'],
    ['worldview', 'AI 整理世界观'],
  ];
  controls.innerHTML = labels.map(([key, label]) => `<label class="agent-prompt-control"><span>${label}</span><textarea rows="3" data-agent-prompt-key="${key}" placeholder="可选：作为这个环节的 system 系统指令发送"></textarea></label>`).join('');
  controls.querySelectorAll('[data-agent-prompt-key]').forEach(el => { el.value = settings.additions[el.dataset.agentPromptKey] || ''; });
  templates.innerHTML = settings.templates.length ? settings.templates.map(item => `<div class="agent-item"><label class="agent-item-main"><input type="checkbox" data-agent-template-toggle="${item.id}" ${item.active !== false ? 'checked' : ''}><span class="agent-item-text"><strong>${escapeHtml2(item.name || '未命名风格模板')}</strong><br>${escapeHtml2(item.text || '')}</span></label><button class="agent-item-delete" type="button" data-agent-template-delete="${item.id}" title="删除风格模板" aria-label="删除风格模板：${escapeHtml2(item.name || '未命名模板')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"></path></svg></button></div>`).join('') : '<div class="param-hint">暂无自定义风格模板</div>';
}

function renderAgentDetail() {
  const state = getWritingAgentState();
  const input = document.getElementById('agentDetailInput');
  const applyWorldviewToMain = document.getElementById('agentDetailApplyWorldviewToMain');
  const applyMemoryToMain = document.getElementById('agentDetailApplyMemoryToMain');
  const worldview = document.getElementById('agentDetailWorldview');
  const worldviewSummary = document.getElementById('agentDetailWorldviewSummary');
  const worldviewResult = document.getElementById('agentDetailWorldviewResult');
  const memory = document.getElementById('agentDetailMemory');
  const memoryResult = document.getElementById('agentDetailMemoryResult');
  const memorySummary = document.getElementById('agentDetailMemorySummary');
  const contextSwitchHint = document.getElementById('agentDetailContextSwitchHint');
  const contextMessageLimit = document.getElementById('agentContextMessageLimit');
  const contextMessageLimitHint = document.getElementById('agentContextMessageLimitHint');
  if (applyWorldviewToMain) applyWorldviewToMain.checked = state.applyWorldviewToMain;
  if (applyMemoryToMain) applyMemoryToMain.checked = state.applyMemoryToMain;
  if (contextMessageLimit) contextMessageLimit.value = String(state.contextMessageLimit);
  if (contextMessageLimitHint) {
    contextMessageLimitHint.textContent = state.contextMessageLimit === 0
      ? '将发送当前有效分支的全部正文；长对话可能超过模型上下文上限。'
      : `将发送当前有效分支最近 ${state.contextMessageLimit} 条消息；一次作者消息或 AI 正文各算 1 条。`;
  }
  if (worldview && document.activeElement !== worldview) worldview.value = normalizeVisibleNewlines(state.worldview);
  if (worldviewSummary) worldviewSummary.textContent = state.worldview?.trim() ? `已保存 · ${state.worldview.trim().length} 字` : '尚未填写';
  if (worldviewResult && document.activeElement !== worldviewResult) worldviewResult.value = agentWorldviewResultText || '';
  if (memory && document.activeElement !== memory) memory.value = normalizeVisibleNewlines(state.memory);
  if (memoryResult && document.activeElement !== memoryResult) memoryResult.value = agentMemoryResultText || '';
  if (memorySummary) memorySummary.textContent = state.memory?.trim() ? `已保存 · ${state.memory.trim().length} 字` : '尚未填写';
  const overviewWorldview = document.getElementById('agentDetailOverviewWorldviewSummary');
  const overviewMemory = document.getElementById('agentDetailOverviewMemorySummary');
  if (overviewWorldview) overviewWorldview.textContent = state.worldview?.trim() ? `${state.worldview.trim().length} 字已保存` : '尚未填写';
  if (overviewMemory) overviewMemory.textContent = state.memory?.trim() ? `${state.memory.trim().length} 字已保存` : '尚未填写';
  if (contextSwitchHint) {
    const enabled = [
      state.applyWorldviewToMain ? '世界观' : '',
      state.applyMemoryToMain ? '作品记忆' : '',
    ].filter(Boolean);
    contextSwitchHint.textContent = enabled.length
      ? `主页正文将把${enabled.join('和')}作为系统级参考；创作工作台始终使用自身已启用的创作资料和提示词，讨论仍保持隔离。`
      : '主页正文当前不读取创作资料；创作工作台仍使用世界观、作品记忆及已启用的提示词，讨论保持隔离。';
  }
  const detailDirectiveList = document.getElementById('agentDetailDirectivesList');
  const activeDirectives = (state.directives || []).filter(item => item?.active !== false && item.text?.trim());
  const detailDirectiveSummary = document.getElementById('agentDetailDirectiveSummary');
  if (detailDirectiveSummary) detailDirectiveSummary.textContent = activeDirectives.length ? `已启用 ${activeDirectives.length} 条普通写作要求` : '作为普通写作要求发送';
  if (detailDirectiveList) {
    detailDirectiveList.innerHTML = state.directives?.length ? state.directives.map(item => `<div class="agent-item"><label class="agent-item-main"><input type="checkbox" data-agent-detail-directive="${item.id}" ${item.active !== false ? 'checked' : ''}><span class="agent-item-text">${escapeHtml2(item.text || '')}</span></label><button class="agent-item-delete" type="button" data-agent-detail-delete="${item.id}" title="删除这条长期写作规则" aria-label="删除这条长期写作规则"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"></path></svg></button></div>`).join('') : '<div class="param-hint">暂无长期写作规则</div>';
  }
  const draft = document.getElementById('agentDetailDraft');
  const result = document.getElementById('agentDetailResult');
  if (input && document.activeElement !== input) input.value = input.value || agentDraftTask || '';
  if (draft && document.activeElement !== draft) draft.value = agentDraftText || '';
  const detailThink = document.getElementById('agentDetailThink');
  if (detailThink) { detailThink.textContent = agentThinkText || ''; detailThink.hidden = !agentThinkText; }
  const detailPreflight = document.getElementById('agentDetailPreflightResult');
  if (detailPreflight) detailPreflight.textContent = agentReviewText || '尚未检查当前续写草稿。';
  const detailPreflightSection = document.getElementById('agentDetailPreflightSection');
  if (detailPreflightSection) detailPreflightSection.hidden = !agentReviewText;
  const isBusy = Boolean(agentAbortCtrl);
  const hasDraft = Boolean((agentDraftText || '').trim() && !agentDraftText.startsWith('错误：'));
  const hasCandidates = Boolean(agentExtraction);
  const candidatesStale = Boolean(hasCandidates && agentCandidatesDraftUpdatedAt && agentDraftUpdatedAt && agentCandidatesDraftUpdatedAt !== agentDraftUpdatedAt);
  const generateBtn = document.getElementById('agentDetailGenerateBtn');
  if (generateBtn) { generateBtn.disabled = isBusy; generateBtn.textContent = hasDraft ? '重新生成续写草稿' : '生成续写草稿'; }
  const extractBtn = document.getElementById('agentDetailExtractBtn');
  if (extractBtn) { extractBtn.disabled = !hasDraft || isBusy; extractBtn.textContent = hasCandidates ? '按当前草稿重新整理' : '从当前草稿整理候选'; }
  const preflightBtn = document.getElementById('agentDetailPreflightBtn');
  if (preflightBtn) preflightBtn.disabled = !hasDraft || isBusy;
  const organizeMemoryBtn = document.getElementById('agentDetailOrganizeMemoryBtn');
  if (organizeMemoryBtn) organizeMemoryBtn.disabled = isBusy;
  const discoverMemoryBtn = document.getElementById('agentDetailDiscoverMemoryBtn');
  if (discoverMemoryBtn) discoverMemoryBtn.disabled = isBusy;
  const organizeWorldviewBtn = document.getElementById('agentDetailOrganizeWorldviewBtn');
  if (organizeWorldviewBtn) organizeWorldviewBtn.disabled = isBusy;
  const applyWorldviewBtn = document.getElementById('agentDetailApplyWorldviewBtn');
  if (applyWorldviewBtn) applyWorldviewBtn.disabled = isBusy || !agentWorldviewResultText.trim();
  const applyMemoryBtn = document.getElementById('agentDetailApplyMemoryBtn');
  if (applyMemoryBtn) applyMemoryBtn.disabled = isBusy || !agentMemoryResultText.trim();
  const applyDraftBtn = document.getElementById('agentDetailApplyDraftBtn');
  if (applyDraftBtn) applyDraftBtn.disabled = !hasDraft || isBusy;
  const clearDraftBtn = document.getElementById('agentDetailClearDraftBtn');
  if (clearDraftBtn) clearDraftBtn.disabled = !hasDraft || isBusy;
  const applyResultBtn = document.getElementById('agentDetailApplyResultBtn');
  if (applyResultBtn) applyResultBtn.disabled = !hasCandidates || isBusy;
  const clearResultBtn = document.getElementById('agentDetailClearResultBtn');
  if (clearResultBtn) clearResultBtn.disabled = !hasCandidates || isBusy;
  const stopBtn = document.getElementById('agentDetailStopBtn');
  if (stopBtn) stopBtn.hidden = !isBusy;
  const detailStatus = document.getElementById('agentDetailStatus');
  if (detailStatus && !detailStatus.textContent) detailStatus.textContent = candidatesStale ? '草稿已修改，当前候选可能已过期，请重新整理。' : '记忆候选只有在勾选确认后才会写入作品记忆。';
  setAgentDetailTab(agentDetailTab);
  if (result && document.activeElement !== result) {
    if (agentExtraction) {
      result.innerHTML = extractionCategories().map(({ key, label }) => {
        const values = agentExtraction[key] || [];
        if (!values.length) return '';
        return `<div class="agent-result-section"><strong>${escapeHtml2(label)}</strong>${values.map((value, index) => `<label class="agent-item"><input type="checkbox" data-agent-suggestion="${key}:${index}" checked><span class="agent-item-text" contenteditable="true" spellcheck="true">${escapeHtml2(value)}</span></label>`).join('')}</div>`;
      }).join('') || '<div class="param-hint">本次没有提取到明确的新记忆。</div>';
    } else if (agentResultText) {
      result.textContent = agentResultText;
    } else {
      result.innerHTML = '<div class="param-hint">暂无记忆候选。可从当前草稿、现有正文或作者新增设定中整理。</div>';
    }
  }
  renderAgentPromptControls();
}

function openAgentDetail() {
  try {
    loadAgentWorkspace();
    showModal('agentDetailModal');
    setAgentDetailTab(agentDetailTab);
    renderAgentDetail();
  } catch (error) {
    console.error('openAgentDetail failed:', error);
    showModal('agentDetailModal');
    setAgentDetailTab(agentDetailTab);
  }
}

function closeAgentDetail() {
  const input = document.getElementById('agentDetailInput');
  const draft = document.getElementById('agentDetailDraft');
  if (input) document.getElementById('agentDetailInput').value = input.value;
  if (draft) {
    document.getElementById('agentDetailDraft').value = draft.value;
    agentDraftText = draft.value;
    if (agentDraftText.trim()) agentDraftUpdatedAt = agentDraftUpdatedAt || Date.now();
    persistAgentWorkspace();
  }
  hideModal('agentDetailModal');
  renderAgentPage();
}

function openDiscussionDetail() {
  const title = document.getElementById('discussionDetailTitle');
  if (title) title.textContent = `当前对话：${getActiveConv()?.title || '新对话'}。讨论内容不会写入正文。`;
  renderDiscussionMessages('discussionDetailList');
  applyReadingSettings();
  showModal('discussionDetailModal');
}

function closeDiscussionDetail() {
  hideModal('discussionDetailModal');
}

async function clearAllLogs() {
  const kind = document.getElementById('logCleanupKind')?.value || 'all';
  const daysValue = document.getElementById('logCleanupDays')?.value || '';
  const beforeDays = daysValue ? Number(daysValue) : null;
  const scope = `${kind === 'all' ? '全部类型' : kind}${beforeDays ? `、${beforeDays} 天前` : '、全部时间'}`;
  const confirmed = await appDialog.confirm(`将清理${scope}的本机日志。此操作不会影响聊天数据，但日志无法恢复。`, { title: '清理运行日志？', confirmText: '清理', danger: true });
  if (!confirmed) return;
  const remaining = await clearLogs({ kind, beforeDays });
  logEvent('operation', 'logs_cleaned', { kind, beforeDays, remaining }, `已按条件清理日志：${scope}`);
  allLogs = await getLogs();
  renderCacheStats();
  renderLogs();
}

// ---- LAN sync ----

function updateSyncStatus(text, error = false) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function openSyncModal() {
  const current = getSyncSettings();
  document.getElementById('syncEnabled').checked = Boolean(current.enabled);
  document.getElementById('syncMode').value = current.mode || 'two-way';
  document.getElementById('syncServerUrl').value = current.serverUrl || '';
  document.getElementById('syncToken').value = current.token || '';
  updateSyncStatus(isSyncEnabled() ? '自动同步已启用，正在连接电脑服务。' : '未启用');
  showModal('syncModal');
}

function closeSyncModal() { hideModal('syncModal'); }

async function saveSyncModal() {
  const next = {
    enabled: document.getElementById('syncEnabled').checked,
    mode: document.getElementById('syncMode').value,
    serverUrl: document.getElementById('syncServerUrl').value.trim(),
    token: document.getElementById('syncToken').value.trim(),
  };
  saveSyncSettings(next);
  if (!next.enabled) {
    updateSyncStatus('自动同步已关闭');
    return;
  }
  try {
    if (next.mode === 'push-only') {
      await pushSnapshot();
      updateSyncStatus('已连接：仅同步模式，正在上传本机数据');
    } else {
      const state = await syncNow();
      if (next.mode === 'two-way' && Number(state.revision || 0) === 0) await syncNow({ pushFirst: true });
      updateSyncStatus(next.mode === 'pull-only' ? '已连接：仅被同步模式，只接收电脑数据' : '已连接并完成双向同步');
    }
    logEvent('sync', 'manual_connected', { mode: next.mode }, '局域网同步已连接');
  } catch (error) {
    updateSyncStatus(error.message || '连接失败，请检查电脑地址和口令', true);
  }
}

function applyRemoteSyncView() {
  if (isStreaming || isDiscussionStreaming || agentAbortCtrl) return;
  location.reload();
}

// ---- Event wiring ----

function wireEvents() {
  // Collapse buttons
  document.getElementById('collapseLeft').addEventListener('click', toggleLeftSidebar);
  document.getElementById('collapseRight').addEventListener('click', toggleRightPanel);
  document.getElementById('rightPanelCloseBtn').addEventListener('click', toggleRightPanel);
  document.getElementById('sidebarCloseBtn').addEventListener('click', closeMobilePanels);
  document.getElementById('sidebarOverlay').addEventListener('click', closeMobilePanels);
  document.getElementById('appDialogCancelBtn').addEventListener('click', () => settleAppDialog(activeDialog?.mode === 'prompt' ? null : false));
  document.getElementById('appDialogConfirmBtn').addEventListener('click', () => {
    const value = activeDialog?.mode === 'prompt' ? document.getElementById('appDialogInput').value : true;
    settleAppDialog(value);
  });
  document.getElementById('appDialogInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); settleAppDialog(event.currentTarget.value); }
    else if (event.key === 'Escape') { event.preventDefault(); settleAppDialog(null); }
  });
  document.getElementById('appDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget && activeDialog?.mode !== 'alert') settleAppDialog(activeDialog?.mode === 'prompt' ? null : false);
  });
  document.getElementById('syncBtn').addEventListener('click', openSyncModal);
  document.getElementById('closeSyncBtn').addEventListener('click', closeSyncModal);
  document.getElementById('saveSyncBtn').addEventListener('click', saveSyncModal);
  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    try {
      const mode = getSyncSettings().mode;
      if (mode === 'push-only') {
        await pushSnapshot();
        updateSyncStatus('已完成即时上传');
      } else {
        await syncNow();
        updateSyncStatus(mode === 'pull-only' ? '已完成即时接收同步' : '已完成即时同步');
      }
    } catch (error) {
      updateSyncStatus(error.message || '同步失败', true);
    }
  });
  document.getElementById('syncModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSyncModal();
  });
  window.addEventListener('ai-chat-sync-applied', applyRemoteSyncView);
  window.addEventListener('resize', () => {
    if (!isMobileLayout()) closeMobilePanels();
  });
  document.getElementById('logsBtn').addEventListener('click', openLogs);
  document.getElementById('closeLogsBtn').addEventListener('click', closeLogs);
  document.getElementById('refreshLogsBtn').addEventListener('click', refreshLogs);
  document.getElementById('clearLogsBtn').addEventListener('click', clearAllLogs);
  const cacheStats = document.getElementById('cacheStats');
  const cacheStatsSummary = document.getElementById('cacheStatsSummary');
  const setCacheStatsOpen = open => {
    cacheStats.open = Boolean(open);
    cacheStatsSummary.setAttribute('aria-expanded', String(cacheStats.open));
  };
  cacheStatsSummary.addEventListener('click', event => {
    event.preventDefault();
    setCacheStatsOpen(!cacheStats.open);
  });
  cacheStatsSummary.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setCacheStatsOpen(!cacheStats.open);
  });
  cacheStats.addEventListener('toggle', () => {
    cacheStatsSummary.setAttribute('aria-expanded', String(cacheStats.open));
  });
  const logIncludeContent = document.getElementById('logIncludeContent');
  const logRecordingHint = document.getElementById('logRecordingHint');
  const syncLogRecordingUi = () => {
    const enabled = getLogSettings().includeContent;
    logIncludeContent.checked = enabled;
    if (logRecordingHint) logRecordingHint.textContent = enabled
      ? '已开启：后续模型请求会保存发送消息和接收正文，可在详情中查看。历史日志不会补录。'
      : '关闭时仍保存请求摘要；不会保存发送消息、思考链和接收正文。';
  };
  syncLogRecordingUi();
  logIncludeContent.addEventListener('change', () => {
    const enabled = logIncludeContent.checked;
    saveLogSettings({ includeContent: enabled });
    syncLogRecordingUi();
    logEvent('operation', 'log_content_recording_changed', { enabled }, enabled ? '已开启完整模型输入输出记录' : '已关闭完整模型输入输出记录');
  });
  document.getElementById('logFilter').addEventListener('change', renderLogs);
  document.getElementById('logsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLogs();
  });
  const logsList = document.getElementById('logsList');
  const openLogFromEvent = event => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest?.('.log-entry[data-log-index]');
    if (!row || !logsList.contains(row)) return;
    event.preventDefault();
    event.stopPropagation();
    openLogDetail(Number(row.dataset.logIndex), row.dataset.logId || '');
  };
  // Capture pointer release at document level as a WebView-safe fallback:
  // older embedded pages could stop bubbling from a transformed/scrolling list.
  document.addEventListener('pointerup', openLogFromEvent, true);
  logsList.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.log-entry[data-log-index]');
    if (!row || !logsList.contains(row)) return;
    e.preventDefault();
    openLogDetail(Number(row.dataset.logIndex), row.dataset.logId || '');
  });
  document.getElementById('closeLogDetailBtn').addEventListener('click', closeLogDetail);
  document.getElementById('logDetailModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLogDetail();
  });

  // Parameter sliders
  const tempEl = document.getElementById('temperature');
  const tempVal = document.getElementById('tempValue');
  tempEl.value = params.temperature;
  tempVal.textContent = params.temperature;
  tempEl.addEventListener('input', () => { tempVal.textContent = tempEl.value; params.temperature = Math.max(0.01, parseFloat(tempEl.value)); persistParams(); logEvent('operation', 'parameter_changed', { parameter: 'temperature', value: params.temperature }, '更新 Temperature'); });
  const topPEl = document.getElementById('topP');
  const topPVal = document.getElementById('topPValue');
  topPEl.value = params.topP;
  topPVal.textContent = params.topP;
  topPEl.addEventListener('input', () => { topPVal.textContent = topPEl.value; params.topP = Math.max(0.05, parseFloat(topPEl.value)); persistParams(); logEvent('operation', 'parameter_changed', { parameter: 'topP', value: params.topP }, '更新 Top P'); });
  const topKEl = document.getElementById('topK');
  const topKVal = document.getElementById('topKValue');
  topKEl.value = params.topK;
  topKVal.textContent = params.topK;
  topKEl.addEventListener('input', () => { topKVal.textContent = topKEl.value; params.topK = parseInt(topKEl.value, 10); persistParams(); logEvent('operation', 'parameter_changed', { parameter: 'topK', value: params.topK }, '更新 Top K'); });
  const safetyMap = { safetyHateSpeech: 'hateSpeech', safetyHarassment: 'harassment', safetyDangerous: 'dangerous', safetySexual: 'sexual' };
  Object.entries(safetyMap).forEach(([elementId, key]) => {
    const element = document.getElementById(elementId);
    element.value = params.geminiSafety[key];
    element.addEventListener('change', () => { params.geminiSafety[key] = element.value; persistParams(); logEvent('operation', 'gemini_safety_changed', { category: key, threshold: element.value }, '更新 Gemini 安全设置'); });
  });
  const maxTok = document.getElementById('maxTokens');
  const maxTokVal = document.getElementById('maxTokensValue');
  maxTok.value = params.maxTokens;
  maxTokVal.textContent = params.maxTokens;
  maxTok.addEventListener('input', () => { maxTokVal.textContent = maxTok.value; params.maxTokens = parseInt(maxTok.value); persistParams(); logEvent('operation', 'parameter_changed', { parameter: 'maxTokens', value: params.maxTokens }, '更新最大 Tokens'); });
  const reasoningEl = document.getElementById('reasoningEffort');
  reasoningEl.value = params.reasoningEffort;
  const updateReasoningEffortLabel = () => {
    const effortEl = document.getElementById('reasoningEffortValue');
    if (effortEl) effortEl.textContent = params.reasoningEffort ? `(${escapeHtml2(params.reasoningEffort)})` : '(自动)';
  };
  updateReasoningEffortLabel();
  reasoningEl.addEventListener('change', () => {
    params.reasoningEffort = reasoningEl.value;
    persistParams();
    updateReasoningEffortLabel();
    logEvent('operation', 'parameter_changed', { parameter: 'reasoningEffort', value: params.reasoningEffort || 'auto' }, '更新思考强度');
  });
  const systemPromptEnabledEl = document.getElementById('systemPromptEnabled');
  const systemPromptInputEl = document.getElementById('systemPromptInput');
  const systemPromptSummaryEl = document.getElementById('systemPromptSummary');
  const openSystemPromptBtn = document.getElementById('openSystemPromptBtn');
  const updateSystemPromptView = () => {
    systemPromptEnabledEl.checked = params.systemPromptEnabled;
    systemPromptInputEl.value = params.systemPrompt;
    systemPromptInputEl.disabled = !params.systemPromptEnabled;
    systemPromptSummaryEl.textContent = params.systemPromptEnabled
      ? (params.systemPrompt.trim() ? `已启用 · ${params.systemPrompt.trim().slice(0, 28)}${params.systemPrompt.trim().length > 28 ? '…' : ''}` : '已启用 · 尚未填写内容')
      : '未启用';
  };
  updateSystemPromptView();
  const closeSystemPromptModal = () => hideModal('systemPromptModal');
  openSystemPromptBtn.addEventListener('click', () => showModal('systemPromptModal'));
  document.getElementById('closeSystemPromptBtn').addEventListener('click', closeSystemPromptModal);
  document.getElementById('saveSystemPromptBtn').addEventListener('click', closeSystemPromptModal);
  document.getElementById('systemPromptModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSystemPromptModal();
  });
  systemPromptEnabledEl.addEventListener('change', () => {
    params.systemPromptEnabled = systemPromptEnabledEl.checked;
    persistParams();
    updateSystemPromptView();
    logEvent('operation', 'system_prompt_toggled', { enabled: params.systemPromptEnabled }, '切换系统提示词');
  });
  systemPromptInputEl.addEventListener('input', () => {
    params.systemPrompt = systemPromptInputEl.value;
    persistParams();
    updateSystemPromptView();
  });

  // Click-to-edit param values
  const makeEditable = (valEl, sliderEl, paramKey, isFloat) => {
    valEl.addEventListener('click', () => {
      const cur = valEl.textContent;
      valEl.innerHTML = `<input type="text" value="${cur}">`;
      const inp = valEl.querySelector('input');
      inp.focus(); inp.select();
      const commit = () => {
        if (inp.value === '') { restoreVal(); return; }
        const v = isFloat ? parseFloat(inp.value) : parseInt(inp.value);
        if (isNaN(v)) { restoreVal(); return; }
        const clamped = isFloat
          ? Math.max(parseFloat(sliderEl.min), Math.min(parseFloat(sliderEl.max), v))
          : Math.max(parseInt(sliderEl.min), Math.min(parseInt(sliderEl.max), v));
        const display = isFloat ? clamped.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : clamped;
        valEl.textContent = display;
        sliderEl.value = clamped;
        params[paramKey] = clamped;
        persistParams();
      };
      const restoreVal = () => { valEl.textContent = cur; };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { commit(); inp.blur(); }
        if (e.key === 'Escape') { restoreVal(); inp.blur(); }
      });
    });
  };
  makeEditable(tempVal, tempEl, 'temperature', true);
  makeEditable(topPVal, topPEl, 'topP', true);
  makeEditable(topKVal, topKEl, 'topK', false);
  makeEditable(maxTokVal, maxTok, 'maxTokens', false);

  // Reset to defaults
  document.getElementById('resetParamsBtn').addEventListener('click', () => {
    params.temperature = 0.7;  params.topP = 1.0;  params.topK = 40; params.maxTokens = 4096; params.reasoningEffort = '';
    params.geminiSafety = { hateSpeech: 'default', harassment: 'default', dangerous: 'default', sexual: 'default' };
    tempEl.value = 0.7;  tempVal.textContent = '0.7';
    topPEl.value = 1;    topPVal.textContent = '1';
    topKEl.value = 40;   topKVal.textContent = '40';
    Object.keys(safetyMap).forEach(elementId => { document.getElementById(elementId).value = 'default'; });
    params.geminiSafety = { hateSpeech: 'default', harassment: 'default', dangerous: 'default', sexual: 'default' };
    maxTok.value = 4096;  maxTokVal.textContent = '4096'; reasoningEl.value = ''; updateReasoningEffortLabel();
    persistParams();
    logEvent('operation', 'parameters_reset', { temperature: 0.7, topP: 1, maxTokens: 4096 }, '恢复默认参数');
  });

  document.getElementById('paramsPageTab').addEventListener('click', () => switchRightPanelPage('params'));
  document.getElementById('discussionPageTab').addEventListener('click', () => { switchRightPanelPage('discussion'); renderDiscussionViews(); });
  document.getElementById('agentPageTab').addEventListener('click', () => { switchRightPanelPage('agent'); renderAgentPage(); });
  document.getElementById('agentApplyWorldviewToMain').addEventListener('change', e => {
    updateWritingAgentState({ applyWorldviewToMain: e.target.checked });
    renderAgentPage();
    renderAgentDetail();
  });
  document.getElementById('agentApplyMemoryToMain').addEventListener('change', e => {
    updateWritingAgentState({ applyMemoryToMain: e.target.checked });
    renderAgentPage();
    renderAgentDetail();
  });
  document.getElementById('openAgentDetailBtn')?.addEventListener('click', openAgentDetail);
  document.getElementById('closeAgentDetailBtn').addEventListener('click', closeAgentDetail);
  document.getElementById('agentDetailModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAgentDetail(); });
  document.querySelectorAll('[data-agent-detail-tab]').forEach(button => button.addEventListener('click', () => { setAgentDetailTab(button.dataset.agentDetailTab); }));
  document.querySelectorAll('[data-agent-open-tab]').forEach(button => button.addEventListener('click', () => { setAgentDetailTab(button.dataset.agentOpenTab); }));
  document.getElementById('agentDetailApplyWorldviewToMain').addEventListener('change', e => {
    updateWritingAgentState({ applyWorldviewToMain: e.target.checked });
    renderAgentPage();
    renderAgentDetail();
  });
  document.getElementById('agentDetailApplyMemoryToMain').addEventListener('change', e => {
    updateWritingAgentState({ applyMemoryToMain: e.target.checked });
    renderAgentPage();
    renderAgentDetail();
  });
  document.getElementById('agentContextMessageLimit').addEventListener('change', e => {
    updateWritingAgentState({ contextMessageLimit: Number(e.target.value) });
    renderAgentDetail();
    document.getElementById('agentDetailWritingStatus').textContent = e.target.value === '0'
      ? '续写和草稿检查将发送当前有效分支的全部正文。'
      : `续写和草稿检查将发送最近 ${e.target.value} 条正文消息。`;
  });
  document.getElementById('agentDetailInput').addEventListener('input', e => {
    agentDraftTask = e.target.value;
    if (agentDraftText.trim()) persistAgentWorkspace();
  });
  document.getElementById('agentDetailWorldview').addEventListener('input', e => updateWritingAgentState({ worldview: e.target.value }));
  document.getElementById('agentDetailSaveWorldviewBtn').addEventListener('click', () => { updateWritingAgentState({ worldview: document.getElementById('agentDetailWorldview').value }); document.getElementById('agentDetailWorldviewStatus').textContent = '世界观已保存。'; renderAgentPage(); renderAgentDetail(); });
  document.getElementById('agentDetailWorldviewResult').addEventListener('input', e => { agentWorldviewResultText = e.target.value; document.getElementById('agentDetailApplyWorldviewBtn').disabled = !e.target.value.trim(); });
  document.getElementById('agentDetailOrganizeWorldviewBtn').addEventListener('click', async () => {
    const btn = document.getElementById('agentDetailOrganizeWorldviewBtn');
    const result = document.getElementById('agentDetailWorldviewResult');
    const status = document.getElementById('agentDetailWorldviewStatus');
    const instruction = document.getElementById('agentDetailWorldviewInstruction').value.trim();
    if (agentAbortCtrl) { status.textContent = '已有创作任务正在进行，请等待完成或停止任务。'; return; }
    const conversationId = getActiveConvId();
    const ac = new AbortController();
    agentAbortCtrl = ac;
    agentRequestContext = { action: 'worldview', conversationId };
    btn.disabled = true;
    result.value = '';
    agentWorldviewResultText = '';
    status.textContent = 'AI 正在整理世界观…';
    try {
      const requestResult = await organizeWorldview(getSelectedModel(), ac, {
        onThink() {},
        onContent(text) { if (isAgentRequestCurrent(conversationId)) { agentWorldviewResultText = normalizeVisibleNewlines(text); result.value = agentWorldviewResultText; } },
        onDone(think, text) { if (isAgentRequestCurrent(conversationId)) { agentWorldviewResultText = normalizeVisibleNewlines(text || agentWorldviewResultText); result.value = agentWorldviewResultText; } },
        onError(message) { if (isAgentRequestCurrent(conversationId)) status.textContent = `世界观整理失败：${message}`; },
        onAbort() { if (isAgentRequestCurrent(conversationId)) status.textContent = '已停止世界观整理；结果未应用。'; },
      }, getChatParams(), instruction, document.getElementById('agentWorldviewOperation').value);
      if (!isAgentRequestCurrent(conversationId)) return;
      const success = requestResult?.status === 'success' && agentWorldviewResultText.trim();
      document.getElementById('agentDetailApplyWorldviewBtn').disabled = !success;
      if (success) status.textContent = '整理完成，请检查或修改后再应用到世界观。';
    } finally {
      if (agentRequestContext?.conversationId === conversationId) {
        agentAbortCtrl = null;
        agentRequestContext = null;
      }
      btn.disabled = false;
      renderAgentDetail();
    }
  });
  document.getElementById('agentDetailApplyWorldviewBtn').addEventListener('click', () => { const text = document.getElementById('agentDetailWorldviewResult').value.trim(); if (!text) return; updateWritingAgentState({ worldview: text }); document.getElementById('agentDetailWorldview').value = text; agentWorldviewResultText = ''; document.getElementById('agentDetailWorldviewResult').value = ''; document.getElementById('agentDetailApplyWorldviewBtn').disabled = true; document.getElementById('agentDetailWorldviewStatus').textContent = 'AI 结果已应用到世界观，临时修改稿已清空。'; renderAgentPage(); renderAgentDetail(); });
  document.getElementById('agentDetailClearWorldviewResultBtn').addEventListener('click', () => { agentWorldviewResultText = ''; document.getElementById('agentDetailWorldviewResult').value = ''; document.getElementById('agentDetailApplyWorldviewBtn').disabled = true; document.getElementById('agentDetailWorldviewStatus').textContent = 'AI 结果已清除。'; });
  document.getElementById('agentDetailMemory').addEventListener('input', e => updateWritingAgentState({ memory: e.target.value }));
  document.getElementById('agentDetailMemoryResult').addEventListener('input', e => { agentMemoryResultText = e.target.value; document.getElementById('agentDetailApplyMemoryBtn').disabled = !e.target.value.trim(); });
  document.getElementById('agentDetailOrganizeMemoryBtn').addEventListener('click', async () => {
    const btn = document.getElementById('agentDetailOrganizeMemoryBtn');
    const result = document.getElementById('agentDetailMemoryResult');
    const status = document.getElementById('agentDetailMemoryAiStatus');
    const instruction = document.getElementById('agentDetailMemoryInstruction').value.trim();
    if (!instruction) { status.textContent = '请先明确说明要补充、修改或删除什么。'; status.classList.add('error'); return; }
    if (agentAbortCtrl) { status.textContent = '已有创作任务正在进行，请等待完成或停止任务。'; status.classList.add('error'); return; }
    status.classList.remove('error');
    const conversationId = getActiveConvId();
    const ac = new AbortController();
    agentAbortCtrl = ac;
    agentRequestContext = { action: 'manual-memory', conversationId };
    btn.disabled = true;
    result.value = '';
    agentMemoryResultText = '';
    status.textContent = 'AI 正在按你的要求生成作品记忆修改稿…';
    try {
      const requestResult = await reviseMemory(getSelectedModel(), ac, {
        onThink() {},
        onContent(text) { if (isAgentRequestCurrent(conversationId)) { agentMemoryResultText = normalizeVisibleNewlines(text); result.value = agentMemoryResultText; } },
        onDone(think, text) { if (isAgentRequestCurrent(conversationId)) { agentMemoryResultText = normalizeVisibleNewlines(text || agentMemoryResultText); result.value = agentMemoryResultText; } },
        onError(message) { if (isAgentRequestCurrent(conversationId)) { status.textContent = `记忆修改失败：${message}`; status.classList.add('error'); } },
        onAbort() { if (isAgentRequestCurrent(conversationId)) status.textContent = '已停止修改；结果未应用。'; },
      }, getChatParams(), instruction, document.getElementById('agentMemoryOperation').value);
      if (!isAgentRequestCurrent(conversationId)) return;
      const success = requestResult?.status === 'success' && agentMemoryResultText.trim();
      document.getElementById('agentDetailApplyMemoryBtn').disabled = !success;
      if (success) status.textContent = '修改稿已生成。请检查或编辑后再应用到作品记忆。';
    } finally {
      if (agentRequestContext?.conversationId === conversationId) { agentAbortCtrl = null; agentRequestContext = null; }
      renderAgentDetail();
    }
  });
  document.getElementById('agentDetailApplyMemoryBtn').addEventListener('click', () => { const text = document.getElementById('agentDetailMemoryResult').value.trim(); if (!text) return; replaceMemory(text); document.getElementById('agentDetailMemory').value = text; agentMemoryResultText = ''; document.getElementById('agentDetailMemoryResult').value = ''; document.getElementById('agentDetailApplyMemoryBtn').disabled = true; document.getElementById('agentDetailMemoryAiStatus').textContent = 'AI 修改稿已应用到作品记忆，临时修改稿已清空。'; renderAgentPage(); renderAgentDetail(); });
  document.getElementById('agentDetailClearMemoryResultBtn').addEventListener('click', () => { agentMemoryResultText = ''; document.getElementById('agentDetailMemoryResult').value = ''; document.getElementById('agentDetailApplyMemoryBtn').disabled = true; document.getElementById('agentDetailMemoryAiStatus').textContent = '记忆修改稿已清除。'; });
  document.getElementById('agentDetailDiscoverMemoryBtn').addEventListener('click', () => { const messages = getActiveConv()?.messages || []; if (!messages.length) { setAgentActionStatus('当前对话还没有正文，暂时无法扫描记忆。', true); return; } runAgentAction('initial-memory'); });
  document.getElementById('agentDetailDraft').addEventListener('input', e => {
    agentDraftText = e.target.value;
    agentDraftUpdatedAt = Date.now();
    agentReviewText = '';
    persistAgentWorkspace();
    renderAgentDetail();
  });
  document.getElementById('agentDetailGenerateBtn').addEventListener('click', () => runAgentAction('generate'));
  document.getElementById('agentDetailApplyDraftBtn').addEventListener('click', applyAgentDraft);
  document.getElementById('agentDetailClearDraftBtn').addEventListener('click', () => {
    if (agentAbortCtrl) return;
    agentDraftText = '';
    agentThinkText = '';
    agentReviewText = '';
    agentDraftTask = '';
    agentDraftUpdatedAt = 0;
    agentExtraction = null;
    agentResultText = '';
    agentCandidatesDraftUpdatedAt = 0;
    document.getElementById('agentDetailDraft').value = '';
    document.getElementById('agentDetailThink').setAttribute('hidden', '');
    updateWritingAgentState({ lastPreflight: '' });
    persistAgentWorkspace();
    renderAgentDetail();
    setAgentActionStatus('续写草稿及其检查和候选已清空。');
    setStatus(true, '续写草稿已清空');
  });
  document.getElementById('agentDetailPreflightBtn').addEventListener('click', () => runAgentAction('preflight'));
  document.getElementById('agentDetailStopBtn')?.addEventListener('click', () => agentAbortCtrl?.abort());
  document.getElementById('agentDetailExtractBtn').addEventListener('click', () => runAgentAction('extract'));
  document.getElementById('agentDetailApplyResultBtn').addEventListener('click', applyAgentResult);
  document.getElementById('agentDetailAddDirectiveBtn').addEventListener('click', () => { const input = document.getElementById('agentDetailDirective'); const text = input.value.trim(); if (!text) return; addDirective(text); input.value = ''; renderAgentDetail(); });
  document.getElementById('agentDetailDirectivesList').addEventListener('change', e => { const id = e.target.dataset.agentDetailDirective; if (id) { toggleDirective(id, e.target.checked); renderAgentDetail(); } });
  document.getElementById('agentDetailDirectivesList').addEventListener('click', async e => {
    const button = e.target.closest('[data-agent-detail-delete]');
    const id = button?.dataset.agentDetailDelete;
    if (!id) return;
    const rule = getWritingAgentState().directives?.find(item => item.id === id);
    const preview = String(rule?.text || '').trim().slice(0, 80);
    const confirmed = await appDialog.confirm(preview ? `是否删除这条长期写作规则？\n\n${preview}${String(rule?.text || '').trim().length > 80 ? '…' : ''}` : '是否删除这条长期写作规则？', { title: '删除长期写作规则', confirmText: '删除' });
    if (!confirmed) return;
    removeDirective(id);
    renderAgentDetail();
    document.getElementById('agentDetailWritingStatus').textContent = '长期写作规则已删除。';
  });
  document.getElementById('agentPromptControls').addEventListener('input', e => { const key = e.target.dataset.agentPromptKey; if (key) updateAgentPrompt(key, e.target.value); });
  document.getElementById('agentPromptTemplates').addEventListener('change', e => { const id = e.target.dataset.agentTemplateToggle; if (id) { togglePromptTemplate(id, e.target.checked); renderAgentDetail(); } });
  document.getElementById('agentPromptTemplates').addEventListener('click', async e => {
    const button = e.target.closest('[data-agent-template-delete]');
    const id = button?.dataset.agentTemplateDelete;
    if (!id) return;
    const template = getAgentPromptSettings().templates.find(item => item.id === id);
    const name = String(template?.name || '未命名风格模板').trim();
    const confirmed = await appDialog.confirm(`是否删除风格模板“${name}”？`, { title: '删除风格模板', confirmText: '删除' });
    if (!confirmed) return;
    removePromptTemplate(id);
    renderAgentDetail();
    document.getElementById('agentPromptStatus').textContent = '风格模板已删除。';
  });
  document.getElementById('agentAddPromptTemplateBtn').addEventListener('click', () => { const name = document.getElementById('agentPromptTemplateName').value.trim(); const text = document.getElementById('agentPromptTemplateText').value.trim(); if (!text) return; addPromptTemplate(name, text); document.getElementById('agentPromptTemplateName').value = ''; document.getElementById('agentPromptTemplateText').value = ''; document.getElementById('agentPromptStatus').textContent = '写作模板已添加。'; renderAgentDetail(); });
  document.getElementById('agentDetailClearResultBtn')?.addEventListener('click', () => {
    if (agentAbortCtrl) return;
    agentResultText = '';
    agentExtraction = null;
    agentCandidatesDraftUpdatedAt = 0;
    persistAgentWorkspace();
    setAgentActionStatus('记忆候选已清空；草稿和检查结果保持不变。');
    renderAgentDetail();
    setStatus(true, '记忆候选已清空');
  });
  document.getElementById('agentDetailModal').addEventListener('focusout', e => {
    const editor = e.target?.matches?.('textarea') ? e.target : null;
    if (!editor) return;
    const normalized = normalizeVisibleNewlines(editor.value);
    if (normalized === editor.value) return;
    editor.value = normalized;
    if (editor.id === 'agentDetailWorldview') updateWritingAgentState({ worldview: normalized });
    else if (editor.id === 'agentDetailMemory') updateWritingAgentState({ memory: normalized });
    else if (editor.id === 'agentDetailDraft') agentDraftText = normalized;
    else if (editor.id === 'agentDetailWorldviewResult') agentWorldviewResultText = normalized;
    else if (editor.id === 'agentDetailMemoryResult') agentMemoryResultText = normalized;
    else if (editor.dataset.agentPromptKey) updateAgentPrompt(editor.dataset.agentPromptKey, normalized);
  });
  document.getElementById('configSelect').addEventListener('change', onConfigChange);
  document.getElementById('modelSelect').addEventListener('change', updateGeminiSettingsVisibility);
  document.getElementById('sendBtn').addEventListener('click', handleSendOrStop);
  document.getElementById('discussionSendBtn').addEventListener('click', () => handleDiscussionSendOrStop('discussionInput'));
  document.getElementById('discussionDetailSendBtn').addEventListener('click', () => handleDiscussionSendOrStop('discussionDetailInput'));
  const bindDiscussionEnter = (id) => document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleDiscussionSendOrStop(id);
    }
  });
  bindDiscussionEnter('discussionInput');
  bindDiscussionEnter('discussionDetailInput');
  document.getElementById('openDiscussionDetailBtn').addEventListener('click', openDiscussionDetail);
  document.getElementById('closeDiscussionDetailBtn').addEventListener('click', closeDiscussionDetail);
  document.getElementById('discussionDetailModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDiscussionDetail();
  });
  document.getElementById('discussionDetailList').addEventListener('click', e => {
    const btn = e.target.closest('[data-discussion-action]');
    if (!btn) return;
    const index = Number(btn.dataset.discussionIndex);
    const action = btn.dataset.discussionAction;
    if (action === 'edit') startDiscussionEdit(index);
    else if (action === 'regenerate') regenerateDiscussion(index);
    else if (action === 'copy') {
      const text = getDiscussionMessages()[index]?.content || '';
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = COPIED_ICON;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 2000);
      }).catch(() => {});
    } else if (action === 'cancel-edit') {
      renderDiscussionMessages('discussionDetailList');
    } else if (action === 'save-edit') {
      const textarea = btn.closest('.discussion-msg')?.querySelector('textarea');
      const text = textarea?.value.trim();
      if (!text || isStreaming || isDiscussionStreaming) return;
      updateDiscussionMessage(index, text);
      truncateDiscussionAfter(index + 1);
      renderDiscussionViews();
      regenerateDiscussionFromUser();
    }
  });
  document.getElementById('mainFontSize').addEventListener('change', e => {
    readingSettings.fontSize = e.target.value;
    persistReadingSettings();
    applyReadingSettings();
  });
  document.getElementById('mainLineHeight').addEventListener('change', e => {
    readingSettings.lineHeight = e.target.value;
    persistReadingSettings();
    applyReadingSettings();
  });
  document.getElementById('showThinking')?.addEventListener('change', e => {
    readingSettings.showThinking = e.target.value === '0' ? '0' : '1';
    persistReadingSettings();
    applyReadingSettings();
  });

  const input = document.getElementById('userInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSendOrStop();
    }
  });
  input.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
  });

  // Sidebar - safe switching on tap; mobile management opens on long press.
  document.getElementById('convList').addEventListener('click', handleConvClick);
  installConversationLongPress();
  document.getElementById('conversationManageOverlay')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeConversationMenu();
  });
  document.getElementById('conversationManageCancelBtn')?.addEventListener('click', closeConversationMenu);
  document.getElementById('conversationManageRenameBtn')?.addEventListener('click', () => {
    const id = conversationMenuId;
    closeConversationMenu();
    if (id) renameConversation(id);
  });
  document.getElementById('conversationManageDeleteBtn')?.addEventListener('click', async () => {
    const id = conversationMenuId;
    const conv = getConversations().find(item => item.id === id);
    if (isStreaming || isDiscussionStreaming || agentAbortCtrl) { setStatus(false, '生成、讨论或创作任务进行中，暂时不能删除会话'); return; }
    if (!id || !conv) return;
    closeConversationMenu();
    const confirmed = await appDialog.confirm(`“${conv.title || '新对话'}”及其讨论和创作资料将被永久删除。`, { title: '删除对话？', confirmText: '删除', danger: true });
    if (!confirmed) return;
    deleteConversation(id);
    loadAgentWorkspace();
    renderConvList();
    renderChatMessages();
    renderDiscussionViews();
    renderAgentPage();
    renderAgentDetail();
  });
  document.getElementById('newChatBtn').addEventListener('click', safeNewChat);

  // Regenerate + Copy + Version nav (delegated from chat area)
  document.getElementById('chatInner').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'regenerate') {
      handleRegenerate();
    } else if (btn.dataset.action === 'copy') {
      const text = btn.dataset.text;
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = COPIED_ICON;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = COPY_ICON;
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {});
    } else if (btn.dataset.action === 'ver-prev' || btn.dataset.action === 'ver-next') {
      if (isStreaming) return;
      try {
        const groups = getAllAiVersionGroups();
        if (!groups.length) return;
        const lastG = groups[groups.length - 1];
        if (!lastG) return;
        const convId = getActiveConvId();
        const cur = getActiveVersion(convId, lastG.start);
        const curIdx = (cur == null || cur < 0 || cur >= lastG.count) ? lastG.count - 1 : cur;
        const delta = btn.dataset.action === 'ver-prev' ? -1 : 1;
        const newIdx = Math.max(0, Math.min(lastG.count - 1, curIdx + delta));
        setActiveVersion(convId, lastG.start, newIdx);
        renderChatMessages();
      } catch(e) { console.error('ver-nav error:', e); }
    } else if (btn.dataset.action === 'ver-cycle') {
      if (isStreaming) return;
      try {
        const groupStart = parseInt(btn.dataset.groupStart, 10);
        const groups = getAllAiVersionGroups();
        const g = groups.find(x => x.start === groupStart);
        if (!g) return;
        const convId = getActiveConvId();
        const cur = getActiveVersion(convId, groupStart);
        const curIdx = (cur == null || cur < 0 || cur >= g.count) ? g.count - 1 : cur;
        setActiveVersion(convId, groupStart, (curIdx + 1) % g.count);
        renderChatMessages();
      } catch(e) { console.error('ver-cycle error:', e); }
    } else if (btn.dataset.action === 'edit') {
      if (isStreaming) return;
      startEditMode(btn);
    } else if (btn.dataset.action === 'edit-ai') {
      openAiMessageEditDialog(parseInt(btn.dataset.rawIdx, 10));
    } else if (btn.dataset.action === 'fork') {
      handleFork(parseInt(btn.dataset.rawIdx, 10));
    } else if (btn.dataset.action === 'revise') {
      openRevisionDialog(parseInt(btn.dataset.rawIdx, 10));
    }
  });

  // Export / Import
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', importData);
  document.getElementById('dataCenterBtn').addEventListener('click', openDataCenter);
  document.getElementById('closeDataCenterBtn').addEventListener('click', closeDataCenter);
  document.getElementById('dataCenterModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeDataCenter(); });
  document.getElementById('refreshDataCenterBtn').addEventListener('click', renderDataCenter);
  document.getElementById('dataCenterConversation').addEventListener('change', switchDataCenterConversation);
  document.getElementById('saveConversationDataBtn').addEventListener('click', saveDataCenterConversation);
  document.getElementById('saveDiscussionDataBtn').addEventListener('click', saveDataCenterDiscussion);
  document.getElementById('saveMemoryDataBtn').addEventListener('click', saveDataCenterMemory);
  document.getElementById('createDataSnapshotBtn').addEventListener('click', createDataSnapshot);
  document.getElementById('dataSnapshotName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createDataSnapshot(); } });
  document.getElementById('dataSnapshotList').addEventListener('click', e => {
    const restoreId = e.target.closest('[data-snapshot-restore]')?.dataset.snapshotRestore;
    const deleteId = e.target.closest('[data-snapshot-delete]')?.dataset.snapshotDelete;
    if (restoreId) restoreDataSnapshot(restoreId);
    else if (deleteId) deleteDataSnapshot(deleteId);
  });
  document.getElementById('clearCurrentConversationBtn').addEventListener('click', clearDataCenterConversation);
  document.getElementById('clearDiscussionDataBtn').addEventListener('click', clearDataCenterDiscussion);
  document.getElementById('clearMemoryDataBtn').addEventListener('click', clearDataCenterMemory);
  document.getElementById('openDataFolderBtn').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/open-data-folder', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '本地服务未启动');
      setStatus(true, `已打开本地数据文件夹：${data.path}`);
    } catch (error) {
      setStatus(false, '请先通过 start.bat 启动本地服务，才能打开数据文件夹');
    }
  });
  document.getElementById('importFile').addEventListener('change', handleImportFile);
  document.getElementById('searchInput').addEventListener('input', e => {
    setSearchQuery(e.target.value);
    renderConvList();
  });

  // Theme picker and AI message editing
  document.getElementById('themeBtn').addEventListener('click', openThemeModal);
  document.getElementById('closeAiMessageEditBtn').addEventListener('click', closeAiMessageEditDialog);
  document.getElementById('cancelAiMessageEditBtn').addEventListener('click', closeAiMessageEditDialog);
  document.getElementById('saveAiMessageEditBtn').addEventListener('click', saveAiMessageEdit);
  document.getElementById('aiMessageEditModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAiMessageEditDialog();
  });
  document.getElementById('aiMessageEditInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveAiMessageEdit();
    }
  });
  document.getElementById('cancelRevisionBtn').addEventListener('click', closeRevisionDialog);
  document.getElementById('submitRevisionBtn').addEventListener('click', submitRevision);
  document.getElementById('revisionModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeRevisionDialog();
  });
  document.getElementById('revisionInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitRevision();
  });
  document.getElementById('closeThemeBtn').addEventListener('click', closeThemeModal);
  document.getElementById('themeModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeThemeModal();
  });
  document.getElementById('themeOptions').addEventListener('click', e => {
    const card = e.target.closest('[data-theme]');
    if (card) applyTheme(card.dataset.theme);
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('configList').addEventListener('click', handleConfigListClick);
  document.getElementById('addConfigBtn').addEventListener('click', addNewConfig);
  document.getElementById('saveConfigBtn').addEventListener('click', saveConfigForm);
  document.getElementById('cancelEditBtn').addEventListener('click', cancelEdit);
  document.getElementById('deleteConfigBtn').addEventListener('click', deleteConfigForm);
  document.getElementById('editApiType').addEventListener('change', e => {
    updateGeminiConfigHint();
    const url = document.getElementById('editUrl');
    if (!url.value.trim() || url.value.trim() === 'https://api.openai.com/v1' || url.value.trim() === 'https://generativelanguage.googleapis.com/v1beta') {
      url.value = e.target.value === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1';
    }
    document.getElementById('editDefaultModel').placeholder = e.target.value === 'gemini' ? '例如：gemini-2.5-flash' : '例如：gpt-4o';
    document.getElementById('editModels').placeholder = e.target.value === 'gemini' ? 'gemini-2.5-flash\ngemini-2.5-pro' : 'gpt-4o\ngpt-4o-mini';
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  updateGeminiConfigHint();
  updateGeminiSettingsVisibility();
}

// Boot — wrap each in try/catch so one failure doesn't kill everything
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
    wireEvents();
  } catch (error) {
    console.error('App startup failed:', error);
    setStatus(false, `本地数据加载失败：${error?.message || '未知错误'}`);
    await appDialog.alert(`无法安全加载本地会话，因此应用没有进入可编辑状态。\n\n${error?.message || '未知错误'}\n\n旧 localStorage 数据仍保留，可在修复后重新迁移。`, { title: '本地数据加载失败' });
  }
});
