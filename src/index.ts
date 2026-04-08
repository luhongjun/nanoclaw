import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { OneCLI } from '@onecli-sh/sdk';

// ES module dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────
// Single-instance protection (pidfile)
// ─────────────────────────────────────────────────────────────
const PIDFILE = path.join(__dirname, '../nanoclaw.pid');

function checkSingleInstance(): void {
  if (fs.existsSync(PIDFILE)) {
    const oldPidStr = fs.readFileSync(PIDFILE, 'utf-8').trim();
    const oldPid = parseInt(oldPidStr, 10);
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0);
        console.error(
          `[FATAL] Another instance is already running (PID: ${oldPid}).`,
          'If this is a stale pidfile, remove it manually:',
          PIDFILE,
        );
        process.exit(1);
      } catch {
        logger.warn({ stalePid: oldPid }, 'Found stale pidfile, removing');
        try {
          fs.unlinkSync(PIDFILE);
        } catch {}
      }
    }
  }
}

function writePidFile(): void {
  try {
    fs.writeFileSync(PIDFILE, process.pid.toString(), 'utf-8');
    logger.info({ pid: process.pid, pidfile: PIDFILE }, 'PID file written');
  } catch (err) {
    logger.warn({ err }, 'Failed to write pidfile');
  }
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PIDFILE)) {
      const existingPid = fs.readFileSync(PIDFILE, 'utf-8').trim();
      if (existingPid === process.pid.toString()) {
        fs.unlinkSync(PIDFILE);
        logger.info('PID file cleaned up');
      }
    }
  } catch {}
}

process.on('exit', cleanupPidFile);
process.on('SIGINT', () => { cleanupPidFile(); process.exit(); });
process.on('SIGTERM', () => { cleanupPidFile(); process.exit(); });
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { cleanupPidFile(); process.exit(); });
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  cleanupPidFile();
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  cleanupPidFile();
  process.exit(1);
});

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import { getChannelFactory, getRegisteredChannelNames } from './channels/registry.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { restoreRemoteControl, startRemoteControl, stopRemoteControl } from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export { escapeXml, formatMessages } from './router.js';

// State
let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const onecli = new OneCLI({ url: ONECLI_URL });

// Processing lock per chat to prevent concurrent processing
const processingLocks = new Map<string, Promise<void>>();

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => logger.info({ jid, identifier, created: res.created }, 'OneCLI agent ensured'),
    (err) => logger.debug({ jid, identifier, err: String(err) }, 'OneCLI agent ensure skipped'),
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info({ chatJid, recoveredFrom: botTs }, 'Recovered message cursor from last bot reply');
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(GROUPS_DIR, group.isMain ? 'main' : 'global', 'CLAUDE.md');
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  ensureOneCLIAgent(jid, group);
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process messages for a group: spawn container, stream output, destroy container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Get pending messages
  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor before processing
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  // Show typing indicator
  await channel.setTyping?.(chatJid, true);

  let hadError = false;
  let outputSentToUser = false;

  try {
    // Write snapshots for container
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMainGroup,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMainGroup,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    // Run container agent — one-shot, container destroyed on completion
    const result = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: sessions[chatJid],
        groupFolder: group.folder,
        chatJid,
        isMain: isMainGroup,
        assistantName: ASSISTANT_NAME,
      },
      () => {}, // onProcess: no special handling needed
      async (output) => {
        // Stream each result to the user immediately
        if (output.newSessionId) {
          sessions[chatJid] = output.newSessionId;
          setSession(chatJid, output.newSessionId, group.folder);
        }
        if (output.result) {
          const raw = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
          if (text) {
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
          }
        }
        if (output.status === 'error') {
          hadError = true;
          logger.error({ group: group.name, error: output.error }, 'Container error');
        }
      },
    );

    // Handle final status if not already sent
    if (!outputSentToUser) {
      if (result.status === 'error') {
        hadError = true;
        logger.error({ group: group.name, error: result.error }, 'Container final error');
      }
      // success with null result = no output produced, nothing to send
    }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Error processing messages');
    hadError = true;
  } finally {
    await channel.setTyping?.(chatJid, false);
  }

  // Handle error - rollback cursor if needed
  if (hadError && !outputSentToUser) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Rolled back message cursor for retry');
    return false;
  }

  return true;
}

/**
 * Message loop - simplified with ContainerManager
 */
async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        lastTimestamp = newTimestamp;
        saveState();

        // Group messages by chat
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        // Process each group
        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) continue;

          // Trigger check disabled - all groups can message directly
          // const isMainGroup = group.isMain === true;
          // const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
          // if (needsTrigger) { ... }

          // Check if already processing this chat
          const existingLock = processingLocks.get(chatJid);
          if (existingLock) {
            logger.debug({ chatJid }, 'Already processing, will queue messages');
            continue;
          }

          // Start processing (non-blocking)
          const lockPromise = processGroupMessages(chatJid).then(() => {
            processingLocks.delete(chatJid);
          }).catch((err) => {
            logger.error({ chatJid, err }, 'Processing error');
            processingLocks.delete(chatJid);
          });

          processingLocks.set(chatJid, lockPromise);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(chatJid, getOrRecoverCursor(chatJid), ASSISTANT_NAME, MAX_MESSAGES_PER_PROMPT);
    if (pending.length > 0) {
      logger.info({ group: group.name, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
      // Trigger processing for pending messages
      const lockPromise = processGroupMessages(chatJid).then(() => {
        processingLocks.delete(chatJid);
      }).catch((err) => {
        logger.error({ chatJid, err }, 'Recovery processing error');
        processingLocks.delete(chatJid);
      });
      processingLocks.set(chatJid, lockPromise);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  checkSingleInstance();
  writePidFile();

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Remote control handler
  async function handleRemoteControl(command: string, chatJid: string, msg: NewMessage): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn({ chatJid, sender: msg.sender }, 'Remote control rejected: not main group');
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(msg.sender, chatJid, process.cwd());
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(chatJid, `Remote Control failed: ${result.error}`);
      }
    } else {
      const result = stopRemoteControl();
      await channel.sendMessage(chatJid, result.ok ? 'Remote Control session ended.' : result.error);
    }
  }

  // Channel callbacks
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
          if (cfg.logDenied) {
            logger.debug({ chatJid, sender: msg.sender }, 'Dropping message (drop mode)');
          }
          return;
        }
      }

      storeMessage(msg);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Connect channels
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn({ channel: channelName }, 'Channel credentials missing, skipping');
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start scheduler
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue: {
      enqueueTask: (chatJid: string, _taskId: string, fn: () => Promise<void>) => {
        fn().catch((err) => logger.error({ chatJid, err }, 'Scheduled task error'));
      },
    },
    onProcess: () => {},
    sendMessage: async (jid: string, rawText: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });

  // Start IPC watcher
  startIpcWatcher({
    sendMessage: (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(force)));
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed');
    process.exit(1);
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
