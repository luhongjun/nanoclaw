# NanoClaw 文档

官方文档请访问 **[docs.nanoclaw.dev](https://docs.nanoclaw.dev)**。

本目录中的文件是原始设计文档和开发者参考。最新和最全的信息请访问官方文档站点。

## 本地文档目录

| 文档 | 说明 |
|------|------|
| [session-architecture.md](session-architecture.md) | 会话架构设计：私聊按人、群聊按群、消息完整存储 |
| [wecom-message-format.md](wecom-message-format.md) | 企业微信消息格式规范：WebSocket 协议详解 |
| [SPEC.md](SPEC.md) | 技术规格说明书 |
| [SECURITY.md](SECURITY.md) | 安全模型说明 |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 需求文档 |
| [skills-as-branches.md](skills-as-branches.md) | Skills 系统设计 |
| [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md) | 调试检查清单 |
| [docker-sandboxes.md](docker-sandboxes.md) | Docker 沙箱设计 |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Apple 容器网络配置 |

## 文档索引

### 架构设计

- [session-architecture.md](session-architecture.md) — 会话架构设计文档
  - Chat-Centric 会话模型
  - 私聊按人、群聊按群
  - metadata 和 raw_payload 存储设计

- [SPEC.md](SPEC.md) — 技术规格说明书
  - 系统整体架构
  - 模块设计
  - 数据流设计

- [docker-sandboxes.md](docker-sandboxes.md) — Docker 沙箱设计
  - 容器隔离机制
  - 文件系统挂载
  - 网络配置

### 集成文档

- [wecom-message-format.md](wecom-message-format.md) — 企业微信消息格式
  - WebSocket 协议
  - 消息类型详解
  - 回复机制

- [skills-as-branches.md](skills-as-branches.md) — Skills 系统
  - Skill 设计原理
  - 开发规范
  - 发布流程

### 安全与调试

- [SECURITY.md](SECURITY.md) — 安全模型
  - 容器安全
  - 凭证管理
  - 权限控制

- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md) — 调试检查清单
  - 常见问题排查
  - 日志分析
  - 故障恢复

### 运维文档

- [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) — Apple 容器网络
  - macOS 网络配置
  - 端口映射
  - 防火墙设置

- [REQUIREMENTS.md](REQUIREMENTS.md) — 需求文档
  - 功能需求
  - 非功能需求
  - 验收标准

## 文档更新记录

| 日期 | 文档 | 更新内容 |
|------|------|----------|
| 2026-04-03 | session-architecture.md | 新增：会话架构设计文档 |
| 2026-04-03 | wecom-message-format.md | 新增：企业微信消息格式规范 |
