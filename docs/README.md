# NanoClaw 文档

本目录包含 NanoClaw 项目的详细技术文档。

## 文档索���

### 架构文档

| 文档 | 说明 |
|------|------|
| [**PROJECT-STRUCTURE.md**](PROJECT-STRUCTURE.md) | 项目目录结构详解，包含所有目录的职责说明和关键设计模式 |
| [**CONTAINER-ARCHITECTURE.md**](CONTAINER-ARCHITECTURE.md) | Agent 容器运行原理，包含通信机制、池化管理、生命周期 |
| [**DATABASE-SCHEMA.md**](DATABASE-SCHEMA.md) | 数据库表设计，��含所有表结构、索引、关系图和 API |

### 设计文档

| 文档 | 说明 |
|------|------|
| [**REQUIREMENTS.md**](REQUIREMENTS.md) | 架构决策记录 (ADR)，项目的技术选型原因 |
| [**SPEC.md**](SPEC.md) | 功能规格说明 |
| [**SECURITY.md**](SECURITY.md) | 安全模型说明 |

### 部署文档

| 文档 | 说明 |
|------|------|
| [**DEPLOYMENT.md**](DEPLOYMENT.md) | 部署指南 |
| [**docker-sandboxes.md**](docker-sandboxes.md) | Docker 沙箱隔离方案 |

### 企业微信集成

| 文档 | 说明 |
|------|------|
| [**WECOM-SDK-INTEGRATION.md**](WECOM-SDK-INTEGRATION.md) | 企业微信 SDK 集成指南，包含消息接收流程、回复机制、完整流程图 |

### 其他

| 文档 | 说明 |
|------|------|
| [**session-architecture.md**](session-architecture.md) | 会话架构设计 |
| [**skills-as-branches.md**](skills-as-branches.md) | 技能分支机制说明 |
| [**SDK_DEEP_DIVE.md**](SDK_DEEP_DIVE.md) | Claude Agent SDK 深入解析 |
| [**BRANCH-FORK-MAINTENANCE.md**](BRANCH-FORK-MAINTENANCE.md) | 分支和 Fork 维护指南 |
| [**APPLE-CONTAINER-NETWORKING.md**](APPLE-CONTAINER-NETWORKING.md) | Apple Container 网络配置 |
| [**DEBUG_CHECKLIST.md**](DEBUG_CHECKLIST.md) | 调试检查清单 |

## 快速导航

### 我想了解...

- **项目整体结构** → [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md)
- **容器如何运行** → [CONTAINER-ARCHITECTURE.md](CONTAINER-ARCHITECTURE.md)
- **数据库设计** → [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md)
- **为什么这样设计** → [REQUIREMENTS.md](REQUIREMENTS.md)
- **安全机制** → [SECURITY.md](SECURITY.md)
- **如何部署** → [DEPLOYMENT.md](DEPLOYMENT.md)
- **企业微信集成** → [WECOM-SDK-INTEGRATION.md](WECOM-SDK-INTEGRATION.md)
- **如何调试** → [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)

## 核心概念

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    NanoClaw 主进程                           │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 消息循环     │  │ 容器池管理   │  │ 任务调度器          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                │                    │              │
│         ▼                ▼                    ▼              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 渠道注册中心 │  │ 容器运行时   │  │ SQLite 数据库       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Docker 容器 (隔离)                        │
│                                                             │
│  Claude Agent SDK + MCP Tools + 群组文件系统                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计模式

| 模式 | 说明 | 相关文件 |
|------|------|----------|
| 渠道自注册 | 启动时自动发现和注册渠道 | `src/channels/registry.ts` |
| 群组隔离 | 每个群组独立文件系统和记忆 | `groups/{name}/` |
| 技能分支 | 功能通过分支合并安装 | `.claude/skills/` |
| IPC 通信 | 主进程与容器通过文件通信 | `data/ipc/{name}/` |

### 数据流

```
消息渠道 → 主进程 → 容器 → Agent SDK → 响应 → 主进程 → 消息渠道
              │                          │
              ▼                          ▼
         SQLite 数据库              群组记忆文件
```

## 开发指南

### 本地开发

```bash
npm run dev          # 热重载开发模式
npm run build        # 编译 TypeScript
./container/build.sh # 重建容器镜像
```

### 目录结构

```
nanoclaw/
├── src/              # 主进程源码
├── container/        # 容器构建文件
├── groups/           # 群组数据
├── data/             # 运行时数据
├── docs/             # 文档
└── .claude/skills/   # 功能技能
```

详细说明见 [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md)

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：状态管理、消息循环 |
| `src/container-runner.ts` | 容器启动和 IPC（定时任务） |
| `src/router.ts` | 消息路由 |
| `src/channels/registry.ts` | 渠道注册 |
| `src/db.ts` | 数据库操作 |

## 外部资源

- [官方文档](https://docs.nanoclaw.dev)
- [API 参考](https://docs.nanoclaw.dev/api)
- [更新日志](https://docs.nanoclaw.dev/changelog)
- [Discord 社区](https://discord.gg/VDdww8qS42)

---

*最后更新: 2026-04-06 (重构: 简化容器管理)*
