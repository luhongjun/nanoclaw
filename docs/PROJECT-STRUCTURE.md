# NanoClaw 项目目录结构

本文档记录 NanoClaw 项目的目录结构和架构设计。

## 目录概览

```
nanoclaw/
├── src/                    # 主进程源代码 (TypeScript)
├── container/              # Agent 容器构建
├── groups/                 # 群组隔离存储
├── data/                   # 运行时数据
├── .claude/skills/         # 功能技能（分支合并式）
├── docs/                   # 文档
├── scripts/                # 工具脚本
├── config-examples/        # 配置示例
└── assets/                 # 静态资源
```

## 详细结构

### src/ - 主进程源代码

单 Node.js 进程，负责状态管理、消息路由和容器调度。

```
```
src/
├── index.ts               # 入口：状态管理、消息循环、agent 调用
├── channels/              # 渠道系统
│   ├── registry.ts        # 渠道注册中心（自注册机制）
│   ├── index.ts           # 渠道导出
│   └── wecom.ts           # 企业微信渠道实现
├── container-runner.ts    # 一次性容器执行器（消息处理 + 定时任务）
├── container-runtime.ts   # 容器运行时抽象（Docker/Apple Container）
├── router.ts              # 消息格式化与出站路由
├── ipc.ts                 # IPC 监听器与任务处理
├── db.ts                  # SQLite 数据库操作
├── task-scheduler.ts      # 定时任务调度
├── group-folder.ts        # 群组文件夹管理
├── remote-control.ts      # 远程控制功能
├── sender-allowlist.ts    # 发送者白名单
├── mount-security.ts      # 挂载安全检查
├── timezone.ts            # 时区处理
├── logger.ts              # 日志工具
├── env.ts                 # 环境变量
├── types.ts               # 类型定义
├── config.ts              # 触发模式、路径、间隔配置
└── *.test.ts              # 单元测试文件
```
```

### container/ - Agent 容器

Docker 容器镜像，运行 Claude Agent SDK。

```
container/
├── Dockerfile             # 容器镜像定义
├── build.sh               # 构建脚本
├── agent-runner/          # 容器内 agent 运行器
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts           # 容器入口
│       └── ipc-mcp-stdio.ts   # IPC/MCP 通信
└── skills/                # 容器内技能（运行时加载）
    ├── capabilities/      # 能力声明
    ├── status/            # 状态查询
    ├── agent-browser/     # 浏览器能力
    └── slack-formatting/  # Slack 格式化
```

### groups/ - 群组隔离存储

每个群组有独立的文件系统和记忆。

```
groups/
├── global/CLAUDE.md       # 全局群组记忆
├── main/CLAUDE.md         # 主群组记忆
└── wecom-luhj/            # 企业微信群组示例
    ├── CLAUDE.md          # 群组专属记忆
    ├── image*.png         # 群组图片缓存
    └── logs/              # 容器执行日志
```

### data/ - 运行时数据

会话数据和 IPC 通信文件。

```
data/
├── sessions/              # 会话数据（群组独立）
│   └── wecom-luhj/
│       ├── .claude/       # Claude 配置与技能缓存
│       │   ├── settings.json
│       │   ├── skills/    # 技能副本
│       │   └── backups/   # 配置备份
│       └── agent-runner-src/  # agent-runner 源码副本
└── ipc/                   # IPC 通信文件
    └── wecom-luhj/
        ├── current_tasks.json    # 当前任务
        └── available_groups.json # 可用群组
```

### .claude/skills/ - 功能技能

通过分支合并安装的功能模块。

| 技能 | 用途 |
|------|------|
| add-telegram | Telegram 渠道集成 |
| add-slack | Slack 渠道集成 |
| add-whatsapp | WhatsApp 渠道集成 |
| add-discord | Discord 渠道集成 |
| add-gmail | Gmail 集成 |
| add-voice-transcription | 语音转文字 |
| add-image-vision | 图像视觉能力 |
| add-pdf-reader | PDF 阅读能力 |
| setup | 初始安装和配置 |
| debug | 容器调试工具 |
| customize | 自定义行为配置 |
| claw | CLI 工具安装 |
| init-onecli | OneCLI Agent Vault 初始化 |
| update-nanoclaw | 上游更新合并 |
| x-integration | X (Twitter) 集成 |

### docs/ - 文档

```
docs/
├── REQUIREMENTS.md        # 架构决策记录
├── SPEC.md                # 规格说明
├── SECURITY.md            # 安全说明
├── DEPLOYMENT.md          # 部署指南
├── WECOM-*.md             # 企业微信相关文档
├── session-architecture.md # 会话架构
├── skills-as-branches.md  # 技能分支机制
└── docker-sandboxes.md    # Docker 沙箱说明
```

### scripts/ - 工具脚本

```
scripts/
├── run-migrations.ts      # 数据库迁移
├── check-messages.js      # 消息检查
└── migrate-sessions.js    # 会话迁移
```

## 架构层级

| 层级 | 目录 | 职责 |
|------|------|------|
| 主进程 | `src/` | 单 Node.js 进程，管理状态和消息路由 |
| 渠道层 | `src/channels/` | 渠道自注册系统，启动时自动注册 |
| 容器层 | `container/` | Docker 容器镜像，运行 Claude Agent SDK |
| 群组层 | `groups/` | 每个群组独立文件系统和记忆 |
| 会话层 | `data/sessions/` | 运行时会话数据，群组隔离 |
| 技能层 | `.claude/skills/` | 功能技能，通过分支合并安装 |

## 关键设计模式

### 1. 渠道自注册

`src/channels/registry.ts` 在启动时自动发现和注册渠道：

```typescript
// 渠道在导入时自动注册
ChannelRegistry.register(new WeComChannel());
```

### 2. 群组隔离

每个群组有独立的 `groups/{name}/` 目录：

- `CLAUDE.md` - 群组专属记忆
- `logs/` - 容器执行日志
- 其他文件 - 群组共享资源

### 3. 容器管理

**消息处理 + 定时任务** (`container-runner.ts`):
- 每批消息创建一个新容器，stdin 传入后立即 EOF，读取输出后销毁
- 会话连续性通过 `sessionId` + `resume` 参数保证
- 支持流式输出和任务队列

### 4. 技能分支

功能通过 `skill/*` 分支合并安装：

```bash
# 安装技能
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram

# 技能代码会被合并到项目中
```

## 数据流

```
消息渠道 (WeCom/Slack/etc)
    ↓
src/channels/ (接收消息)
    ↓
src/router.ts (格式化)
    ↓
src/index.ts (消息循环)
    ↓
container/ (执行 agent)
    ↓
groups/{name}/ (记忆存储)
    ↓
src/router.ts (响应路由)
    ↓
消息渠道 (发送响应)
```

## 配置文件

| 文件 | 用途 |
|------|------|
| `CLAUDE.md` | 项目级 Claude 指令 |
| `groups/{name}/CLAUDE.md` | 群组级 Claude 指令 |
| `config-examples/mount-allowlist.json` | 挂载白名单示例 |
| `.mcp.json` | MCP 服务器配置 |
| `.nvmrc` | Node.js 版本 |
| `.prettierrc` | 代码格式化配置 |

## 测试文件

所有 `*.test.ts` 文件与源码同目录：

- `src/db.test.ts` - 数据库测试
- `src/router.test.ts` - 路由测试
- `src/channels/registry.test.ts` - 渠道注册测试
- `src/container-runner.test.ts` - 容器运行测试
- ...

## 运行时目录

运行时自动创建的目录：

- `data/sessions/{group}/` - 会话数据
- `data/ipc/{group}/` - IPC 通信
- `groups/{group}/logs/` - 容器日志

---

*文档生成时间: 2026-04-06 (重构: 简化容器管理)*
