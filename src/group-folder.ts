import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

/**
 * Convert a chat JID (e.g. 'wecom:user123' or 'whatsapp:12345@g.us') to a safe folder name.
 * Format: {channel}_{senderId} where senderId is sanitized to alphanumeric+-_
 * Examples:
 *   - 'wecom:zhangsan' → 'wecom_zhangsan'
 *   - 'whatsapp:12345@g.us' → 'whatsapp_12345_g_us'
 *   - 'telegram:987654321' → 'telegram_987654321'
 */
export function jidToFolderName(chatJid: string): string {
  if (!chatJid) return 'unknown';

  // Parse channel and sender from JID
  const colonIdx = chatJid.indexOf(':');
  if (colonIdx === -1) {
    // No colon, sanitize entire JID
    return sanitizeFolderName(chatJid);
  }

  const channel = chatJid.slice(0, colonIdx);
  const senderId = chatJid.slice(colonIdx + 1);

  // Sanitize sender ID: replace @ . - with underscores, remove other special chars
  const sanitizedSender = senderId
    .replace(/[@.]/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 50); // Limit length

  const folderName = `${channel}_${sanitizedSender}`;
  return sanitizeFolderName(folderName);
}

function sanitizeFolderName(name: string): string {
  // Replace invalid chars with underscores
  let sanitized = name
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .slice(0, 63); // Max 64 chars, leave room for prefix

  // Ensure starts with alphanumeric
  if (!/^[A-Za-z0-9]/.test(sanitized)) {
    sanitized = 'id_' + sanitized;
  }

  return sanitized;
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
