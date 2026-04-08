/**
 * NanoClaw Agent Runner (one-shot mode)
 *
 * Reads stdin until EOF, processes one command, then exits.
 * Input: { type: 'init', prompt, sessionId?, groupFolder, chatJid, isMain, ... }
 *
 * Output via stdout with markers:
 * ---NANOCLAW_OUTPUT_START---
 * {"status":"success","result":"...","newSessionId":"..."}
 * ---NANOCLAW_OUTPUT_END---
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

// ============================================================================
// Types
// ============================================================================

interface InitInput {
  type: 'init';
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

type ContainerInput = InitInput;

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ============================================================================
// State
// ============================================================================

let currentSessionId: string | undefined;
let currentGroupFolder: string | undefined;
let currentChatJid: string | undefined;
let currentIsMain = false;
let currentAssistantName: string | undefined;
let lastAssistantUuid: string | undefined;

// ============================================================================
// Output
// ============================================================================

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ============================================================================
// Session Management
// ============================================================================

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    return entry?.summary || null;
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Skip invalid lines
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// ============================================================================
// Script Execution
// ============================================================================

const SCRIPT_TIMEOUT_MS = 30_000;

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

// ============================================================================
// Claude Agent SDK Query
// ============================================================================

async function runAgentQuery(prompt: string, input: InitInput): Promise<{ newSessionId?: string; lastUuid?: string }> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Load global CLAUDE.md if not main
  let globalClaudeMd: string | undefined;
  if (!input.isMain) {
    const globalPath = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalPath)) {
      globalClaudeMd = fs.readFileSync(globalPath, 'utf-8');
    }
  }

  // Discover extra directories
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }

  // Build env - filter out undefined values
  const sdkEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
  };

  let newSessionId: string | undefined;
  let lastUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: currentSessionId,
        resumeSessionAt: lastAssistantUuid,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*'
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: sdkEnv,
          }
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(currentAssistantName)] }],
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Result #${resultCount}: ${textResult ? textResult.slice(0, 200) : '(null)'}`);
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: currentSessionId,
      error: errorMessage
    });
  }

  log(`Query complete. Messages: ${messageCount}, Results: ${resultCount}`);
  return { newSessionId, lastUuid };
}

// ============================================================================
// Input Processing
// ============================================================================

async function processInitInput(input: InitInput): Promise<void> {
  currentGroupFolder = input.groupFolder;
  currentChatJid = input.chatJid;
  currentIsMain = input.isMain;
  currentAssistantName = input.assistantName;
  currentSessionId = input.sessionId;
  lastAssistantUuid = undefined;

  log(`Initialized for group: ${input.groupFolder}, chat: ${input.chatJid}`);

  let prompt = input.prompt;

  // Handle scheduled task
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK] ${prompt}`;
  }

  // Run pre-script if present
  if (input.script && input.isScheduledTask) {
    log('Running pre-script...');
    const scriptResult = await runScript(input.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      log('Script decided not to wake agent');
      writeOutput({ status: 'success', result: null });
      return;
    }

    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${input.prompt}`;
  }

  // Run agent
  const result = await runAgentQuery(prompt, input);
  if (result.newSessionId) {
    currentSessionId = result.newSessionId;
  }
  if (result.lastUuid) {
    lastAssistantUuid = result.lastUuid;
  }
}

// ============================================================================
// Main - One-shot execution: read stdin, process, exit
// ============================================================================

async function main(): Promise<void> {
  log('Agent runner started (one-shot mode)');

  // Read all stdin until EOF
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  if (!raw) {
    log('No input received, exiting');
    writeOutput({ status: 'error', result: null, error: 'No input received' });
    return;
  }

  try {
    const input: ContainerInput = JSON.parse(raw);
    if (input.type !== 'init') {
      log(`Unexpected input type: ${input.type}`);
      writeOutput({ status: 'error', result: null, error: `Unexpected input type: ${input.type}` });
      return;
    }
    await processInitInput(input);
  } catch (err) {
    log(`Failed to process input: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
