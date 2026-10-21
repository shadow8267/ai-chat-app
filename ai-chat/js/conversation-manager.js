/* ============================================================
   conversation-manager.js — Conversation state & operations
   ============================================================ */

import { KEYS, generateId, autoTitle, normalizeVisibleNewlines } from './constants.js';
import { loadRaw, saveRaw } from './storage.js';
import {
  enqueueConversationChanges,
  getAllStoredConversations,
  replaceAllStoredConversations,
  waitForConversationWrites,
} from './conversation-store.js';

/** In-memory array loaded from IndexedDB during app startup. */
let conversations = [];
let initialized = false;
let persistedIds = new Set();
let persistedSignatures = new Map();
let lastStorageError = null;

function conversationSignature(conversation) {
  return JSON.stringify(conversation);
}

/** Active conversation ID remains a lightweight localStorage preference. */
let activeConvId = loadRaw(KEYS.ACTIVE_CONV, '');

// ---- Public getters ----

export function getConversations()       { return conversations; }
export function getActiveConvId()        { return activeConvId; }
export function persistConversations()   { return persist(); }
export function isConversationStoreReady() { return initialized; }
export function getConversationStorageError() { return lastStorageError; }

export function setConversationStorageErrorHandler(handler) {
  window.addEventListener('ai-chat-storage-error', event => handler(event.detail));
}

export async function initializeConversations(initialConversations = null) {
  conversations = Array.isArray(initialConversations)
    ? initialConversations
    : await getAllStoredConversations();
  persistedIds = new Set(conversations.map(item => item.id));
  persistedSignatures = new Map(conversations.map(item => [item.id, conversationSignature(item)]));
  initialized = true;
  return conversations;
}

export async function replaceConversations(nextConversations, nextActiveConvId = '') {
  const normalized = Array.isArray(nextConversations) ? structuredClone(nextConversations) : [];
  await replaceAllStoredConversations(normalized);
  conversations = normalized;
  persistedIds = new Set(normalized.map(item => item.id));
  persistedSignatures = new Map(normalized.map(item => [item.id, conversationSignature(item)]));
  initialized = true;
  if (nextActiveConvId) activeConvId = nextActiveConvId;
  else if (!conversations.some(item => item.id === activeConvId)) activeConvId = conversations.at(-1)?.id || '';
  saveRaw(KEYS.ACTIVE_CONV, activeConvId);
  return conversations;
}

export async function flushConversationWrites() {
  if (saveDirty) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await flushPersist();
  }
  await waitForConversationWrites();
}

function defaultWritingWorkspace() {
  return {
    draft: { text: '', reasoning: '', task: '', updatedAt: 0 },
    review: { text: '', draftUpdatedAt: 0, updatedAt: 0 },
    memoryCandidates: null,
  };
}

const WRITING_CONTEXT_MESSAGE_LIMITS = [0, 12, 24, 40, 80];

function normalizeWritingContextMessageLimit(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return 24;
  const numeric = Number(value);
  return WRITING_CONTEXT_MESSAGE_LIMITS.includes(numeric) ? numeric : 24;
}

function defaultWritingAgentState() {
  return {
    schemaVersion: 4,
    // Kept for compatibility with old exports. The workbench is now always available.
    mode: 'agent',
    applyWorldviewToMain: false,
    applyMemoryToMain: false,
    contextMessageLimit: 24,
    worldview: '',
    memory: '',
    directives: [],
    suggestions: [],
    promptAdditions: {},
    promptTemplates: [],
    // Legacy fields remain readable so old exports and synchronized data stay compatible.
    lastPreflight: '',
    lastDraft: '',
    workspace: defaultWritingWorkspace(),
    lastUpdatedAt: 0,
  };
}

function normalizeWritingWorkspace(workspace) {
  const source = workspace && typeof workspace === 'object' ? workspace : {};
  const draft = source.draft && typeof source.draft === 'object' ? source.draft : {};
  const review = source.review && typeof source.review === 'object' ? source.review : {};
  const candidates = source.memoryCandidates && typeof source.memoryCandidates === 'object'
    ? source.memoryCandidates
    : null;
  return {
    draft: {
      text: normalizeVisibleNewlines(draft.text || ''),
      reasoning: normalizeVisibleNewlines(draft.reasoning || ''),
      task: normalizeVisibleNewlines(draft.task || ''),
      updatedAt: Number(draft.updatedAt) || 0,
    },
    review: {
      text: normalizeVisibleNewlines(review.text || ''),
      draftUpdatedAt: Number(review.draftUpdatedAt) || 0,
      updatedAt: Number(review.updatedAt) || 0,
    },
    memoryCandidates: candidates ? {
      source: String(candidates.source || 'draft'),
      data: candidates.data && typeof candidates.data === 'object' ? candidates.data : null,
      sourceDraftUpdatedAt: Number(candidates.sourceDraftUpdatedAt) || 0,
      updatedAt: Number(candidates.updatedAt) || 0,
    } : null,
  };
}

export function getWritingAgentState() {
  const conv = getActiveConv();
  if (!conv) return defaultWritingAgentState();
  if (!conv.writingAgent || typeof conv.writingAgent !== 'object') conv.writingAgent = defaultWritingAgentState();
  if (!Array.isArray(conv.writingAgent.directives)) conv.writingAgent.directives = [];
  if (!Array.isArray(conv.writingAgent.suggestions)) conv.writingAgent.suggestions = [];
  if (!conv.writingAgent.promptAdditions || typeof conv.writingAgent.promptAdditions !== 'object') conv.writingAgent.promptAdditions = {};
  if (!Array.isArray(conv.writingAgent.promptTemplates)) conv.writingAgent.promptTemplates = [];
  if (typeof conv.writingAgent.worldview !== 'string') conv.writingAgent.worldview = '';
  if (typeof conv.writingAgent.memory !== 'string') conv.writingAgent.memory = '';
  conv.writingAgent.worldview = normalizeVisibleNewlines(conv.writingAgent.worldview);
  conv.writingAgent.memory = normalizeVisibleNewlines(conv.writingAgent.memory);
  conv.writingAgent.lastPreflight = normalizeVisibleNewlines(conv.writingAgent.lastPreflight || '');
  conv.writingAgent.lastDraft = normalizeVisibleNewlines(conv.writingAgent.lastDraft || '');
  conv.writingAgent.directives = conv.writingAgent.directives
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item, text: normalizeVisibleNewlines(item.text || '') }));
  conv.writingAgent.promptAdditions = Object.fromEntries(Object.entries(conv.writingAgent.promptAdditions).map(([key, value]) => [key, normalizeVisibleNewlines(value)]));
  conv.writingAgent.promptTemplates = conv.writingAgent.promptTemplates
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item, text: normalizeVisibleNewlines(item.text || '') }));
  conv.writingAgent.workspace = normalizeWritingWorkspace(conv.writingAgent.workspace);
  conv.writingAgent.contextMessageLimit = normalizeWritingContextMessageLimit(conv.writingAgent.contextMessageLimit);
  conv.writingAgent.applyWorldviewToMain = conv.writingAgent.applyWorldviewToMain === true;
  conv.writingAgent.applyMemoryToMain = conv.writingAgent.applyMemoryToMain === true;
  // Old mode values remain readable by older app versions and synchronized clients,
  // but no longer disable or change the capabilities of the creative workbench.
  if (!['off', 'assist', 'agent'].includes(conv.writingAgent.mode)) conv.writingAgent.mode = 'agent';
  conv.writingAgent.schemaVersion = 4;
  return conv.writingAgent;
}

export function updateWritingAgentState(patch = {}) {
  const conv = getActiveConv();
  if (!conv) return defaultWritingAgentState();
  const current = getWritingAgentState();
  const normalizedPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'contextMessageLimit')) {
    normalizedPatch.contextMessageLimit = normalizeWritingContextMessageLimit(normalizedPatch.contextMessageLimit);
  }
  ['applyWorldviewToMain', 'applyMemoryToMain'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, key)) normalizedPatch[key] = normalizedPatch[key] === true;
  });
  ['worldview', 'memory', 'lastPreflight', 'lastDraft'].forEach(key => {
    if (typeof normalizedPatch[key] === 'string') normalizedPatch[key] = normalizeVisibleNewlines(normalizedPatch[key]);
  });
  if (normalizedPatch.workspace && typeof normalizedPatch.workspace === 'object') {
    normalizedPatch.workspace = normalizeWritingWorkspace({ ...current.workspace, ...normalizedPatch.workspace });
  }
  if (Array.isArray(normalizedPatch.directives)) {
    normalizedPatch.directives = normalizedPatch.directives
      .filter(item => item && typeof item === 'object')
      .map(item => ({ ...item, text: normalizeVisibleNewlines(item.text || '') }));
  }
  if (normalizedPatch.promptAdditions && typeof normalizedPatch.promptAdditions === 'object') {
    normalizedPatch.promptAdditions = Object.fromEntries(Object.entries(normalizedPatch.promptAdditions).map(([key, value]) => [key, normalizeVisibleNewlines(value)]));
  }
  if (Array.isArray(normalizedPatch.promptTemplates)) {
    normalizedPatch.promptTemplates = normalizedPatch.promptTemplates
      .filter(item => item && typeof item === 'object')
      .map(item => ({ ...item, text: normalizeVisibleNewlines(item.text || '') }));
  }
  conv.writingAgent = { ...current, ...normalizedPatch, lastUpdatedAt: Date.now() };
  persist();
  return conv.writingAgent;
}

export function getActiveConv() {
  return conversations.find(c => c.id === activeConvId) || null;
}

/** Return conversations in a tree order: each source conversation is followed by its branches. */
export function getSortedConversations() {
  const sorted = [...conversations]; // shallow copy to avoid mutating the module array
  const byId = new Map(sorted.map(conv => [conv.id, conv]));
  const children = new Map();
  const roots = [];

  for (const conv of sorted) {
    const parentId = conv.forkedFrom?.conversationId;
    if (parentId && byId.has(parentId) && parentId !== conv.id) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(conv);
    } else {
      roots.push(conv);
    }
  }

  const newestFirst = (a, b) => b.createdAt - a.createdAt;
  roots.sort(newestFirst);
  for (const list of children.values()) list.sort(newestFirst);

  const result = [];
  const visited = new Set();
  const appendTree = (conv) => {
    if (visited.has(conv.id)) return;
    visited.add(conv.id);
    result.push(conv);
    for (const child of children.get(conv.id) || []) appendTree(child);
  };
  for (const root of roots) appendTree(root);
  for (const conv of sorted.sort(newestFirst)) appendTree(conv);
  return result;
}

/** Return how deeply a conversation is nested below another conversation. */
export function getConversationDepth(id, byId) {
  if (!byId) {
    byId = new Map(conversations.map(conv => [conv.id, conv]));
  }
  const seen = new Set();
  let depth = 0;
  let current = byId.get(id);
  while (current?.forkedFrom?.conversationId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.forkedFrom.conversationId);
    if (current) depth++;
  }
  return depth;
}

// ---- Lifecycle ----

/** Ensure at least one conversation exists. */
export function ensureConversations() {
  if (conversations.length === 0) {
    createConversation(true);
    return;
  }

  let migratedInterruptedMessages = false;
  for (const conversation of conversations) {
    if (!Array.isArray(conversation.messages)) conversation.messages = [];
    for (const message of conversation.messages) {
      if (message?.role !== 'ai' || typeof message.content !== 'string') continue;
      if (/\n\n\[已停止生成\]\s*$/.test(message.content)) {
        message.content = message.content.replace(/\n\n\[已停止生成\]\s*$/, '');
        message.incomplete = true;
        message.stoppedAt = Number(message.stoppedAt) || Date.now();
        migratedInterruptedMessages = true;
      }
    }
  }
  if (migratedInterruptedMessages) persist();
  if (!conversations.find(c => c.id === activeConvId)) {
    activateConv(conversations[conversations.length - 1].id);
  }
}

// ---- CRUD ----

export function createConversation(silent = false) {
  const conv = {
    id: generateId(),
    title: '新对话',
    messages: [],
    discussionMessages: [],
    createdAt: Date.now(),
  };
  conversations.push(conv);
  activateConv(conv.id);
  persist();
  return conv;
}

/**
 * Create an independent conversation from the currently visible message path.
 * The branch keeps a source reference, but messages are cloned so later edits
 * and generations cannot affect its parent conversation.
 */
export function forkConversation(rawMessageIndex, title) {
  const source = getActiveConv();
  if (!source || rawMessageIndex < 0 || rawMessageIndex >= source.messages.length) return null;

  const visibleMessages = getVisibleMessagesThrough(rawMessageIndex);
  if (!visibleMessages.length) return null;

  const sourceTitle = source.title || '新对话';
  const conv = {
    id: generateId(),
    title: title?.trim() || `分支：${sourceTitle}`,
    messages: visibleMessages.map(message => ({ ...message })),
    discussionMessages: (source.discussionMessages || []).map(message => ({ ...message })),
    writingAgent: source.writingAgent ? JSON.parse(JSON.stringify(source.writingAgent)) : undefined,
    createdAt: Date.now(),
    forkedFrom: {
      conversationId: source.id,
      title: sourceTitle,
      messageIndex: rawMessageIndex,
      createdAt: Date.now(),
    },
  };
  conversations.push(conv);
  activateConv(conv.id);
  persist();
  return conv;
}

export function deleteConversation(id) {
  if (conversations.length <= 1) {
    // Don't delete the last one — just clear it
    const conv = conversations[0];
    conv.messages = [];
    conv.discussionMessages = [];
    conv.writingAgent = defaultWritingAgentState();
    conv.title = '新对话';
    conv.createdAt = Date.now();
    delete conv.forkedFrom;
    persist();
    return false; // signal: cleared, not deleted
  }
  // Capture the deleted conversation's parent before removing it
  const deletedConv = conversations.find(c => c.id === id);
  const grandparentId = deletedConv?.forkedFrom?.conversationId;

  conversations = conversations.filter(c => c.id !== id);

  // Promote children of the deleted conversation to its parent, or orphan them
  for (const conv of conversations) {
    if (conv.forkedFrom?.conversationId === id) {
      if (grandparentId) {
        const gp = conversations.find(c => c.id === grandparentId);
        conv.forkedFrom.conversationId = grandparentId;
        conv.forkedFrom.title = gp ? gp.title : (conv.forkedFrom.title || '原对话');
      } else {
        delete conv.forkedFrom;
      }
    }
  }
  if (activeConvId === id) {
    activateConv(conversations[conversations.length - 1].id);
  }
  persist();
  return true;
}

export function activateConv(id) {
  activeConvId = id;
  saveRaw(KEYS.ACTIVE_CONV, id);
}

// ---- Messages ----

/** Append a user message and optionally auto-title. Returns the conversation. */
export function addUserMessage(text) {
  const conv = getActiveConv();
  if (!conv) return null;
  conv.messages.push({ role: 'user', content: text });
  if (conv.title === '新对话') {
    conv.title = autoTitle(text);
  }
  persist();
  return conv;
}

/** Append an AI message, optionally with reasoning and interruption metadata. */
export function addAiMessage(text, reasoning = null, options = {}) {
  const conversationId = options.conversationId || activeConvId;
  const conv = conversations.find(item => item.id === conversationId) || null;
  if (!conv) return -1;
  const msg = { role: 'ai', content: normalizeVisibleNewlines(text || '') };
  if (reasoning) msg.reasoning = normalizeVisibleNewlines(reasoning);
  if (options.incomplete === true) {
    msg.incomplete = true;
    msg.stoppedAt = Number(options.stoppedAt) || Date.now();
  }
  conv.messages.push(msg);
  persist();
  return conv.messages.length - 1;
}

/** Create an empty interrupted AI message before a stream is allowed to finish. */
export function createIncompleteAiMessage(conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  if (!conv) return -1;
  conv.messages.push({ role: 'ai', content: '', incomplete: true, stoppedAt: Date.now() });
  persist();
  return conv.messages.length - 1;
}

/** Remove a streaming AI message that never received usable content. */
export function removeAiMessageAt(index, conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  const message = conv?.messages?.[index];
  if (!message || message.role !== 'ai') return false;
  conv.messages.splice(index, 1);
  persist();
  return true;
}

/** Update a streaming AI message by explicit conversation and raw message index. */
export function updateAiMessageAt(index, content, reasoning = null, options = {}) {
  const conversationId = options.conversationId || activeConvId;
  const conv = conversations.find(item => item.id === conversationId) || null;
  const message = conv?.messages?.[index];
  if (!message || message.role !== 'ai') return false;
  // Streaming chunks skip normalization to avoid O(n^2) regex scans over the
  // growing text; the final write (done/abort) normalizes once.
  message.content = options.skipNormalize === true
    ? String(content || '')
    : normalizeVisibleNewlines(content || '');
  if (reasoning) message.reasoning = normalizeVisibleNewlines(reasoning);
  else if (options.clearReasoning) delete message.reasoning;
  if (options.incomplete === true) {
    message.incomplete = true;
    message.stoppedAt = Number(options.stoppedAt) || Date.now();
  } else if (options.incomplete === false) {
    delete message.incomplete;
    delete message.stoppedAt;
  }
  persist();
  return true;
}

// ---- Discussion messages (stored separately from the story chat) ----

export function getDiscussionMessages(conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  if (!conv) return [];
  if (!Array.isArray(conv.discussionMessages)) conv.discussionMessages = [];
  return conv.discussionMessages;
}

export function addDiscussionMessage(role, text, reasoning = null, conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  if (!conv) return false;
  if (!Array.isArray(conv.discussionMessages)) conv.discussionMessages = [];
  const msg = { role, content: text };
  if (reasoning) msg.reasoning = reasoning;
  conv.discussionMessages.push(msg);
  persist();
  return true;
}

export function updateDiscussionMessage(index, text, reasoning = null, conversationId = activeConvId) {
  const messages = getDiscussionMessages(conversationId);
  if (index < 0 || index >= messages.length) return false;
  messages[index].content = text;
  if (reasoning) messages[index].reasoning = reasoning;
  else delete messages[index].reasoning;
  persist();
  return true;
}

/** Remove all discussion messages after (and including) startIndex. */
export function truncateDiscussionAfter(startIndex, conversationId = activeConvId) {
  const messages = getDiscussionMessages(conversationId);
  if (startIndex < 0 || startIndex > messages.length) return;
  messages.splice(startIndex);
  persist();
}

/** Get messages for the API — always the latest version of each AI group.
 *  Previous versions are kept in storage for viewing, but never sent to the API. */
export function getActiveMessages(conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  if (!conv) return [];

  const result = [];
  let i = 0;
  while (i < conv.messages.length) {
    const message = conv.messages[i];
    if (message.role !== 'ai') {
      result.push(message);
      i++;
    } else {
      while (i < conv.messages.length && conv.messages[i].role === 'ai') i++;
      result.push(conv.messages[i - 1]);
    }
  }
  return result;
}

/**
 * Build the currently visible path through a raw message index for a fork.
 * Consecutive AI messages are alternate generations, so only the selected
 * generation is copied into the new, independent conversation.
 */
export function getVisibleMessagesThrough(rawMessageIndex) {
  const conv = getActiveConv();
  if (!conv || rawMessageIndex < 0) return [];

  const result = [];
  const selectedVersions = aiSelections.get(conv.id);
  let i = 0;
  while (i <= rawMessageIndex && i < conv.messages.length) {
    const message = conv.messages[i];
    if (message.role !== 'ai') {
      result.push(message);
      i++;
      continue;
    }

    const groupStart = i;
    while (i < conv.messages.length && conv.messages[i].role === 'ai') i++;
    const groupEnd = i - 1;
    const visibleEnd = Math.min(groupEnd, rawMessageIndex);
    const groupCount = visibleEnd - groupStart + 1;
    const selection = selectedVersions?.get(groupStart);
    const offset = selection != null && selection >= 0 && selection < groupCount ? selection : groupCount - 1;
    result.push(conv.messages[groupStart + offset]);
  }
  return result;
}

// ---- AI version selection (in-memory, view-only — does NOT affect API context) ----
const aiSelections = new Map(); // convId -> Map<groupStart, offset>

export function setActiveVersion(convId, groupStart, offset) {
  if (!convId) return;
  if (!aiSelections.has(convId)) aiSelections.set(convId, new Map());
  aiSelections.get(convId).set(groupStart, offset);
}

export function getActiveVersion(convId, groupStart) {
  const map = aiSelections.get(convId);
  if (!map || !map.has(groupStart)) return -1;
  return map.get(groupStart);
}

/** Find all AI version groups: [{ start, count, userMsgIdx }, ...] */
export function getAllAiVersionGroups() {
  const conv = getActiveConv();
  if (!conv) return [];
  const groups = [];
  let i = 0;
  while (i < conv.messages.length) {
    if (conv.messages[i].role === 'ai') {
      const start = i;
      const userMsgIdx = start - 1;
      let count = 0;
      while (i < conv.messages.length && conv.messages[i].role === 'ai') {
        count++; i++;
      }
      groups.push({ start, count, userMsgIdx });
    } else {
      i++;
    }
  }
  return groups;
}

/** Get the title of the active conversation. */
export function getActiveTitle() {
  const conv = getActiveConv();
  return conv?.title || '新对话';
}

/** Update message content at given index (0-based in conv.messages). */
export function updateMessage(index, content) {
  const conv = getActiveConv();
  if (!conv || index < 0 || index >= conv.messages.length) return;
  conv.messages[index].content = content;
  persist();
}

/** Manually replace one stored AI version in place without changing later messages. */
export function updateAiMessage(index, content, options = {}) {
  const conv = getActiveConv();
  const message = conv?.messages?.[index];
  const normalized = normalizeVisibleNewlines(content || '').trim();
  if (!message || message.role !== 'ai' || !normalized) return false;
  message.content = normalized;
  if (options.markComplete !== false) {
    delete message.incomplete;
    delete message.stoppedAt;
  }
  persist();
  return true;
}

/** Replace an interrupted AI response in place after continuation succeeds or stops again. */
export function updateIncompleteAiMessage(index, content, reasoning = null, incomplete = false, conversationId = activeConvId) {
  const conv = conversations.find(item => item.id === conversationId) || null;
  const message = conv?.messages?.[index];
  if (!message || message.role !== 'ai') return false;
  message.content = normalizeVisibleNewlines(content || '');
  if (reasoning) message.reasoning = normalizeVisibleNewlines(reasoning);
  else delete message.reasoning;
  if (incomplete) {
    message.incomplete = true;
    message.stoppedAt = Date.now();
  } else {
    delete message.incomplete;
    delete message.stoppedAt;
  }
  persist();
  return true;
}

/** Insert a revised AI response into the same contiguous AI version group. */
export function addAiVersion(index, text, reasoning = null) {
  const conv = getActiveConv();
  if (!conv || index < 0 || index >= conv.messages.length || conv.messages[index].role !== 'ai') return -1;
  let end = index + 1;
  while (end < conv.messages.length && conv.messages[end].role === 'ai') end++;
  const message = { role: 'ai', content: text };
  if (reasoning) message.reasoning = reasoning;
  conv.messages.splice(end, 0, message);
  persist();
  return end;
}

/** Remove all messages after (and including) startIndex. */
export function truncateAfter(startIndex) {
  const conv = getActiveConv();
  if (!conv || startIndex < 0 || startIndex > conv.messages.length) return;
  conv.messages.splice(startIndex);
  persist();
}

/** Remove the last AI message from the active conversation. Returns true if removed. */
export function removeLastAiMessage() {
  const conv = getActiveConv();
  if (!conv) return false;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'ai') {
      conv.messages.splice(i, 1);
      persist();
      return true;
    }
  }
  return false;
}

/** Get { start, count } of consecutive AI messages at the end (regeneration versions). */
export function getAiVersionGroup() {
  const conv = getActiveConv();
  if (!conv || conv.messages.length === 0) return { start: -1, count: 0 };
  let end = conv.messages.length - 1;
  let count = 0;
  while (end >= 0 && conv.messages[end].role === 'ai') { count++; end--; }
  return { start: end + 1, count };
}

/** Keep only the active version among consecutive AI messages at the end. */
export function keepAiVersion(activeGlobalIdx) {
  const conv = getActiveConv();
  if (!conv) return;
  const msgs = conv.messages;
  // Find last user message index
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return;
  // All AI messages after lastUserIdx are versions; remove all except activeGlobalIdx
  const toKeep = [];
  for (let i = lastUserIdx + 1; i < msgs.length; i++) {
    if (i === activeGlobalIdx) toKeep.push(msgs[i]);
  }
  msgs.splice(lastUserIdx + 1, msgs.length - lastUserIdx - 1, ...toKeep);
  persist();
}

// ---- Internal ----

const SAVE_DEBOUNCE_MS = 150;
let saveTimer = null;
let saveDirty = false;
let saveWaiters = [];

function persist() {
  if (!initialized) {
    const error = new Error('会话数据库尚未初始化，已阻止未持久化修改');
    reportStorageError(error);
    const rejected = Promise.reject(error);
    rejected.catch(() => {});
    return rejected;
  }
  saveDirty = true;
  const waiter = new Promise((resolve, reject) => {
    saveWaiters.push({ resolve, reject });
  });
  // Swallow rejections for fire-and-forget callers; real errors surface via the
  // storage-error event and the status bar. Awaiting callers still see failures.
  waiter.catch(() => {});
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersist();
    }, SAVE_DEBOUNCE_MS);
  }
  return waiter;
}

async function flushPersist() {
  const waiters = saveWaiters;
  saveWaiters = [];
  if (!saveDirty) {
    waiters.forEach(item => item.resolve());
    return;
  }
  saveDirty = false;
  const currentIds = new Set(conversations.map(item => item.id));
  const deletedIds = [...persistedIds].filter(id => !currentIds.has(id));
  const nextSignatures = new Map();
  const changedIds = new Set();
  for (const conversation of conversations) {
    const signature = conversationSignature(conversation);
    nextSignatures.set(conversation.id, signature);
    if (persistedSignatures.get(conversation.id) !== signature) changedIds.add(conversation.id);
  }
  try {
    const pending = enqueueConversationChanges(conversations, changedIds, deletedIds);
    await pending;
    persistedIds = currentIds;
    persistedSignatures = nextSignatures;
    lastStorageError = null;
    window.dispatchEvent(new CustomEvent('ai-chat-conversations-changed'));
    waiters.forEach(item => item.resolve());
  } catch (error) {
    // Keep the last confirmed signatures so the next mutation retries this write.
    reportStorageError(error);
    waiters.forEach(item => item.reject(error));
  }
}

function reportStorageError(error) {
  lastStorageError = error instanceof Error ? error : new Error(String(error || '会话保存失败'));
  console.error('IndexedDB conversation write failed:', lastStorageError);
  window.dispatchEvent(new CustomEvent('ai-chat-storage-error', { detail: lastStorageError }));
}
