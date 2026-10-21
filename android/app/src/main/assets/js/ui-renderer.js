/* ============================================================
   ui-renderer.js — All DOM manipulation and rendering
   ============================================================ */

import { escapeHtml, autoTitle, normalizeVisibleNewlines, splitVisibleLines } from './constants.js';

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L18.8 8.7l-3.5-3.5L4 16.5Z"></path><path d="m14 6 3.5 3.5"></path></svg>',
  aiRevise: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 9.5-9.5"></path><path d="m11.5 8.5 4 4"></path><path d="M17 3l.65 1.85L19.5 5.5l-1.85.65L17 8l-.65-1.85-1.85-.65 1.85-.65L17 3Z"></path><path d="M20 13l.45 1.3 1.3.45-1.3.45L20 16.5l-.45-1.3-1.3-.45 1.3-.45L20 13Z"></path></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  fork: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v6a4 4 0 0 0 4 4h8"></path><path d="m15 11 3 3-3 3"></path><path d="M6 4v16"></path></svg>',
  regenerate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4L3 10"></path><path d="M3 5v5h5"></path><path d="M4 13a8 8 0 0 0 14.7 4L21 14"></path><path d="M21 19v-5h-5"></path></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"></path></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m7 7 1 13h8l1-13"></path><path d="M10 11v5M14 11v5"></path></svg>',
  rename: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5V20h3.5L18.8 8.7l-3.5-3.5L4 16.5Z"></path><path d="m14 6 3.5 3.5"></path></svg>',
  conversation: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h11A2.5 2.5 0 0 1 20 7.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3A2.5 2.5 0 0 1 4 13.5v-6A2.5 2.5 0 0 1 6.5 5Z"></path><path d="M8 9h8M8 12h5"></path></svg>',
  branchConversation: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v8a4 4 0 0 0 4 4h8"></path><path d="m15 13 3 3-3 3"></path><circle cx="6" cy="4" r="1.5"></circle></svg>',
};

let dialogService = null;

export function setDialogService(service) {
  dialogService = service;
}

async function appAlert(message, options = {}) {
  if (dialogService?.alert) return dialogService.alert(message, options);
  console.warn(message);
  return true;
}

async function appConfirm(message, options = {}) {
  if (dialogService?.confirm) return dialogService.confirm(message, options);
  return false;
}

// ---- Markdown rendering ----
function md(text) {
  if (!text) return '';
  try { return marked.parse(escapeHtml(text)); } catch { return escapeHtml(text); }
}

import {
  getConfigs, getActiveConfigId, getActiveConfig,
  getDefaultModel, getActiveModels, ensureConfigs,
  addConfig, updateConfig, deleteConfig, activate as activateConfig,
} from './config-manager.js';
import {
  getSortedConversations, getConversationDepth, getActiveConvId, getActiveConv,
  getActiveMessages, getActiveTitle,
  createConversation, deleteConversation, activateConv,
  ensureConversations, getAiVersionGroup,
  getAllAiVersionGroups, setActiveVersion, getActiveVersion,
} from './conversation-manager.js';

// ---- DOM element cache ----

const $ = (id) => document.getElementById(id);

const dom = {
  sidebar:       $('sidebar'),
  sidebarOverlay:$('sidebarOverlay'),
  convList:      $('convList'),
  configSelect:  $('configSelect'),
  statusDot:     $('statusDot'),
  statusText:    $('statusText'),
  modelSelect:   $('modelSelect'),
  convTitle:     $('convTitleDisplay'),
  chatScroll:    $('chatScroll'),
  chatInner:     $('chatInner'),
  userInput:     $('userInput'),
  sendBtn:       $('sendBtn'),
  settingsModal: $('settingsModal'),
  configList:    $('configList'),
  editForm:      $('editForm'),
  editTitle:     $('editTitle'),
  editName:      $('editName'),
  editApiType:   $('editApiType'),
  editUrl:       $('editUrl'),
  editKey:       $('editKey'),
  editDefault:   $('editDefaultModel'),
  editModels:    $('editModels'),
  deleteBtn:     $('deleteConfigBtn'),
  editUseProxy:  $('editUseProxy'),
  editSamplingMode: $('editSamplingMode'),
};

/** 采样参数发送方式的合法取值与中文名 */
const SAMPLING_MODE_LABELS = {
  auto: '采样参数：自动',
  always: '采样参数：始终发送',
  never: '采样参数：从不发送',
};

function normalizeSamplingMode(value) {
  return Object.prototype.hasOwnProperty.call(SAMPLING_MODE_LABELS, value) ? value : 'auto';
}

// ---- Sidebar ----

export function toggleSidebar() {
  dom.sidebar.classList.toggle('open');
  dom.sidebarOverlay.classList.toggle('show');
}

export function openSidebarIfWide() {
  if (window.innerWidth > 768) {
    dom.sidebar.classList.add('open');
  }
}

// ---- Config select (sidebar footer) ----

export function renderConfigSelect() {
  const configs = getConfigs();
  const activeId = getActiveConfigId();
  dom.configSelect.innerHTML = configs.map(c =>
    `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('') || '<option>无配置</option>';
}

// ---- Model select (top bar) ----

export function renderModelSelect() {
  const models = getActiveModels();
  const def = getDefaultModel();
  if (!models.length) {
    dom.modelSelect.innerHTML = '<option>请先配置</option>';
    dom.modelSelect.disabled = true;
    return;
  }
  dom.modelSelect.disabled = false;
  dom.modelSelect.innerHTML = models.map(m =>
    `<option value="${escapeHtml(m)}" ${m === def ? 'selected' : ''}>${escapeHtml(m)}</option>`
  ).join('');
}

export function getSelectedModel() {
  return dom.modelSelect.value || getDefaultModel();
}

// ---- Status bar ----

export function setStatus(ok, text) {
  dom.statusDot.className = 'status-dot ' + (ok ? 'ok' : 'err');
  dom.statusText.textContent = text;
}

// ---- Conversation list (sidebar) ----

let searchQuery = '';

export function setSearchQuery(q) { searchQuery = q; }

export function renderConvList() {
  const sorted = getSortedConversations();
  const activeId = getActiveConvId();
  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? sorted.filter(c => c.title.toLowerCase().includes(q)) : sorted;
  if (filtered.length === 0) {
    dom.convList.innerHTML = q ? '<div style="padding:12px;font-size:12px;color:var(--text-dim);text-align:center">无匹配对话</div>' : '';
    return;
  }
  const byId = q ? null : new Map(sorted.map(conv => [conv.id, conv]));
  dom.convList.innerHTML = filtered.map(c => {
    const depth = q ? 0 : getConversationDepth(c.id, byId);
    const sourceLabel = c.forkedFrom ? `来自：${escapeHtml(c.forkedFrom.title || '原对话')}` : '';
    return `
    <div class="conv-item ${c.id === activeId ? 'active' : ''} ${depth ? 'is-branch' : ''}" data-conv-id="${c.id}" style="--branch-indent:${Math.min(depth, 3) * 14}px"${sourceLabel ? ` title="${sourceLabel}"` : ''}>
      <span class="conv-icon">${depth ? ICONS.branchConversation : ICONS.conversation}</span>
      <span class="conv-title">${escapeHtml(c.title)}</span>
      ${depth ? '<span class="branch-tag">分支</span>' : ''}
      <button class="conv-rename" data-action="rename" title="重命名" aria-label="重命名对话">${ICONS.rename}</button>
      <button class="conv-delete" data-action="delete" title="删除">${ICONS.delete}</button>
    </div>`;
  }).join('');
}

// ---- Chat messages ----

// ---- Version tracking (for regenerate) ----
let versionOffset = 0; // which version in the group to show (0 = oldest, last = newest)

export function resetVersionOffset() { versionOffset = 0; }
export function setVersionOffset(v) { versionOffset = v; }
export function getVersionOffset() { return versionOffset; }

export function renderChatMessages() {
  const title = getActiveTitle();
  const groups = getAllAiVersionGroups();
  const convId = getActiveConvId();
  const conv = getActiveConv();
  if (!conv) return;

  dom.convTitle.textContent = title;

  // Build the rendered message list using the user's SELECTED version per group
  // (getActiveMessages always returns the latest version, which is wrong for display)
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : null;
  const messages = [];
  const rawIdxMap = []; // rawIdxMap[renderedIdx] = raw message index in conv.messages
  let gI = 0;
  let rawPos = 0;
  for (const m of conv.messages) {
    if (m.role !== 'ai') {
      messages.push(m);
      rawIdxMap.push(rawPos);
      rawPos++;
    } else {
      // Check if this is the start of a group
      const g = groups[gI];
      if (g && m === conv.messages[g.start]) {
        const sel = getActiveVersion(convId, g.start);
        const curOffset = (sel == null || sel < 0 || sel >= g.count) ? (g.count - 1) : sel;
        messages.push(conv.messages[g.start + curOffset]);
        rawIdxMap.push(g.start + curOffset);
        gI++;
      }
      rawPos++; // advance raw position for all AI messages
    }
  }

  if (messages.length === 0) {
    dom.chatInner.innerHTML = `
      <div class="welcome">
        <div class="em">${ICONS.conversation}</div>
        <h1>开始对话</h1>
      </div>`;
    refreshMineNav();
    return scrollToBottom();
  }

  // Re-derive group info per rendered AI message
  let aiCount = 0;
  let html = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      html += `<div class="msg-group">
        <div class="msg user" id="msg-${i}">${escapeHtml(m.content)}</div>
        <div class="action-row">
          <button class="action-btn" data-action="edit" data-raw-idx="${rawIdxMap[i]}" data-render-idx="${i}" title="编辑">${ICONS.edit}</button>
          <button class="action-btn" data-action="fork" data-raw-idx="${rawIdxMap[i]}" title="从此处分叉">${ICONS.fork}</button>
        </div>
      </div>`;
      continue;
    }
    const g = groups[aiCount];
    if (!g) continue;
    const sel = getActiveVersion(convId, g.start);
    const curOffset = (sel == null || sel < 0 || sel >= g.count) ? (g.count - 1) : sel;
    const isLast = lastGroup && g.start === lastGroup.start;
    const isLatest = curOffset === g.count - 1;
    aiCount++;

    let inner = '';
    if (m.reasoning) {
      inner += `<div class="think-block">
        <div class="think-head" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="think-toggle">&#9660;</span> 思考过程
        </div>
        <div class="think-body">${escapeHtml(m.reasoning)}</div>
      </div>`;
    }
    inner += `<div class="msg ai markdown-body">${md(m.content)}</div>`;
    if (m.incomplete === true) {
      const isTailing = rawIdxMap[i] === conv.messages.length - 1 && isLatest;
      inner += `<div class="interrupted-note" role="status">${isTailing ? '生成已中断，可点击“重新生成”重来' : '这是一条未完成的历史回复'}</div>`;
    }
    inner += `<div class="action-row">`;

    if (g.count > 1) {
      if (isLast) {
        const prevDis = curOffset <= 0 ? ' disabled' : '';
        const nextDis = curOffset >= g.count - 1 ? ' disabled' : '';
        inner += `<span class="version-nav">
          <button class="action-btn" data-action="ver-prev"${prevDis} title="上一个版本">${ICONS.prev}</button>
          <span class="ver-label">${curOffset + 1}/${g.count}${isLatest ? ' <span class="latest-tag">当前</span>' : ''}</span>
          <button class="action-btn" data-action="ver-next"${nextDis} title="下一个版本">${ICONS.next}</button>
        </span>`;
      } else {
        inner += `<button class="ver-badge" data-action="ver-cycle" data-group-start="${g.start}" title="点击切换版本">版本 ${curOffset + 1}/${g.count}${isLatest ? ' ·当前' : ''}</button>`;
      }
    }

    inner += `<button class="action-btn" data-action="copy" data-text="${m.content.replace(/"/g, '&quot;').replace(/`/g, '&#96;').replace(/\$/g, '&#36;')}" title="复制" aria-label="复制正文">${ICONS.copy}</button>`;
    inner += `<button class="action-btn" data-action="fork" data-raw-idx="${rawIdxMap[i]}" title="从此处分叉" aria-label="从此处分叉">${ICONS.fork}</button>`;
    inner += `<button class="action-btn" data-action="regenerate" title="重新生成" aria-label="重新生成正文">${ICONS.regenerate}</button>`;
    inner += `<button class="action-btn" data-action="edit-ai" data-raw-idx="${rawIdxMap[i]}" title="手动编辑正文" aria-label="手动编辑正文">${ICONS.edit}</button>`;
    inner += `<button class="action-btn" data-action="revise" data-raw-idx="${rawIdxMap[i]}" title="让 AI 修订正文" aria-label="让 AI 修订正文">${ICONS.aiRevise}</button>`;
    inner += `</div>`;
    html += `<div class="msg-group">${inner}</div>`;
  }

  // 整体重绘会重置滚动位置：贴底时继续贴底，否则尽量停在原处（不回顶部）
  const scrollEl = dom.chatScroll;
  const prevTop = scrollEl ? scrollEl.scrollTop : 0;
  const wasPinned = chatScrollFollower.isPinned();
  dom.chatInner.innerHTML = html;
  if (scrollEl) {
    if (wasPinned) chatScrollFollower.scrollToBottom({ force: true });
    else scrollEl.scrollTop = prevTop;
    chatScrollFollower.setPinned(chatScrollFollower.isAtBottom());
  }
  refreshMineNav();
}

/** During streaming: append placeholder with think + content areas.
 *  Returns { thinkEl, contentEl, group }. */
export function appendAiPlaceholder() {
  const w = dom.chatInner.querySelector('.welcome');
  if (w) w.remove();

  const group = document.createElement('div');
  group.className = 'msg-group streaming-group';

  // Think block (hidden until first reasoning chunk)
  const think = document.createElement('div');
  think.className = 'think-block';
  think.style.display = 'none';
  think.innerHTML = `<div class="think-head">
    <span class="think-toggle">&#9660;</span> 思考中...
  </div><div class="think-body"></div>`;
  group.appendChild(think);

  // Content area
  const content = document.createElement('div');
  content.className = 'msg ai streaming';
  group.appendChild(content);

  dom.chatInner.appendChild(group);
  scrollToBottom();
  return { thinkEl: think.querySelector('.think-body'), thinkBlock: think, contentEl: content, group };
}

/** Show the thinking block during streaming. */
export function showThinkBlock(el) {
  el.style.display = 'block';
}

/** Update thinking text during streaming. */
export function updateThinkText(el, text) {
  el.textContent = text;
  // 思考块自身也只在贴着底部时跟随，方便回看已经生成的部分
  const thinkBody = el.parentElement?.parentElement;
  if (thinkBody && thinkBody.scrollHeight - thinkBody.scrollTop - thinkBody.clientHeight <= 24) {
    thinkBody.scrollTop = thinkBody.scrollHeight;
  }
  scrollToBottom();
}

/** Update streaming content text (with markdown rendering). */
export function updateStreamText(el, text) {
  el.innerHTML = md(text);
  scrollToBottom();
}

/** Finalize a streaming group: convert to clean static DOM for later re-render consistency. */
export function finalizeStreamGroup(group, contentEl) {
  contentEl.classList.remove('streaming');
  // Collapse the think block if it was shown
  const thinkBlock = group.querySelector('.think-block');
  if (thinkBlock && thinkBlock.style.display !== 'none') {
    thinkBlock.classList.add('collapsed');
  }
}

/* ---- 滚动跟随底部 ----
   流式生成时不再无条件把视野拽到底：只有「用户本来就贴着底部」时才自动跟随。
   解除跟随有两条路：
   1) 滚轮/触摸/方向键等**用户意图** → 立刻解除（不等 scroll 事件，
      否则下一个流式分片可能赶在事件之前把视野又拽回去）；
   2) scroll 事件 → 滚回底部附近时自动恢复跟随。 */
export const SCROLL_PIN_THRESHOLD = 48;

/**
 * 给滚动容器装上「跟随底部」逻辑。
 * @returns {{isPinned:Function, setPinned:Function, isAtBottom:Function, scrollToBottom:Function}}
 */
export function createScrollFollower(el, { threshold = SCROLL_PIN_THRESHOLD } = {}) {
  let pinned = true;
  const distanceToBottom = () => (el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0);
  const isAtBottom = () => (el ? distanceToBottom() <= threshold : true);
  const unpinFromUserIntent = () => {
    if (!el) return;
    // 内容本来就没超出可视高度时不必解除，避免误伤
    if (el.scrollHeight - el.clientHeight > threshold) pinned = false;
  };
  if (el) {
    el.addEventListener('scroll', () => { pinned = isAtBottom(); }, { passive: true });
    el.addEventListener('wheel', event => { if (event.deltaY < 0) unpinFromUserIntent(); }, { passive: true });
    el.addEventListener('touchmove', unpinFromUserIntent, { passive: true });
    el.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') unpinFromUserIntent();
    }, { passive: true });
  }
  return {
    isPinned: () => pinned,
    setPinned: value => { pinned = !!value; },
    isAtBottom,
    scrollToBottom({ force = false } = {}) {
      if (!el) return;
      if (!force && !pinned) return;
      el.scrollTop = el.scrollHeight;
      pinned = true;
    },
  };
}

const chatScrollFollower = createScrollFollower(dom.chatScroll, { threshold: SCROLL_PIN_THRESHOLD });

/** 是否正处于「跟随底部」状态（供外部判断是否该强制滚动） */
export function isChatPinnedToBottom() {
  return chatScrollFollower.isPinned();
}

/**
 * 滚到聊天区底部。
 * @param {{force?: boolean}} options  force=true 时无视用户的滚动位置强制跟随
 */
export function scrollToBottom(options = {}) {
  chatScrollFollower.scrollToBottom(options);
}

/**
 * 手动设置「跟随底部」开关。
 * 进入编辑模式、跳转到某条消息这类「用户主动把视野停在某个位置」的场景要解除跟随，
 * 否则下一次流式分片或重绘会把视野又拽回底部。
 */
export function setChatPinned(value) {
  chatScrollFollower.setPinned(value);
}

/* ============================================================
   横竖屏切换时的位置保持
   ============================================================ */

/**
 * 旋转屏幕会让软换行全部重排，同一句文字占的行数都变了 —— 只记住 scrollTop
 * 是没用的，转回来会落到完全不相干的地方。所以记「视口顶部那条消息 + 它距视口
 * 顶边的像素」，旋转后按新布局重新对齐，用户看到的内容基本还在原位。
 */
export function installChatViewportAnchor() {
  const el = dom.chatScroll;
  if (!el) return;
  let anchorEl = null;
  let anchorOffset = 0;
  let anchorRatio = 0;
  let lastWidth = window.innerWidth;
  let frame = 0;

  const capture = () => {
    const groups = dom.chatInner?.children || [];
    const viewTop = el.getBoundingClientRect().top;
    anchorEl = null;
    for (const node of groups) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > viewTop + 8) {
        anchorEl = node;
        anchorOffset = rect.top - viewTop;
        break;
      }
    }
    anchorRatio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
  };
  // 只在滚动时记录。用户不再滚动时视口内容不会变，所以这份锚点一直有效。
  const scheduleCapture = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => { frame = 0; capture(); });
  };

  const restore = () => {
    if (chatScrollFollower.isPinned()) {   // 贴底状态就继续贴底，不用找位置
      chatScrollFollower.scrollToBottom({ force: true });
      return;
    }
    if (anchorEl && anchorEl.isConnected) {
      const viewTop = el.getBoundingClientRect().top;
      el.scrollTop += (anchorEl.getBoundingClientRect().top - viewTop) - anchorOffset;
    } else {
      // 锚点元素被重绘换掉了：退化成按滚动比例还原
      el.scrollTop = anchorRatio * Math.max(1, el.scrollHeight - el.clientHeight);
    }
    scheduleCapture();
  };

  el.addEventListener('scroll', scheduleCapture, { passive: true });
  window.addEventListener('resize', () => {
    // 只有宽度明显变化才算旋转；键盘、地址栏只会改高度
    if (Math.abs(window.innerWidth - lastWidth) < 40) return;
    lastWidth = window.innerWidth;
    restore();
    // 旋转动画期间布局要分几步才稳定，多补两次
    window.setTimeout(restore, 120);
    window.setTimeout(restore, 360);
  }, { passive: true });
  capture();
}

/* ============================================================
   「我的消息」快速定位
   ============================================================ */

let mineNav = null;
let mineRefreshFrame = 0;

function collectMineGroups() {
  if (!dom.chatInner) return [];
  return Array.from(dom.chatInner.children).filter(node => node.querySelector?.('.msg.user'));
}

function refreshMineNav() {
  if (!mineNav) return;
  const groups = collectMineGroups();
  const count = groups.length;
  mineNav.root.hidden = count < 2;
  if (count < 2) return;
  const viewTop = dom.chatScroll.getBoundingClientRect().top;
  let index = -1;
  groups.forEach((node, i) => { if (node.getBoundingClientRect().top <= viewTop + 24) index = i; });
  mineNav.count.textContent = index >= 0 ? `${index + 1}/${count}` : `·/${count}`;
}

function scheduleMineRefresh() {
  if (mineRefreshFrame) return;
  mineRefreshFrame = window.requestAnimationFrame(() => { mineRefreshFrame = 0; refreshMineNav(); });
}

function flashMineGroup(node) {
  node.classList.remove('mine-flash');
  void node.offsetWidth;   // 强制重排，让动画能连续触发
  node.classList.add('mine-flash');
  window.setTimeout(() => node.classList.remove('mine-flash'), 1300);
}

function jumpToMineGroup(direction) {
  const groups = collectMineGroups();
  if (!groups.length) return;
  const scroller = dom.chatScroll;
  const viewTop = scroller.getBoundingClientRect().top;
  let target = null;
  if (direction < 0) {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].getBoundingClientRect().top < viewTop - 8) { target = groups[i]; break; }
    }
    if (!target) target = groups[groups.length - 1];   // 已经在最早一条：回到最新一条
  } else {
    for (const node of groups) {
      if (node.getBoundingClientRect().top > viewTop + 24) { target = node; break; }
    }
    if (!target) target = groups[0];                   // 已经到最后一条：回到最早一条
  }
  chatScrollFollower.setPinned(false);
  scroller.scrollTop += target.getBoundingClientRect().top - viewTop - 12;
  flashMineGroup(target);
  refreshMineNav();
}

/** 装上「我的消息」浮标：显示共几条、当前第几条，点箭头逐条跳 */
export function installMineNavigator() {
  const root = $('mineNav');
  if (!root || !dom.chatScroll) return;
  mineNav = { root, count: $('mineNavCount'), up: $('mineNavUp'), down: $('mineNavDown') };
  mineNav.up?.addEventListener('click', () => jumpToMineGroup(-1));
  mineNav.down?.addEventListener('click', () => jumpToMineGroup(1));
  dom.chatScroll.addEventListener('scroll', scheduleMineRefresh, { passive: true });
  refreshMineNav();
}

// ---- Send button state ----

export function setSendButtonNormal() {
  dom.sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>';
  dom.sendBtn.className = 'send-btn';
  dom.sendBtn.disabled = false;
}

export function setSendButtonStop() {
  dom.sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"></rect></svg>';
  dom.sendBtn.className = 'send-btn stop';
}

// ---- Input ----

export function getInputText() {
  return dom.userInput.value.trim();
}

export function clearInput() {
  dom.userInput.value = '';
  dom.userInput.style.height = 'auto';
}

// ---- Settings modal ----

let editingId = null;

export function openSettings() {
  if (dom.settingsModal.parentElement !== document.documentElement) {
    document.documentElement.appendChild(dom.settingsModal);
  }
  dom.settingsModal.classList.add('show');
  dom.settingsModal.style.setProperty('display', 'flex', 'important');
  dom.settingsModal.style.setProperty('visibility', 'visible', 'important');
  dom.settingsModal.style.setProperty('opacity', '1', 'important');
  renderConfigList();
  cancelEdit();
}

export function closeSettings() {
  dom.settingsModal.classList.remove('show');
  dom.settingsModal.style.removeProperty('display');
  dom.settingsModal.style.removeProperty('visibility');
  dom.settingsModal.style.removeProperty('opacity');
  renderConfigSelect();
  renderModelSelect();
}

function renderConfigList() {
  const configs = getConfigs();
  const activeId = getActiveConfigId();
  dom.configList.innerHTML = configs.map(c => `
    <div class="config-card ${c.id === activeId ? 'active' : ''}" data-config-id="${c.id}">
      <div class="name">${escapeHtml(c.name)}${c.id === activeId ? ' (当前)' : ''}</div>
      <div class="url">${escapeHtml(c.apiType === 'gemini' ? 'Gemini 原生 API' : c.url)}</div>
      <div class="models-info">模型: ${(c.models || []).slice(0, 5).map(model => escapeHtml(model)).join(', ')}${(c.models || []).length > 5 ? '...' : ''}</div>
      <div class="param-hint">${SAMPLING_MODE_LABELS[normalizeSamplingMode(c.samplingMode)]}</div>
    </div>
  `).join('');
}

export function addNewConfig() {
  editingId = '__new__';
  dom.editForm.style.display = 'block';
  dom.editTitle.textContent = '新增配置';
  dom.editName.value = '';
  dom.editApiType.value = 'openai';
  dom.editUrl.value = 'https://api.openai.com/v1';
  document.getElementById('geminiApiHint')?.setAttribute('hidden', '');
  dom.editKey.value = '';
  dom.editDefault.placeholder = '例如：gpt-4o';
  dom.editModels.placeholder = 'gpt-4o\ngpt-4o-mini';
  dom.editDefault.value = 'gpt-4o';
  dom.editModels.value = 'gpt-4o\ngpt-4o-mini';
  dom.editUseProxy.checked = false;
  if (dom.editSamplingMode) dom.editSamplingMode.value = 'auto';
  dom.deleteBtn.style.display = 'none';
}

export function editConfig(id) {
  const cfg = getConfigs().find(c => c.id === id);
  if (!cfg) return;
  editingId = id;
  dom.editForm.style.display = 'block';
  dom.editTitle.textContent = '编辑配置';
  dom.editName.value = cfg.name;
  dom.editApiType.value = cfg.apiType === 'gemini' ? 'gemini' : 'openai';
  dom.editUrl.value = cfg.url;
  const geminiHint = document.getElementById('geminiApiHint');
  if (geminiHint) geminiHint.hidden = cfg.apiType !== 'gemini';
  dom.editKey.value = cfg.key;
  dom.editDefault.placeholder = cfg.apiType === 'gemini' ? '例如：gemini-2.5-flash' : '例如：gpt-4o';
  dom.editModels.placeholder = cfg.apiType === 'gemini' ? 'gemini-2.5-flash\ngemini-2.5-pro' : 'gpt-4o\ngpt-4o-mini';
  dom.editDefault.value = cfg.defaultModel || '';
  dom.editModels.value = (cfg.models || []).map(normalizeVisibleNewlines).join('\n');
  dom.editUseProxy.checked = !!cfg.useProxy;
  if (dom.editSamplingMode) dom.editSamplingMode.value = normalizeSamplingMode(cfg.samplingMode);
  dom.deleteBtn.style.display = getConfigs().length > 1 ? 'inline-block' : 'none';
}

export async function saveConfigForm() {
  const name = dom.editName.value.trim();
  const apiType = dom.editApiType.value === 'gemini' ? 'gemini' : 'openai';
  const url = dom.editUrl.value.trim() || (apiType === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1');
  const key = dom.editKey.value.trim();
  const defaultModel = dom.editDefault.value.trim();
  const models = splitVisibleLines(dom.editModels.value);
  const useProxy = dom.editUseProxy.checked;
  const samplingMode = normalizeSamplingMode(dom.editSamplingMode?.value);

  if (!name) { await appAlert('请输入配置名称。', { title: '配置名称缺失' }); return; }

  const data = { name, apiType, url, key, defaultModel, models, useProxy, samplingMode };

  if (editingId === '__new__') {
    const c = addConfig(data);
    activateConfig(c.id);
  } else {
    updateConfig(editingId, data);
  }

  renderConfigList();
  cancelEdit();
  renderConfigSelect();
  renderModelSelect();
}

export async function deleteConfigForm() {
  if (!editingId) return;
  const configs = getConfigs();
  if (configs.length <= 1) { await appAlert('至少需要保留一个模型配置。', { title: '无法删除配置' }); return; }
  const confirmed = await appConfirm('删除后将无法使用这组 API 与模型设置。', { title: '删除模型配置？', confirmText: '删除', danger: true });
  if (!confirmed) return;

  deleteConfig(editingId);
  renderConfigList();
  cancelEdit();
  renderConfigSelect();
  renderModelSelect();
}

export function cancelEdit() {
  editingId = null;
  dom.editForm.style.display = 'none';
}

// ---- Delegated event helpers ----

/** Handle clicks inside the conversation list. */
export async function handleConvListClick(e) {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  const id = item.dataset.convId;
  if (e.target.closest('[data-action="delete"]')) {
    const confirmed = await appConfirm('删除后，这个对话及其讨论和创作资料将无法恢复。', { title: '删除对话？', confirmText: '删除', danger: true });
    if (!confirmed) return;
    deleteConversation(id);
    renderChatMessages();
    renderConvList();
  } else {
    activateConv(id);
    renderConvList();
    renderChatMessages();
  }
}

/** Handle clicks inside the config list in settings. */
export function handleConfigListClick(e) {
  const card = e.target.closest('.config-card');
  if (!card) return;
  editConfig(card.dataset.configId);
}
