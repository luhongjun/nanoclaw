# Claude Agent SDK 深度剖析

逆向工程 `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 的发现，以了解 `query()` 如何工作，为什么 agent 团队子 agent 被杀死，以及如何修复。补充官方 SDK 参考文档。

## 架构

```
Agent Runner（我们的代码）
  └── query() → SDK (sdk.mjs)
        └── 生成 CLI 子进程 (cli.js)
              └── Claude API 调用，工具执行
              └── Task 工具 → 生成子 agent 子进程
```

SDK 生成 `cli.js` 作为子进程，带有 `--output-format stream-json --input-format stream-json --print --verbose` 标志。通信通过 stdin/stdout JSON-lines 进行。

`query()` 返回扩展 `AsyncGenerator<SDKMessage, void>` 的 `Query` 对象。内部：

- SDK 生成 CLI 作为子进程，通过 stdin/stdout JSON-lines 通信
- SDK 的 `readMessages()` 从 CLI stdout 读取，入队到内部流
- `readSdkMessages()` 异步生成器从该流产生
- `[Symbol.asyncIterator]` 返回 `readSdkMessages()`
- 迭代器仅在 CLI 关闭 stdout 时返回 `done: true`

V1（`query()`）和 V2（`createSession`/`send`/`stream`）都使用完全相同的三层架构：

```
SDK (sdk.mjs)           CLI 进程 (cli.js)
--------------          --------------------
XX Transport  ------>   stdin 读取器 (bd1)
  (生成 cli.js)            |
$X Query      <------   stdout 写入器
  (JSON-lines)             |
                        EZ() 递归生成器
                           |
                        Anthropic Messages API
```

## 核心 Agent 循环 (EZ)

在 CLI 内部，代理循环是一个**名为 `EZ()` 的递归异步生成器**，不是迭代 while 循环：

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

每次调用 = 一次对 Claude 的 API 调用（一次"回合"）。

### 每回合流程：

1. **准备消息** — 修剪上下文，运行压缩（如果需要）
2. **调用 Anthropic API**（通过 `mW1` 流式函数）
3. **从响应中提取 tool_use 块**
4. **分支：**
   - 如果**无 tool_use 块** → 停止（运行停止钩子，返回）
   - 如果**存在 tool_use 块** → 执行工具，增加 turnCount，递归

所有复杂逻辑 — agent 循环、工具执行、后台任务、队友编排 — 都在 CLI 子进程内运行。`query()` 是一个薄的传输包装器。

## query() 选项

来自官方文档的完整 `Options` 类型：

| 属性 | 类型 | 默认值 | 描述 |
|----------|------|---------|-------------|
| `abortController` | `AbortController` | `new AbortController()` | 用于取消操作的控制器 |
| `additionalDirectories` | `string[]` | `[]` | Claude 可以访问的额外目录 |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | 以编程方式定义子 agent（不是 agent 团队 — 无编排） |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | 使用 `permissionMode: 'bypassPermissions'` 时必需 |
| `allowedTools` | `string[]` | 所有工具 | 允许的工具名称列表 |
| `betas` | `SdkBeta[]` | `[]` | 测试功能（例如 `['context-1m-2025-08-07']` 用于 1M 上下文） |
| `canUseTool` | `CanUseTool` | `undefined` | 用于工具使用的自定义权限函数 |
| `continue` | `boolean` | `false` | 继续最近的对话 |
| `cwd` | `string` | `process.cwd()` | 当前工作目录 |
| `disallowedTools` | `string[]` | `[]` | 不允许的工具名称列表 |
| `enableFileCheckpointing` | `boolean` | `false` | 启用文件更改跟踪以回滚 |
| `env` | `Dict<string>` | `process.env` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自动检测 | JavaScript 运行时 |
| `fallbackModel` | `string` | `undefined` | 如果主用失败则使用的模型 |
| `forkSession` | `boolean` | `false` | 恢复时，fork 到新的会话 ID 而不是继续原始 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | 事件钩子回调 |
| `includePartialMessages` | `boolean` | `false` | 包含部分消息事件（流式） |
| `maxBudgetUsd` | `number` | `undefined` | 查询的最大预算（USD） |
| `maxThinkingTokens` | `number` | `undefined` | 思考过程的最大令牌数 |
| `maxTurns` | `number` | `undefined` | 最大对话回合数 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP 服务器配置 |
| `model` | `string` | CLI 默认 | 使用的 Claude 模型 |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 结构化输出格式 |
| `pathToClaudeCodeExecutable` | `string` | 使用内置 | Claude Code 可执行文件的路径 |
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `plugins` | `SdkPluginConfig[]` | `[]` | 从本地路径加载自定义插件 |
| `resume` | `string` | `undefined` | 恢复的会话 ID |
| `resumeSessionAt` | `string` | `undefined` | 在特定消息 UUID 恢复会话 |
| `sandbox` | `SandboxSettings` | `undefined` | 沙盒行为配置 |
| `settingSources` | `SettingSource[]` | `[]`（无） | 加载哪些文件系统设置。必须包括 `'project'` 才能加载 CLAUDE.md |
| `stderr` | `(data: string) => void` | `undefined` | stderr 输出的回调 |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | 系统提示。使用 preset 获取 Claude Code 的提示，可选 `append` |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | 工具配置 |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json（版本控制）
// 'local'   → .claude/settings.local.json（git 忽略）
```

当省略时，SDK 不加载任何文件系统设置（默认隔离）。优先级：local > project > user。程序选项总是覆盖文件系统设置。

### AgentDefinition

编程子 agent（不是 agent 团队 — 这些更简单，无 agent 间协调）：

```typescript
type AgentDefinition = {
  description: string;  // 何时使用此 agent
  tools?: string[];     // 允许的工具（省略时继承所有）
  prompt: string;       // agent 的系统提示
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // 进程内
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// 为 Opus 4.6、Sonnet 4.5、Sonnet 4 启用 1M 令牌上下文窗口
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage 类型

`query()` 可以产生 16 种消息类型。官方文档显示 7 种的简化联合，但 `sdk.d.ts` 有完整集合：

| 类型 | 子类型 | 用途 |
|------|---------|---------|
| `system` | `init` | 会话初始化，包含 session_id、工具、模型 |
| `system` | `task_notification` | 后台 agent 完成/失败/停止 |
| `system` | `compact_boundary` | 对话被压缩 |
| `system` | `status` | 状态更改（例如压缩） |
| `system` | `hook_started` | 钩子执行开始 |
| `system` | `hook_progress` | 钩子进度输出 |
| `system` | `hook_response` | 钩子完成 |
| `system` | `files_persisted` | 文件已保存 |
| `assistant` | — | Claude 的响应（文本 + 工具调用） |
| `user` | — | 用户消息（内部） |
| `user` (replay) | — | 恢复时重放的用户消息 |
| `result` | `success` / `error_*` | 提示处理回合的最终结果 |
| `stream_event` | — | 部分流式传输（当 includePartialMessages） |
| `tool_progress` | — | 长时间运行工具的进度 |
| `auth_status` | — | 认证状态更改 |
| `tool_use_summary` | — | 前面工具使用的摘要 |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

两种变体共享字段：

```typescript
// 共享字段：
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 成功：
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...共享字段
};

// 错误：
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...共享字段
};
```

结果上有用的字段：`total_cost_usd`、`duration_ms`、`num_turns`、`modelUsage`（每个模型的分项 `costUSD`、`inputTokens`、`outputTokens`、`contextWindow`）。

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // 来自 Anthropic SDK
  parent_tool_use_id: string | null; // 当来自子 agent 时非空
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## 回合行为：Agent 停止与继续

### 当 Agent 停止时（不再进行 API 调用）

**1. 响应中无 tool_use 块（主要情况）**

Claude 仅用文本响应 — 它决定已完成任务。API 的 `stop_reason` 将是 `"end_turn"`。SDK 不做这个决定 — 它完全由 Claude 的模型输出驱动。

**2. 超过最大回合数** — 结果为 `SDKResultError`，子类型 `"error_max_turns"`。

**3. 中止信号** — 用户通过 `abortController` 中断。

**4. 预算超限** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`。

**5. 停止钩子阻止继续** — 钩子返回 `{preventContinuation: true}`。

### 当 Agent 继续时（进行另一次 API 调用）

**1. 响应包含 tool_use 块（主要情况）** — 执行工具，增加 turnCount，递归到 EZ。

**2. max_output_tokens 恢复** — 最多 3 次重试，带有"将工作分解成更小的部分"的上下文消息。

**3. 停止钩子阻止错误** — 错误作为上下文消息反馈，循环继续。

**4. 模型回退** — 用回退模型重试（一次性）。

### 决策表

| 条件 | 操作 | 结果类型 |
|-----------|--------|-------------|
| 响应有 `tool_use` 块 | 执行工具，递归到 `EZ` | 继续 |
| 响应无 `tool_use` 块 | 运行停止钩子，返回 | `success` |
| `turnCount > maxTurns` | 产生 max_turns_reached | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | 产生预算错误 | `error_max_budget_usd` |
| `abortController.signal.aborted` | 产生中断消息 | 取决于上下文 |
| `stop_reason === "max_tokens"` (输出) | 最多重试 3 次，恢复提示 | 继续 |
| 停止钩子 `preventContinuation` | 立即返回 | `success` |
| 停止钩子阻止错误 | 反馈错误，递归 | 继续 |
| 模型回退错误 | 用回退模型重试（一次性） | 继续 |

## 子 Agent 执行模式

### 情况 1：同步子 agent（`run_in_background: false`）— 阻塞

父 agent 调用 Task 工具 → `VR()` 为子 agent 运行 `EZ()` → 父等待完整结果 → 工具结果返回给父 → 父继续。

子 agent 运行完整的递归 EZ 循环。父的工具执行通过 `await` 挂起。有一个执行中的"提升"机制：同步子 agent 可以通过 `Promise.race()` 对抗 `backgroundSignal` 承诺提升到后台。

### 情况 2：后台任务（`run_in_background: true`）— 不等待

- **Bash 工具：** 命令生成，工具立即返回空结果 + `backgroundTaskId`
- **Task/Agent 工具：** 子 agent 在即发即忘包装器中启动（`g01()`），工具立即返回 `status: "async_launched"` + `outputFile` 路径

在发出 `type: "result"` 消息之前，零"等待后台任务"逻辑。当后台任务完成时，单独发出 `SDKTaskNotificationMessage`。

### 情况 3：Agent 团队（TeammateTool / SendMessage）— 先结果，后轮询

团队领导者运行其正常的 EZ 循环，包括生成队友。当领导者的 EZ 循环结束时，发出 `type: "result"`。然后领导者进入结果后轮询循环：

```javascript
while (true) {
    // 检查是否无活动队友 AND 无运行任务 → 中断
    // 检查队友的未读消息 → 重新注入为新提示，重启 EZ 循环
    // 如果 stdin 关闭且有活动队友 → 注入关闭提示
    // 每 500ms 轮询一次
}
```

从 SDK 消费者的角度来看：你收到初始 `type: "result"`，但 AsyncGenerator 可能继续产生更多消息，因为团队领导者处理队友响应并重新进入 agent 循环。生成器只有在所有队友关闭时才真正完成。

## isSingleUserTurn 问题

来自 sdk.mjs：

```javascript
QK = typeof X === "string"  // isSingleUserTurn = true 当提示是字符串时
```

当 `isSingleUserTurn` 为 true 且第一个 `result` 消息到达时：

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // 关闭 CLI 的 stdin
}
```

这触发连锁反应：

1. SDK 关闭 CLI stdin
2. CLI 检测 stdin 关闭
3. 轮询循环看到 `D = true`（stdin 关闭）且有活动队友
4. 注入关闭提示 → 领导者向所有队友发送 `shutdown_request`
5. **队友在研究中途被杀死**

关闭提示（在混淆的 cli.js 中的 `BGq` 变量）：

```
你在非交互模式下运行，无法返回响应
给用户，直到你的团队关闭。

你必须在准备最终响应之前关闭你的团队：
1. 使用 requestShutdown 请求每个团队成员优雅关闭
2. 等待关闭批准
3. 使用清理操作清理团队
4. 只有那时才向用户提供最终响应
```

### 实际问题

使用 V1 `query()` + 字符串提示 + agent 团队：

1. 领导者生成队友，他们开始研究
2. 领导者的 EZ 循环结束（"我已经派遣了团队，他们正在工作"）
3. 发出 `type: "result"`
4. SDK 看到 `isSingleUserTurn = true` → 立即关闭 stdin
5. 轮询循环检测到 stdin 关闭 + 活动队友 → 注入关闭提示
6. 领导者向所有队友发送 `shutdown_request`
7. **队友可能在 5 分钟研究任务的 10 秒时被告诉停止**

## 修复：流式输入模式

不是传递字符串提示（设置 `isSingleUserTurn = true`），而是传递 `AsyncIterable<SDKUserMessage>`：

```typescript
// 之前（对 agent 团队 broken）：
query({ prompt: "do something" })

// 之后（保持 CLI 活动）：
query({ prompt: asyncIterableOfMessages })
```

当提示是 `AsyncIterable` 时：
- `isSingleUserTurn = false`
- SDK 在第一个结果后不关闭 stdin
- CLI 保持活动，继续处理
- 后台 agent 继续运行
- `task_notification` 消息流经迭代器
- 我们控制何时结束迭代器

### 额外好处：流式新消息

使用异步迭代器方法，我们可以在 agent 仍在工作时将新的传入 WhatsApp 消息推送到迭代器中。我们不是将消息排队直到容器退出并生成新容器，而是直接将它们流式传输到运行中的会话。

###  intended 生命周期与 Agent 团队

使用异步迭代器修复（`isSingleUserTurn = false`），stdin 保持打开，所以 CLI 从不会触发队友检查或关闭提示注入：

```
1. system/init          → 会话初始化
2. assistant/user       → Claude 推理，工具调用，工具结果
3. ...                  → 更多 assistant/user 回合（生成子 agent 等）
4. result #1            → 领导 agent 的第一个响应（捕获）
5. task_notification(s) → 后台 agent 完成/失败/停止
6. assistant/user       → 领导 agent 继续（处理子 agent 结果）
7. result #2            → 领导 agent 的后续响应（捕获）
8. [迭代器完成]      → CLI 关闭 stdout，全部完成
```

所有结果都有意义 — 捕获每一个，不只是第一个。

## V1 vs V2 API

### V1：`query()` — 一次性异步生成器

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* 处理事件 */ }
```

- 当 `prompt` 是字符串：`isSingleUserTurn = true` → stdin 在第一个结果后自动关闭
- 对于多回合：必须传递 `AsyncIterable<SDKUserMessage>` 并自己管理协调

### V2：`createSession()` + `send()` / `stream()` — 持久会话

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("first message");
for await (const msg of session.stream()) { /* 事件 */ }
await session.send("follow-up");
for await (const msg of session.stream()) { /* 事件 */ }
```

- `isSingleUserTurn = false` 总是 → stdin 保持打开
- `send()` 入队到异步队列（`QX`）
- `stream()` 从相同的消息生成器产生，在 `result` 类型停止
- 多回合是自然的 — 只需交替 `send()` / `stream()`
- V2 不调用 V1 `query()` 内部 — 两者都独立创建 Transport + Query

### 比较表

| 方面 | V1 | V2 |
|--------|----|----|
| `isSingleUserTurn` | 字符串提示为 `true` | 总是 `false` |
| 多回合 | 需要管理 `AsyncIterable` | 只需调用 `send()`/`stream()` |
| stdin 生命周期 | 第一个结果后自动关闭 | 保持打开直到 `close()` |
| Agentic 循环 | 相同的 `EZ()` | 相同的 `EZ()` |
| 停止条件 | 相同 | 相同 |
| 会话持久化 | 必须传递 `resume` 到新 `query()` | 通过 session 对象内置 |
| API 稳定性 | 稳定 | 不稳定预览（`unstable_v2_*` 前缀） |

**关键发现：回合行为零差异。** 两者都使用相同的 CLI 进程、相同的 `EZ()` 递归生成器和相同的决策逻辑。

## 钩子事件

```typescript
type HookEvent =
  | 'PreToolUse'         // 工具执行前
  | 'PostToolUse'        // 工具成功执行后
  | 'PostToolUseFailure' // 工具失败执行后
  | 'Notification'       // 通知消息
  | 'UserPromptSubmit'   // 用户提示提交
  | 'SessionStart'       // 会话启动（启动/恢复/清除/压缩）
  | 'SessionEnd'         // 会话结束
  | 'Stop'               // Agent 停止
  | 'SubagentStart'      // 子 agent 生成
  | 'SubagentStop'       // 子 agent 停止
  | 'PreCompact'         // 对话压缩前
  | 'PermissionRequest'; // 权限正在请求
```

### 钩子配置

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // 可选工具名称匹配器
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### 钩子返回值

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### 子 agent 钩子（来自 sdk.d.ts）

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query 接口方法

`Query` 对象（sdk.d.ts:931）。官方文档列出这些公共方法：

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 停止当前执行（仅流式输入模式）
  rewindFiles(userMessageUuid: string): Promise<void>; // 恢复文件到消息时的状态（需要 enableFileCheckpointing）
  setPermissionMode(mode: PermissionMode): Promise<void>; // 更改权限（仅流式输入模式）
  setModel(model?: string): Promise<void>;        // 更改模型（仅流式输入模式）
  setMaxThinkingTokens(max: number | null): Promise<void>; // 更改思考令牌（仅流式输入模式）
  supportedCommands(): Promise<SlashCommand[]>;   // 可用的斜杠命令
  supportedModels(): Promise<ModelInfo[]>;         // 可用的模型
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP 服务器连接状态
  accountInfo(): Promise<AccountInfo>;             // 认证用户信息
}
```

在 sdk.d.ts 中找到但未在官方文档中列出（可能是内部的）：
- `streamInput(stream)` — 流式传输额外用户消息
- `close()` — 强制结束查询
- `setMcpServers(servers)` — 动态添加/移除 MCP 服务器

## 沙盒配置

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

当 `allowUnsandboxedCommands` 为 true 时，模型可以设置 `dangerouslyDisableSandbox: true` 在 Bash 工具输入中，这回退到 `canUseTool` 权限处理程序。

## MCP 服务器助手

### tool()

创建带有 Zod 模式的类型安全 MCP 工具定义：

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

创建进程内 MCP 服务器（我们使用 stdio 而不是子 agent 继承）：

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 内部参考

### 关键混淆标识符 (sdk.mjs)

| 混淆 | 用途 |
|----------|---------|
| `s_` | V1 `query()` 导出 |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session 类（`send`/`stream`/`close`） |
| `XX` | ProcessTransport（生成 cli.js） |
| `$X` | Query 类（JSON-line 路由，异步迭代器） |
| `QX` | AsyncQueue（输入流缓冲区） |

### 关键混淆标识符 (cli.js)

| 混淆 | 用途 |
|----------|---------|
| `EZ` | 核心递归 agent 循环（异步生成器） |
| `_t4` | 停止钩子处理程序（当无 tool_use 块时运行） |
| `PU1` | 流式工具执行器（在 API 响应期间并行） |
| `TP6` | 标准工具执行器（在 API 响应后） |
| `GU1` | 单个工具执行器 |
| `lTq` | SDK 会话运行器（直接调用 EZ） |
| `bd1` | stdin 读取器（来自传输的 JSON-lines） |
| `mW1` | Anthropic API 流式调用器 |

## 关键文件

- `sdk.d.ts` — 所有类型定义（1777 行）
- `sdk-tools.d.ts` — 工具输入模式
- `sdk.mjs` — SDK 运行时（混淆，376KB）
- `cli.js` — CLI 可执行文件（混淆，作为子进程运行）
