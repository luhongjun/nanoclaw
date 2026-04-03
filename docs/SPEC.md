# NanoClaw 技术规格说明书

一个个人 Claude 助手，具有多通道支持、每个对话的持久内存、定时任务和容器隔离的 agent 执行。

---

## 目录

1. [架构](#architecture)
2. [架构：通道系统](#architecture-channel-system)
3. [文件夹结构](#folder-structure)
4. [配置](#configuration)
5. [内存系统](#memory-system)
6. [会话管理](#session-management)
7. [消息流](#message-flow)
8. [命令](#commands)
9. [定时任务](#scheduled-tasks)
10. [MCP 服务器](#mcp-servers)
11. [部署](#deployment)
12. [安全考虑](#security-considerations)

---

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        主机 (macOS / Linux)                           │
│                     (主 Node.js 进程)                                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐                  ┌────────────────────┐        │
│  │ 通道             │─────────────────▶│   SQLite 数据库     │        │
│  │ (启动时自注册)     │◀────────────────│   (messages.db)    │        │
│  └──────────────────┘  存储/发送          └─────────┬──────────┘        │
│                                                   │                   │
│         ┌─────────────────────────────────────────┘                   │
│         │                                                             │
│         ▼                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐   │
│  │  消息循环        │    │  调度器循环      │    │  IPC 监视器    │   │
│  │  (轮询 SQLite)   │    │  (检查任务)      │    │  (基于文件)   │   │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘   │
│           │                       │                                   │
│           └───────────┬───────────┘                                   │
│                       │ 生成容器                                       │
│                       ▼                                               │
├──────────────────────────────────────────────────────────────────────┤
│                     容器 (Linux VM)                                    │
├──────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    AGENT RUNNER                               │    │
│  │                                                                │    │
│  │  工作目录：/workspace/group (从主机挂载)                        │    │
│  │  卷挂载：                                                       │    │
│  │    • groups/{name}/ → /workspace/group                         │    │
│  │    • groups/global/ → /workspace/global/ (仅非主组)            │    │
│  │    • data/sessions/{group}/.claude/ → /home/node/.claude/      │    │
│  │    • 额外目录 → /workspace/extra/*                             │    │
│  │                                                                │    │
│  │  工具（所有组）：                                               │    │
│  │    • Bash（安全 - 在容器中沙盒化！）                           │    │
│  │    • Read, Write, Edit, Glob, Grep (文件操作)                  │    │
│  │    • WebSearch, WebFetch (互联网访问)                          │    │
│  │    • agent-browser (浏览器自动化)                              │    │
│  │    • mcp__nanoclaw__* (通过 IPC 的调度器工具)                  │    │
│  │                                                                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 组件 | 技术 | 用途 |
|-----------|------------|---------|
| 通道系统 | 通道注册表 (`src/channels/registry.ts`) | 通道在启动时自注册 |
| 消息存储 | SQLite (better-sqlite3) | 存储消息以进行轮询 |
| 容器运行时 | Containers (Linux VMs) | 用于 agent 执行的隔离环境 |
| Agent | @anthropic-ai/claude-agent-sdk (0.2.29) | 使用工具和 MCP 服务器运行 Claude |
| 浏览器自动化 | agent-browser + Chromium | Web 交互和截图 |
| 运行时 | Node.js 20+ | 用于路由和调度的主机进程 |

---

## 架构：通道系统

核心版本不内置任何通道 — 每个通道（WhatsApp、Telegram、Slack、Discord、Gmail）作为 [Claude Code 技能](https://code.claude.com/docs/en/skills) 安装，将通道代码添加到你的 fork 中。通道在启动时自注册；缺少凭证的已安装通道会发出 WARN 日志并被跳过。

### 系统图

```mermaid
graph LR
    subgraph Channels["通道"]
        WA[WhatsApp]
        TG[Telegram]
        SL[Slack]
        DC[Discord]
        New["其他通道 (Signal, Gmail...)"]
    end

    subgraph Orchestrator["编排器 — index.ts"]
        ML[消息循环]
        GQ[组队列]
        RT[路由器]
        TS[任务调度器]
        DB[(SQLite)]
    end

    subgraph Execution["容器执行"]
        CR[容器运行器]
        LC["Linux 容器"]
        IPC[IPC 监视器]
    end

    %% 流
    WA & TG & SL & DC & New -->|onMessage| ML
    ML --> GQ
    GQ -->|concurrency| CR
    CR --> LC
    LC -->|filesystem IPC| IPC
    IPC -->|tasks & messages| RT
    RT -->|Channel.sendMessage| Channels
    TS -->|due tasks| CR

    %% DB 连接
    DB <--> ML
    DB <--> TS

    %% 动态通道的样式
    style New stroke-dasharray: 5 5,stroke-width:2px
```

### 通道注册表

通道系统基于 `src/channels/registry.ts` 中的工厂注册表：

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
```

每个工厂接收 `ChannelOpts`（`onMessage`、`onChatMetadata` 和 `registeredGroups` 的回调）并返回 `Channel` 实例或 `null`（如果该通道的凭证缺失）。

### 通道接口

每个通道实现此接口（在 `src/types.ts` 中定义）：

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### 自注册模式

通道使用桶导入模式自注册：

1. 每个通道技能在 `src/channels/` 中添加一个文件（例如 `whatsapp.ts`、`telegram.ts`），在模块加载时调用 `registerChannel()`：

   ```typescript
   // src/channels/whatsapp.ts
   import { registerChannel, ChannelOpts } from './registry.js';

   export class WhatsAppChannel implements Channel { /* ... */ }

   registerChannel('whatsapp', (opts: ChannelOpts) => {
     // 如果凭证缺失则返回 null
     if (!existsSync(authPath)) return null;
     return new WhatsAppChannel(opts);
   });
   ```

2. 桶文件 `src/channels/index.ts` 导入所有通道模块，触发注册：

   ```typescript
   import './whatsapp.js';
   import './telegram.js';
   // ... 每个技能添加其导入
   ```

3. 在启动时，编排器 (`src/index.ts`) 循环遍历已注册的通道，并连接返回有效实例的通道：

   ```typescript
   for (const name of getRegisteredChannelNames()) {
     const factory = getChannelFactory(name);
     const channel = factory?.(channelOpts);
     if (channel) {
       await channel.connect();
       channels.push(channel);
     }
   }
   ```

### 关键文件

| 文件 | 用途 |
|------|---------|
| `src/channels/registry.ts` | 通道工厂注册表 |
| `src/channels/index.ts` | 触发通道自注册的桶导入 |
| `src/types.ts` | `Channel` 接口，`ChannelOpts`，消息类型 |
| `src/index.ts` | 编排器 — 实例化通道，运行消息循环 |
| `src/router.ts` | 查找 JID 的拥有通道，格式化消息 |

### 添加新通道

要添加新通道，贡献一个技能到 `.claude/skills/add-<name>/`，该技能：

1. 添加实现 `Channel` 接口的 `src/channels/<name>.ts` 文件
2. 在模块加载时调用 `registerChannel(name, factory)`
3. 如果凭证缺失则从工厂返回 `null`
4. 在 `src/channels/index.ts` 中添加导入行

参见现有技能（`/add-whatsapp`、`/add-telegram`、`/add-slack`、`/add-discord`、`/add-gmail`）获取模式。

---

## 文件夹结构

```
nanoclaw/
├── CLAUDE.md                      # Claude Code 的项目上下文
├── docs/
│   ├── SPEC.md                    # 此规格文档
│   ├── REQUIREMENTS.md            # 架构决策
│   └── SECURITY.md                # 安全模型
├── README.md                      # 用户文档
├── package.json                   # Node.js 依赖
├── tsconfig.json                  # TypeScript 配置
├── .mcp.json                      # MCP 服务器配置（参考）
├── .gitignore
│
├── src/
│   ├── index.ts                   # 编排器：状态、消息循环、agent 调用
│   ├── channels/
│   │   ├── registry.ts            # 通道工厂注册表
│   │   └── index.ts               # 用于通道自注册的桶导入
│   ├── ipc.ts                     # IPC 监视器和任务处理
│   ├── router.ts                  # 消息格式化和出站路由
│   ├── config.ts                  # 配置常量
│   ├── types.ts                   # TypeScript 接口（包括 Channel）
│   ├── logger.ts                  # Pino 记录器设置
│   ├── db.ts                      # SQLite 数据库初始化和查询
│   ├── group-queue.ts             # 具有全局并发限制的每组队列
│   ├── mount-security.ts          # 容器的挂载允许列表验证
│   ├── whatsapp-auth.ts           # 独立的 WhatsApp 认证
│   ├── task-scheduler.ts          # 到期时运行定时任务
│   └── container-runner.ts        # 在容器中生成 agent
│
├── container/
│   ├── Dockerfile                 # 容器镜像（以'node'用户运行，包括 Claude Code CLI）
│   ├── build.sh                   # 容器镜像的构建脚本
│   ├── agent-runner/              # 在容器内运行的代码
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # 入口点（查询循环、IPC 轮询、会话恢复）
│   │       └── ipc-mcp-stdio.ts   # 用于主机通信的基于 stdio 的 MCP 服务器
│   └── skills/
│       └── agent-browser.md       # 浏览器自动化技能
│
├── dist/                          # 编译后的 JavaScript（git 忽略）
│
├── .claude/
│   └── skills/
│       ├── setup/SKILL.md              # /setup - 首次安装
│       ├── customize/SKILL.md          # /customize - 添加功能
│       ├── debug/SKILL.md              # /debug - 容器调试
│       ├── add-telegram/SKILL.md       # /add-telegram - Telegram 通道
│       ├── add-gmail/SKILL.md          # /add-gmail - Gmail 集成
│       ├── add-voice-transcription/    # /add-voice-transcription - Whisper
│       ├── x-integration/SKILL.md      # /x-integration - X/Twitter
│       ├── convert-to-apple-container/  # /convert-to-apple-container - Apple Container 运行时
│       └── add-parallel/SKILL.md       # /add-parallel - 并行 agent
│
├── groups/
│   ├── CLAUDE.md                  # 全局内存（所有组读取）
│   ├── {channel}_main/             # 主控制通道（例如 whatsapp_main/）
│   │   ├── CLAUDE.md              # 主通道内存
│   │   └── logs/                  # 任务执行日志
│   └── {channel}_{group-name}/    # 每组文件夹（注册时创建）
│       ├── CLAUDE.md              # 组特定内存
│       ├── logs/                  # 该组的任务日志
│       └── *.md                   # agent 创建的文件
│
├── store/                         # 本地数据（git 忽略）
│   ├── auth/                      # WhatsApp 认证状态
│   └── messages.db                # SQLite 数据库（消息、聊天、scheduled_tasks、task_run_logs、registered_groups、sessions、router_state）
│
├── data/                          # 应用状态（git 忽略）
│   ├── sessions/                  # 每组会话数据（带有 JSONL 转录的 .claude/ 目录）
│   ├── env/env                    # .env 的副本，用于容器挂载
│   └── ipc/                       # 容器 IPC（消息/、任务/）
│
├── logs/                          # 运行时日志（git 忽略）
│   ├── nanoclaw.log               # 主机 stdout
│   └── nanoclaw.error.log         # 主机 stderr
│   # 注意：每个容器日志在 groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.nanoclaw.plist         # macOS 服务配置
```

---

## 配置

配置常量在 `src/config.ts` 中：

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// 路径必须是绝对的（容器挂载所需）
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// 容器配置
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10); // 默认 30 分钟
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30 分钟 — 在最后结果后保持容器活动
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**注意：** 路径必须是绝对的，容器卷挂载才能正常工作。

### 容器配置

组可以通过 SQLite `registered_groups` 表中的 `containerConfig`（作为 JSON 存储在 `container_config` 列中）挂载额外目录。注册示例：

```typescript
setRegisteredGroup("1234567890@g.us", {
  name: "Dev Team",
  folder: "whatsapp_dev-team",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      {
        hostPath: "~/projects/webapp",
        containerPath: "webapp",
        readonly: false,
      },
    ],
    timeout: 600000,
  },
});
```

文件夹名称遵循约定 `{channel}_{group-name}`（例如 `whatsapp_family-chat`、`telegram_dev-team`）。主组在注册期间设置 `isMain: true`。

额外挂载在容器内出现在 `/workspace/extra/{containerPath}`。

**挂载语法注意：** 只读挂载使用 `--mount "type=bind,source=...,target=...,readonly"`（`:ro` 后缀在某些容器运行时上可能不起作用）。

### Claude 认证

在项目根目录的 `.env` 文件中配置认证。两个选项：

**选项 1：Claude 订阅（OAuth 令牌）**
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```
如果你已登录到 Claude Code，令牌可以从 `~/.claude/.credentials.json` 提取。

**选项 2：按量付费 API 密钥**
```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

只有认证变量（`CLAUDE_CODE_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`）从 `.env` 提取并写入 `data/env/env`，然后挂载到容器中的 `/workspace/env-dir/env` 并由入口点脚本 sourcing。这确保 `.env` 中的其他环境变量不会暴露给 agent。这是一个必要的变通方法，因为某些容器运行时在使用 `-i`（交互式模式与管道 stdin）时会丢失 `-e` 环境变量。

### 更改助手名称

设置 `ASSISTANT_NAME` 环境变量：

```bash
ASSISTANT_NAME=Bot npm start
```

或编辑 `src/config.ts` 中的默认值。这会更改：
- 触发模式（消息必须以 `@YourName` 开头）
- 响应前缀（自动添加 `YourName:`）

### launchd 中的占位符值

带有 `{{PLACEHOLDER}}` 值的文件需要配置：
- `{{PROJECT_ROOT}}` — nanoclaw 安装的绝对路径
- `{{NODE_PATH}}` — node 二进制文件的路径（通过 `which node` 检测）
- `{{HOME}}` — 用户的主目录

---

## 内存系统

NanoClaw 使用基于 CLAUDE.md 文件的分层内存系统。

### 内存层次结构

| 级别 | 位置 | 读取者 | 写入者 | 用途 |
|-------|----------|---------|------------|---------|
| **全局** | `groups/CLAUDE.md` | 所有组 | 仅主组 | 偏好、事实、跨所有对话共享的上下文 |
| **组** | `groups/{name}/CLAUDE.md` | 该组 | 该组 | 组特定上下文、对话内存 |
| **文件** | `groups/{name}/*.md` | 该组 | 该组 | 对话期间创建的笔记、研究、文档 |

### 内存如何工作

1. **Agent 上下文加载**
   - Agent 运行时的 `cwd` 设置为 `groups/{group-name}/`
   - 带有 `settingSources: ['project']` 的 Claude Agent SDK 自动加载：
     - `../CLAUDE.md`（父目录 = 全局内存）
     - `./CLAUDE.md`（当前目录 = 组内存）

2. **写入内存**
   - 当用户说"记住这个"时，agent 写入 `./CLAUDE.md`
   - 当用户说"全局记住这个"（仅主通道）时，agent 写入 `../CLAUDE.md`
   - Agent 可以创建文件如 `notes.md`、`research.md` 在组文件夹中

3. **主通道特权**
   - 只有"主"组（自我聊天）可以写入全局内存
   - 主组可以管理注册的组并为任何组安排任务
   - 主组可以为任何组配置额外的目录挂载
   - 所有组都有 Bash 访问（安全，因为它在容器内运行）

---

## 会话管理

会话实现对话连续性 — Claude 记住你们谈论的内容。

### 会话如何工作

1. 每个组有一个会话 ID 存储在 SQLite 中（`sessions` 表，以 `group_folder` 为键）
2. 会话 ID 传递给 Claude Agent SDK 的 `resume` 选项
3. Claude 以完整的上下文继续对话
4. 会话转录作为 JSONL 文件存储在 `data/sessions/{group}/.claude/`

---

## 消息流

### 传入消息流

```
1. 用户通过任何连接的通道发送消息
   │
   ▼
2. 通道接收消息（例如 WhatsApp 的 Baileys，Telegram 的 Bot API）
   │
   ▼
3. 消息存储在 SQLite 中 (store/messages.db)
   │
   ▼
4. 消息循环轮询 SQLite（每 2 秒）
   │
   ▼
5. 路由器检查：
   ├── chat_jid 是否在注册的组中（SQLite）？→ 否：忽略
   └── 消息是否匹配触发模式？→ 否：存储但不处理
   │
   ▼
6. 路由器赶上对话：
   ├── 获取上次 agent 交互以来的所有消息
   ├── 格式化时间戳和发送者名称
   └── 构建带有完整对话上下文的提示
   │
   ▼
7. 路由器调用 Claude Agent SDK：
   ├── cwd: groups/{group-name}/
   ├── prompt：对话历史 + 当前消息
   ├── resume：session_id（用于连续性）
   └── mcpServers：nanoclaw（调度器）
   │
   ▼
8. Claude 处理消息：
   ├── 读取 CLAUDE.md 文件获取上下文
   └── 根据需要使用的工具（搜索、邮件等）
   │
   ▼
9. 路由器用助手名称前缀响应并通过拥有通道发送
   │
   ▼
10. 路由器更新上次 agent 时间戳并保存会话 ID
```

### 触发词匹配

消息必须以触发模式开头（默认：`@Andy`）：
- `@Andy 天气怎么样？` → ✅ 触发 Claude
- `@andy 帮我` → ✅ 触发（不区分大小写）
- `嘿@Andy` → ❌ 忽略（触发器不在开头）
- `怎么样？` → ❌ 忽略（无触发器）

### 对话追赶

当触发消息到达时，agent 接收自上次交互以来的所有消息。每条消息都格式化有时间戳和发送者名称：

```
[1 月 31 2:32 PM] John: 嘿大家，今晚吃披萨好吗？
[1 月 31 2:33 PM] Sarah: 我觉得不错
[1 月 31 2:35 PM] John: @Andy 你推荐什么配料？
```

这允许 agent 理解对话上下文，即使它在每条消息中都没有被提及。

---

## 命令

### 任何组中可用的命令

| 命令 | 示例 | 效果 |
|---------|---------|--------|
| `@助手 [消息]` | `@Andy 天气怎么样？` | 与 Claude 对话 |

### 仅在主通道中可用的命令

| 命令 | 示例 | 效果 |
|---------|---------|--------|
| `@助手 add group "名称"` | `@Andy add group "Family Chat"` | 注册新组 |
| `@助手 remove group "名称"` | `@Andy remove group "Work Team"` | 取消注册组 |
| `@助手 list groups` | `@Andy list groups` | 显示注册组 |
| `@助手 remember [事实]` | `@Andy remember I prefer dark mode` | 添加到全局内存 |

---

## 定时任务

NanoClaw 有一个内置调度器，在组的上下文中作为完整的 agent 运行任务。

### 调度如何工作

1. **组上下文**：在组中创建的任务使用该组的工作目录和内存运行
2. **完整 Agent 功能**：定时任务可以访问所有工具（WebSearch、文件操作等）
3. **可选消息**：任务可以使用 `send_message` 工具向它们的组发送消息，或静默完成
4. **主通道特权**：主通道可以为任何组安排任务并查看所有任务

### 计划类型

| 类型 | 值格式 | 示例 |
|------|--------------|---------|
| `cron` | Cron 表达式 | `0 9 * * 1`（周一上午 9 点） |
| `interval` | 毫秒 | `3600000`（每小时） |
| `once` | ISO 时间戳 | `2024-12-25T09:00:00Z` |

### 创建任务

```
用户：@Andy 每周一上午 9 点提醒我审查每周指标

Claude：[调用 mcp__nanoclaw__schedule_task]
        {
          "prompt": "发送提醒审查每周指标。要鼓励！",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1"
        }

Claude：完成！我会在每周一上午 9 点提醒你。
```

### 一次性任务

```
用户：@Andy 今天下午 5 点，发送我今天邮件的摘要

Claude：[调用 mcp__nanoclaw__schedule_task]
        {
          "prompt": "搜索今天的邮件，总结重要的，并发送摘要到组。",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z"
        }
```

### 管理任务

从任何组：
- `@Andy list my scheduled tasks` - 查看该组的任务
- `@Andy pause task [id]` - 暂停任务
- `@Andy resume task [id]` - 恢复暂停的任务
- `@Andy cancel task [id]` - 删除任务

从主通道：
- `@Andy list all tasks` - 查看所有组的任务
- `@Andy schedule task for "Family Chat": [提示]` - 为其他组安排任务

---

## MCP 服务器

### NanoClaw MCP（内置）

`nanoclaw` MCP 服务器是动态地为每个 agent 调用创建的，带有当前组的上下文。

**可用工具：**
| 工具 | 用途 |
|------|---------|
| `schedule_task` | 安排重复或一次性任务 |
| `list_tasks` | 显示任务（组的任务，或主组的所有任务） |
| `get_task` | 获取任务详情和运行历史 |
| `update_task` | 修改任务提示或计划 |
| `pause_task` | 暂停任务 |
| `resume_task` | 恢复暂停的任务 |
| `cancel_task` | 删除任务 |
| `send_message` | 通过组的通道向组发送消息 |

---

## 部署

NanoClaw 作为单个 macOS launchd 服务运行。

### 启动序列

当 NanoClaw 启动时，它：
1. **确保容器运行时正在运行** — 自动启动它（如果需要）；杀死上次运行的孤儿 NanoClaw 容器
2. 初始化 SQLite 数据库（如果存在则从 JSON 文件迁移）
3. 从 SQLite 加载状态（注册的组、会话、路由器状态）
4. **连接通道** — 循环遍历已注册的通道，实例化有凭证的通道，调用每个通道的 `connect()`
5. 一旦至少一个通道连接：
   - 启动调度器循环
   - 启动用于容器消息的 IPC 监视器
   - 设置带有 `processGroupMessages` 的每组队列
   - 恢复启动前未处理的任何消息
   - 启动消息轮询循环

### 服务：com.nanoclaw

**launchd/com.nanoclaw.plist：**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

### 管理服务

```bash
# 安装服务
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# 启动服务
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 检查状态
launchctl list | grep nanoclaw

# 查看日志
tail -f logs/nanoclaw.log
```

---

## 安全考虑

### 容器隔离

所有 agent 在容器内运行（轻量级 Linux VM），提供：
- **文件系统隔离**：Agent 只能访问挂载的目录
- **安全 Bash 访问**：命令在容器内运行，而不是在你的 Mac 上
- **网络隔离**：如果需要可以按容器配置
- **进程隔离**：容器进程无法影响主机
- **非 root 用户**：容器以非特权 `node` 用户（uid 1000）运行

### 提示注入风险

WhatsApp 消息可能包含恶意指令，试图操纵 Claude 的行为。

**缓解：**
- 容器隔离限制爆炸半径
- 只处理注册的组
- 需要触发词（减少意外处理）
- Agent 只能访问其组的挂载目录
- 主组可以为每个组配置额外的目录
- Claude 的内置安全训练

**建议：**
- 只注册受信任的组
- 仔细审查额外的目录挂载
- 定期检查定时任务
- 监控日志中的异常活动

### 凭证存储

| 凭证 | 存储位置 | 注意 |
|------------|------------------|-------|
| Claude CLI 认证 | data/sessions/{group}/.claude/ | 每组隔离，挂载到 /home/node/.claude/ |
| WhatsApp 会话 | store/auth/ | 自动创建，持续约 20 天 |

### 文件权限

groups/ 目录包含个人内存，应受到保护：
```bash
chmod 700 groups/
```

---

## 故障排除

### 常见问题

| 问题 | 原因 | 解决方案 |
|-------|-------|----------|
| 消息无响应 | 服务未运行 | 检查 `launchctl list | grep nanoclaw` |
| "Claude Code process exited with code 1" | 容器运行时启动失败 | 检查日志；NanoClaw 自动启动容器运行时但可能失败 |
| "Claude Code process exited with code 1" | 会话挂载路径错误 | 确保挂载到 `/home/node/.claude/` 而不是 `/root/.claude/` |
| 会话不继续 | 会话 ID 未保存 | 检查 SQLite：`sqlite3 store/messages.db "SELECT * FROM sessions"` |
| 会话不继续 | 挂载路径不匹配 | 容器用户是 `node`，HOME=/home/node；会话必须在 `/home/node/.claude/` |
| "QR code 过期" | WhatsApp 会话过期 | 删除 store/auth/ 并重启 |
| "未注册组" | 未添加组 | 在主通道使用 `@Andy add group "名称"` |

### 日志位置

- `logs/nanoclaw.log` - stdout
- `logs/nanoclaw.error.log` - stderr

### 调试模式

手动运行以获取详细输出：
```bash
npm run dev
# 或
node dist/index.js
```
