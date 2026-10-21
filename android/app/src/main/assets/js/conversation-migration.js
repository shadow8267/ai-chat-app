/* ============================================================
   conversation-migration.js — One-time localStorage migration
   This module can be removed after legacy installations migrate.
   ============================================================ */

import { KEYS } from './constants.js';
import {
  getAllStoredConversations,
  getContentMetadata,
  replaceAllStoredConversations,
  setContentMetadata,
  getStoredSnapshots,
  putStoredSnapshot,
} from './conversation-store.js';

const MIGRATION_KEY = 'legacy-conversations-v1';
const SNAPSHOT_MIGRATION_KEY = 'legacy-snapshots-v1';
const LEGACY_SNAPSHOT_KEY = 'ai_chat_data_snapshots';

function readLegacyConversations() {
  const raw = localStorage.getItem(KEYS.CONVERSATIONS);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('旧会话数据不是有效数组');
  return parsed;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function conversationSignature(conversation) {
  return JSON.stringify(stableValue(conversation));
}

function verifyMigration(source, stored) {
  if (source.length !== stored.length) {
    throw new Error(`迁移校验失败：会话数量不一致（旧数据 ${source.length}，新数据库 ${stored.length}）`);
  }
  const storedById = new Map(stored.map(item => [item?.id, item]));
  for (const conversation of source) {
    if (!conversation?.id) throw new Error('迁移校验失败：旧会话缺少 ID');
    const copy = storedById.get(conversation.id);
    if (!copy) throw new Error(`迁移校验失败：新数据库缺少会话 ${conversation.id}`);
    if (conversationSignature(conversation) !== conversationSignature(copy)) {
      throw new Error(`迁移校验失败：会话 ${conversation.id} 内容不一致`);
    }
  }
}

async function migrateLegacySnapshotsIfNeeded() {
  const completed = await getContentMetadata(SNAPSHOT_MIGRATION_KEY, null);
  if (completed?.verified === true) return;
  let legacy = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_SNAPSHOT_KEY) || '[]');
    legacy = Array.isArray(parsed) ? parsed : [];
  } catch {
    legacy = [];
  }
  for (const snapshot of legacy) {
    if (snapshot?.id && snapshot?.data) await putStoredSnapshot(snapshot);
  }
  const stored = await getStoredSnapshots();
  const storedIds = new Set(stored.map(item => item.id));
  if (legacy.some(item => item?.id && !storedIds.has(item.id))) {
    throw new Error('旧本地快照迁移校验失败');
  }
  await setContentMetadata(SNAPSHOT_MIGRATION_KEY, {
    verified: true,
    migratedAt: new Date().toISOString(),
    snapshotCount: legacy.length,
  });
}

export async function migrateLegacyConversationsIfNeeded() {
  await migrateLegacySnapshotsIfNeeded();
  const completed = await getContentMetadata(MIGRATION_KEY, null);
  const stored = await getAllStoredConversations();
  if (completed?.verified === true) {
    return { source: 'indexeddb', conversations: stored, migrated: false, verified: true };
  }

  let legacy;
  try {
    legacy = readLegacyConversations();
  } catch (error) {
    if (stored.length) return { source: 'indexeddb', conversations: stored, migrated: false, verified: false, warning: error.message };
    throw error;
  }

  if (!legacy.length) {
    await setContentMetadata(MIGRATION_KEY, {
      verified: true,
      migratedAt: new Date().toISOString(),
      conversationCount: stored.length,
      legacyPresent: false,
    });
    return { source: 'indexeddb', conversations: stored, migrated: false, verified: true };
  }

  // Never remove or rewrite the legacy localStorage value here. It remains a rollback copy.
  await replaceAllStoredConversations(legacy);
  const copied = await getAllStoredConversations();
  verifyMigration(legacy, copied);
  await setContentMetadata(MIGRATION_KEY, {
    verified: true,
    migratedAt: new Date().toISOString(),
    conversationCount: legacy.length,
    legacyPresent: true,
  });
  return { source: 'legacy-migrated', conversations: copied, migrated: true, verified: true };
}
