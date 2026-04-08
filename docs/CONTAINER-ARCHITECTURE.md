# Agent 容器架构

本文档详细说明 NanoClaw Agent 容器的运行原理、通信机制和生命周期管理。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Host (NanoClaw 主进程)                       │
│                                                                     │
│  ┌──────────────┐                      ┌─────────────────┐         │
│  │ src/index.ts │─────────────────────▶│container-runner │         │
│  │ (消息循环)    │                      │ (一次性容器)      │         │
│  └──────────────┘                      └─────────────────┘         │
│         │                                    │                       │
│         ▼                                    ▼                       │
│  ┌──────────────┐                      ┌─────────────────┐         │
│  │ groups/{id}/ │                      │ data/sessions/   │         │
│  │ (群组记忆)    │                      │ (会话数据)        │         │
│  └──────────────┘                      └─────────────────┘         │
│                                        ┌─────────────────┐         │
│                                        │ data/ipc/       │         │
│                                        │ (IPC通信)       │         │
│                                        └─────────────────┘         │
│                              │                        │             │
└──────────────────────────────┼────────────────────────┼─────────────┘
                               │ Volume Mounts          │ Volume Mounts
                               ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Docker Container (隔离环境)                     │
│                                                                     │
│  /app/                                                              │
│  ├── entrypoint.sh      ◀── 容器入口，编译 TypeScript               │
│  └── src/                                                           │
│      ├── index.ts       ◀── Agent Runner 主程序                     │
│      └── ipc-mcp-stdio.ts ◀── MCP Server (工具调用)                 │
│                                                                     │
│  /workspace/                                                        │
│  ├── group/             ◀── 群组文件夹 (读写)                        │
│  ├── global/            ◀── 全局记忆 (只读)                          │
│  ├── ipc/               ◀── IPC 通信目录                             │
│  │   ├── input/         ◀── 主进程写入后续消息                       │
│  │   ├── messages/      ◀── Agent 写入发送消息                       │
│  │   └── tasks/         ◀── Agent 写入定时任务                       │
│  └── .claude/           ◀── Claude 会话数据                          │
│                                                                     │
│  /home/node/.claude/    ◀── Claude 配置 (settings.json)             │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 容器镜像 (`container/Dockerfile`)

基于 Node.js 22 的轻量级镜像，包含：

| 组件 | 版本/说明 | 用途 |
|------|----------|------|
| Node.js | 22-slim | 运行时环境 |
| Chromium | 系统包 | 浏览器自动化 |
| claude-code | 全局安装 | Claude Agent SDK |
| agent-browser | 全局安装 | 浏览器控制 |

```dockerfile
FROM node:22-slim

# 安装 Chromium 依赖
RUN apt-get update && apt-get install -y chromium ...

# 全局安装 Claude 工具
RUN npm install -g agent-browser @anthropic-ai/claude-code

# 创建工作目录
WORKDIR /app

# 复制并构建 agent-runner
COPY agent-runner/ ./
RUN npm install && npm run build

# 创建 workspace 目录
RUN mkdir -p /workspace/group /workspace/global /workspace/ipc/...

# 入口脚本
ENTRYPOINT ["/app/entrypoint.sh"]
```

### 2. 容器启动器 (`src/container-runner.ts`)

负责构建容器参数、挂载卷、启动容器进程。

#### 挂载配置

```typescript
function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  
  // 主群组获得项目根目录（只读）
  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,  // 防止修改宿主代码
    });
  }
  
  // 群组文件夹（读写）
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/group',
    readonly: false,
  });
  
  // 全局记忆（非主群组只读）
  if (!isMain) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }
  
  // Claude 会话目录（隔离）
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  
  // IPC 通信目录
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  
  return mounts;
}
```

#### 容器启动流程

```typescript
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  
  // 1. 构建挂载配置
  const mounts = buildVolumeMounts(group, input.isMain);
  
  // 2. 生成容器名称（基于发送者ID，支持复用）
  const containerName = `nanoclaw-${jidToFolderName(input.chatJid)}`;
  
  // 3. 尝试从池中获取
  const acquired = containerPool.acquire(group, input.chatJid, containerName);
  
  // 4. 构建 Docker 参数
  const containerArgs = await buildContainerArgs(mounts, containerName, ...);
  
  // 5. 启动容器进程
  const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  
  // 6. 通过 stdin 传入输入
  container.stdin.write(JSON.stringify(input));
  container.stdin.end();
  
  // 7. 流式解析输出
  container.stdout.on('data', (data) => {
    // 解析 OUTPUT_START/END 标记对
    // 提取 JSON 结果，调用 onOutput 回调
  });
}
```

### 3. Agent Runner (`container/agent-runner/src/index.ts`)

运行在容器内的主程序，负责与 Claude Agent SDK 交互。

#### 输入协议

```typescript
interface ContainerInput {
  prompt: string;           // 用户消息
  sessionId?: string;       // 会话ID（用于恢复）
  groupFolder: string;      // 群组文件夹名
  chatJid: string;          // 发送者ID
  isMain: boolean;          // 是否主群组
  isScheduledTask?: boolean; // 是否定时任务
  assistantName?: string;   // 助手名称
  script?: string;          // 预执行脚本
}
```

#### 输出协议

```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;    // 响应内容
  newSessionId?: string;    // 新会话ID
  error?: string;           // 错误信息
}
```

#### 执行循环

```typescript
async function main() {
  // 1. 读取 stdin 输入
  const input = JSON.parse(await readStdin());
  
  // 2. 创建消息流
  const stream = new MessageStream();
  stream.push(input.prompt);
  
  // 3. 查询循环
  while (true) {
    // 调用 Claude Agent SDK
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: ['ipc-mcp-stdio.js'],
            env: { NANOCLAW_CHAT_JID: input.chatJid, ... }
          }
        }
      }
    })) {
      // 处理系统消息
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
      }
      
      // 处理结果
      if (message.type === 'result') {
        writeOutput({ status: 'success', result: message.result });
      }
    }
    
    // 等待后续消息（通过 IPC）
    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) break; // 收到 _close 信号
    stream.push(nextMessage);
  }
}
```

### 4. MCP Server (`container/agent-runner/src/ipc-mcp-stdio.ts`)

提供 Agent 可调用的工具，通过 IPC 文件与主进程通信。

#### 可用工具

| 工具 | 功能 | IPC 目录 |
|------|------|----------|
| `send_message` | 发送消息到用户/群组 | `/workspace/ipc/messages/` |
| `schedule_task` | 创建定时任务 | `/workspace/ipc/tasks/` |
| `list_tasks` | 列出所有任务 | 读取 `current_tasks.json` |
| `pause_task` | 暂停任务 | `/workspace/ipc/tasks/` |
| `resume_task` | 恢复任务 | `/workspace/ipc/tasks/` |
| `cancel_task` | 取消任务 | `/workspace/ipc/tasks/` |
| `update_task` | 更新任务 | `/workspace/ipc/tasks/` |
| `register_group` | 注册新群组 | `/workspace/ipc/tasks/` |

#### 工具实现示例

```typescript
server.tool(
  'send_message',
  "Send a message to the user or group immediately",
  {
    text: z.string().describe('The message text'),
    sender: z.string().optional().describe('Sender identity'),
  },
  async (args) => {
    const data = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender,
      timestamp: new Date().toISOString(),
    };
    
    // 写入 IPC 文件
    writeIpcFile(MESSAGES_DIR, data);
    
    return { content: [{ type: 'text', text: 'Message sent.' }] };
  }
);
```

## 通信机制

### IPC 通信架构

```
Host                              Container
─────                             ─────────
                                  ┌─────────────────┐
stdin ───── JSON Input ─────────▶│ agent-runner    │
                                  │                 │
                                  │  ┌───────────┐  │
stdout ◀─── OUTPUT_MARKERS ──────│  │ MCP       │  │
                                  │  │ Server    │  │
                                  │  └───────────┘  │
                                  │       │         │
                                  │       ▼         │
                                  │  /workspace/ipc/│
                                  │  ├── messages/  │──▶ Host 监听 → 发送消息
                                  │  ├── tasks/     │──▶ Host 监听 → 创建任务
                                  │  └── input/     │◀── Host 写入 → 后续消息
                                  └─────────────────┘
```

### IPC 目录用途

| 目录 | 方向 | 用途 |
|------|------|------|
| `/workspace/ipc/input/` | Host → Container | 后续消息、`_close` 关闭信号 |
| `/workspace/ipc/messages/` | Container → Host | Agent 调用 `send_message` |
| `/workspace/ipc/tasks/` | Container → Host | Agent 调用任务相关工具 |

### 输出标记格式

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"响应内容","newSessionId":"sess-xxx"}
---NANOCLAW_OUTPUT_END---
```

主进程流式解析这些标记对，实时获取 Agent 输出。

### 消息流机制

```typescript
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
    }
  }
}
```

## 容器管理

### 消息处理容器 (ContainerManager)

用于处理用户消息，采用简化的生命周期管理：

```
消息到达 → getOrCreate() → 检查容器状态
                │
                ├─ 不存在 → 创建新容器
                │
                └─ 存在但异常 → 删除并重建
                        │
                        ▼
                发送输入到容器 → 等待输出
                        │
                        ▼
                空闲计时开始 → 超时自动关闭
```

### ContainerManager API

```typescript
class ContainerManager {
  // 获取或创建容器
  getOrCreate(chatJid: string, group: RegisteredGroup, input: ContainerInput): Promise<ContainerEntry>;

  // 发送消息到容器
  sendMessage(chatJid: string, message: string): boolean;

  // 等待容器输出
  waitForOutput(chatJid: string, timeoutMs?: number): Promise<ContainerOutput | null>;

  // 关闭容器
  close(chatJid: string): Promise<void>;

  // 检查容器是否活跃
  isActive(chatJid: string): boolean;

  // 关闭所有容器
  shutdown(): Promise<void>;
}
```

### 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CONTAINER_IDLE_TIMEOUT_MS` | `300000` | 空闲超时（5分钟） |

### 定时任务容器 (ContainerPool)

用于定时任务处理，仍使用旧的池化模式：

```typescript
class ContainerPool {
  // 获取或创建容器
  acquire(group: RegisteredGroup, chatJid: string, containerName: string): ContainerAcquireResult;

  // 注册进程句柄
  registerProcess(chatJid: string, process: ChildProcess): void;

  // 更新活动时间
  touch(chatJid: string): void;

  // 释放容器（开始空闲计时）
  release(chatJid: string): void;

  // 驱逐容器
  evict(chatJid: string): Promise<void>;
}
```

> **注意**: 所有容器操作统一由 `container-runner.ts` 管理，消息处理和定时任务都使用一次性容器模式。

## 卷挂载详解

### 挂载映射表

| Host 路径 | Container 路径 | 权限 | 用途 |
|-----------|---------------|------|------|
| `groups/{name}/` | `/workspace/group` | RW | 群组记忆和工作目录 |
| `groups/global/` | `/workspace/global` | RO | 全局共享记忆（非主群组） |
| `data/sessions/{name}/.claude/` | `/home/node/.claude` | RW | Claude 会话持久化 |
| `data/ipc/{name}/` | `/workspace/ipc` | RW | IPC 通信 |
| `container/skills/` | `/home/node/.claude/skills/` | RO | 容器技能 |
| `container/agent-runner/src/` | `/app/src` | RW | Agent Runner 源码 |
| 项目根目录 | `/workspace/project` | RO | 主群组访问项目（只读） |

### 安全措施

1. **.env 屏蔽**：主群组挂载项目时，用 `/dev/null` 覆盖 `.env` 文件
2. **只读挂载**：项目代码和全局记忆以只读方式挂载
3. **非 root 用户**：容器以 `node` 用户运行
4. **用户映射**：`--user` 参数确保文件权限正确

## 凭证管理

### OneCLI Gateway

```typescript
// OneCLI gateway 处理凭证注入
const onecliApplied = await onecli.applyContainerConfig(args, {
  addHostMapping: false,
  agent: agentIdentifier,
});
```

### .env 回退

```typescript
// 从 .env 读取凭证作为回退
const envConfig = readEnvFile([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]);
```

## 超时处理

### 超时配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CONTAINER_TIMEOUT` | 300000ms | 硬超时 |
| `IDLE_TIMEOUT` | 30000ms | 空闲超时（发送 `_close` 信号） |

### 超时流程

```
容器启动
    │
    ▼
执行 Agent
    │
    ├─▶ 有输出 → 重置超时计时器
    │
    └─▶ 空闲超时 → 写入 _close 信号
                            │
                            ▼
                    Agent 优雅退出
                            │
                            ▼
                    硬超时 → 强制终止
```

## 日志记录

### 日志文件位置

- **容器日志**：`groups/{name}/logs/container-{timestamp}.log`
- **超时日志**：`groups/{name}/logs/container-{timestamp}-TIMEOUT.log`

### 日志内容

```
=== Container Run Log ===
Timestamp: 2026-04-06T10:00:00.000Z
Group: wecom-luhj
IsMain: false
Duration: 12345ms
Exit Code: 0

=== Input Summary ===
Prompt length: 256 chars
Session ID: sess-xxx

=== Mounts ===
/groups/wecom-luhj -> /workspace/group
/data/sessions/wecom-luhj/.claude -> /home/node/.claude
...
```

## 完整数据流

```
1. 消息到达渠道 (WeCom/Slack/Telegram)
       │
       ▼
2. 主进程构建 ContainerInput
       │
       ▼
3. 启动容器，stdin 传入 JSON
       │
       ▼
4. agent-runner 读取输入
       │
       ▼
5. 调用 Claude Agent SDK
       │
       ├─▶ MCP 工具调用
       │       │
       │       ├─▶ send_message → IPC → 主进程 → 渠道
       │       └─▶ schedule_task → IPC → 主进程 → 调度器
       │
       ▼
6. 输出通过 stdout 返回（标记格式）
       │
       ▼
7. 主进程解析输出
       │
       ▼
8. 路由响应回渠道
       │
       ▼
9. 容器标记为空闲（池模式）或关闭
```

---

*文档生成时间: 2026-04-06 (重构: 简化容器管理)*
