# 数据库表设计

本文档详细说明 NanoClaw 使用的 SQLite 数据库表��构。

## 概述

- **数据库文件**: `data/store/messages.db`
- **数据库引擎**: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **初始化**: `src/db.ts` 中的 `initDatabase()` 函数

## 表结构

### 1. chats - 聊天元数据

存储所有聊天（群组/私聊）的元数据，不存储消息内容。

| ���段 | 类型 | 说明 |
|------|------|------|
| `jid` | TEXT | 主键，聊天标识符 |
| `name` | TEXT | 聊天名称 |
| `last_message_time` | TEXT | 最后消息时间 (ISO 8601) |
| `channel` | TEXT | 渠道类型 (whatsapp/telegram/discord/wecom) |
| `is_group` | INTEGER | 是否群组 (0=私聊, 1=群组) |

**JID 格式示例**:
- WhatsApp 群组: `120363336345536173@g.us`
- WhatsApp 私聊: `8613800138000@s.whatsapp.net`
- Telegram: `tg:-1001234567890`
- Discord: `dc:1234567890123456`
- 企业微信: `wecom:luhj`

```sql
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);
```

**特殊记录**:
- `jid = '__group_sync__'` - 用于记录群组元数据同步时间

---

### 2. messages - 消息存储

存储已注册群组的消息历史。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 消息ID (复合主键之一) |
| `chat_jid` | TEXT | 聊天JID (复合主键之一，外键) |
| `sender` | TEXT | 发送者ID |
| `sender_name` | TEXT | 发送者名称 |
| `content` | TEXT | 消息内容 |
| `timestamp` | TEXT | 消息时间 (ISO 8601) |
| `is_from_me` | INTEGER | 是否自己发送 (0/1) |
| `is_bot_message` | INTEGER | 是否机器人消息 (0/1) |
| `msgtype` | TEXT | 消息类型 (text/image/file/voice/mixed/video/event) |
| `metadata` | TEXT | 元数据 (JSON) |
| `raw_payload` | TEXT | 原始消息载荷 (JSON) |

**索引**:
- `idx_timestamp` - 按时间索引，用于按时间查询

```sql
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  msgtype TEXT,
  metadata TEXT,
  raw_payload TEXT,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

CREATE INDEX idx_timestamp ON messages(timestamp);
```

**消息类型 (msgtype)**:
| 值 | 说明 |
|----|------|
| `text` | 文本消息 |
| `image` | 图片消息 |
| `file` | 文件消息 |
| `voice` | 语音消息 |
| `mixed` | 混合消息（图文等） |
| `video` | 视频消息 |
| `event` | 事件消息（群组事件等） |

---

### 3. registered_groups - 已注册群组

存储已激活的群组配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| `jid` | TEXT | 主键，群组JID |
| `name` | TEXT | 群组名称 |
| `folder` | TEXT | 群组文件夹名 (UNIQUE) |
| `trigger_pattern` | TEXT | 触发词模式 |
| `added_at` | TEXT | 注册时间 (ISO 8601) |
| `container_config` | TEXT | 容器配置 (JSON) |
| `requires_trigger` | INTEGER | 是否需要触发词 (0/1/NULL) |
| `is_main` | INTEGER | 是否主群组 (0/1) |

```sql
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1,
  is_main INTEGER DEFAULT 0
);
```

**container_config JSON 结构**:
```json
{
  "additionalMounts": [
    {
      "hostPath": "/Users/xxx/Obsidian",
      "containerPath": "/workspace/obsidian",
      "readonly": true
    }
  ],
  "timeout": 600000
}
```

---

### 4. sessions - 会话管理

存储 Agent 会话 ID，用于恢复对话上下文。

| 字段 | 类型 | 说明 |
|------|------|------|
| `chat_jid` | TEXT | 主键，聊天JID |
| `session_id` | TEXT | Agent 会话ID |
| `group_folder` | TEXT | 关联的群组文件夹 (外键) |
| `updated_at` | TEXT | 更新时间 (ISO 8601) |

**索引**:
- `idx_sessions_group` - 按群组文件夹索引

```sql
CREATE TABLE sessions (
  chat_jid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  group_folder TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (group_folder) REFERENCES registered_groups(folder)
);

CREATE INDEX idx_sessions_group ON sessions(group_folder);
```

---

### 5. scheduled_tasks - 定时任务

存储计划任务的配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，任务ID |
| `group_folder` | TEXT | 群组文件夹 |
| `chat_jid` | TEXT | 目标聊天JID |
| `prompt` | TEXT | 执行提示词 |
| `script` | TEXT | 预执行脚本 |
| `schedule_type` | TEXT | 调度类型 (cron/interval/once) |
| `schedule_value` | TEXT | 调度值 |
| `context_mode` | TEXT | 上下文模式 (group/isolated) |
| `next_run` | TEXT | 下次运行时间 |
| `last_run` | TEXT | 上次运行时间 |
| `last_result` | TEXT | 上次运行结果 |
| `status` | TEXT | 状态 (active/paused/completed) |
| `created_at` | TEXT | 创建时间 |

**索引**:
- `idx_next_run` - 按下次运行时间索引
- `idx_status` - 按状态索引

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  script TEXT,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_next_run ON scheduled_tasks(next_run);
CREATE INDEX idx_status ON scheduled_tasks(status);
```

**调度类型**:
| 类型 | 值格式 | 示例 |
|------|--------|------|
| `cron` | Cron 表达式 | `0 9 * * *` (每天9点) |
| `interval` | 毫秒数 | `300000` (5分钟) |
| `once` | 本地时间戳 | `2026-04-06T15:30:00` |

**上下文模式**:
| 模式 | 说明 |
|------|------|
| `group` | 在群组对话上下文中运行 |
| `isolated` | 在独立会话中运行 |

---

### 6. task_run_logs - 任务运行日志

记录定时任务的执行历史。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 主键 (自增) |
| `task_id` | TEXT | 任务ID (外键) |
| `run_at` | TEXT | 运行时间 (ISO 8601) |
| `duration_ms` | INTEGER | 执行时长 (毫秒) |
| `status` | TEXT | 执行状态 (success/error) |
| `result` | TEXT | 执行结果 |
| `error` | TEXT | 错误信息 |

**索引**:
- `idx_task_run_logs` - 按任务ID和运行时间索引

```sql
CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);

CREATE INDEX idx_task_run_logs ON task_run_logs(task_id, run_at);
```

---

### 7. router_state - 路由状态

存储消息路由的状态信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | TEXT | 主键，状态键 |
| `value` | TEXT | 状态值 |

```sql
CREATE TABLE router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**已知键**:
| 键 | 说明 |
|----|------|
| `last_timestamp` | 最后处理的消息时间戳 |
| `last_agent_timestamp` | 各群组最后 Agent 响应时间 (JSON) |

---

## 实体关系图

```
┌─────────────────┐       ┌───────────────────┐
│     chats       │       │ registered_groups │
├─────────────────┤       ├───────────────────┤
│ jid (PK)        │◀──────│ jid (PK)          │
│ name            │       │ name              │
│ last_message_   │       │ folder (UQ)       │
│ time            │       │ trigger_pattern   │
│ channel         │       │ added_at          │
│ is_group        │       │ container_config  │
└────────┬────────┘       │ requires_trigger  │
         │                │ is_main           │
         │                └────────┬──────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐       ┌───────────────────┐
│    messages     │       │     sessions      │
├─────────────────┤       ├───────────────────┤
│ id              │       │ chat_jid (PK)     │
│ chat_jid (FK)   │       │ session_id        │
│ sender          │       │ group_folder (FK) │
│ sender_name     │       │ updated_at        │
│ content         │       └───────────────────┘
│ timestamp       │
│ is_from_me      │       ┌───────────────────┐
│ is_bot_message  │       │ scheduled_tasks   │
│ msgtype         │       ├───────────────────┤
│ metadata        │       │ id (PK)           │
│ raw_payload     │       │ group_folder (FK) │
└─────────────────┘       │ chat_jid          │
                          │ prompt            │
┌─────────────────┐       │ script            │
│ router_state    │       │ schedule_type     │
├─────────────────┤       │ schedule_value    │
│ key (PK)        │       │ context_mode      │
│ value           │       │ next_run          │
└─────────────────┘       │ last_run          │
                          │ last_result       │
                          │ status            │
                          │ created_at        │
                          └────────┬──────────┘
                                   │
                                   ▼
                          ┌───────────────────┐
                          │  task_run_logs    │
                          ├───────────────────┤
                          │ id (PK, AUTO)     │
                          │ task_id (FK)      │
                          │ run_at            │
                          │ duration_ms       │
                          │ status            │
                          │ result            │
                          │ error             │
                          └───────────────────┘
```

---

## 数据迁移

数据库支持从 JSON 文件迁移（向后兼容）：

| JSON 文件 | 目标表 | 迁移后重命名 |
|-----------|--------|-------------|
| `data/router_state.json` | `router_state` | `.migrated` |
| `data/sessions.json` | `sessions` | `.migrated` |
| `data/registered_groups.json` | `registered_groups` | `.migrated` |

---

## Schema 迁移

数据库使用渐进式迁移，通过 `ALTER TABLE` 添加新列：

```typescript
// 示例：添加新列
try {
  database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
} catch {
  /* 列已存在 */
}
```

**已添加的迁移列**:
- `scheduled_tasks.context_mode` - 上下文模式
- `scheduled_tasks.script` - 预执行脚本
- `messages.is_bot_message` - 机器人消息标记
- `messages.metadata` - 消息元数据
- `messages.msgtype` - 消息类型
- `messages.raw_payload` - 原始载荷
- `registered_groups.is_main` - 主群组标记
- `chats.channel` - 渠道类型
- `chats.is_group` - 群组标记

---

## API 概览

### 聊天操作
```typescript
storeChatMetadata(chatJid, timestamp, name?, channel?, isGroup?)
updateChatName(chatJid, name)
getAllChats(): ChatInfo[]
getLastGroupSync(): string | null
setLastGroupSync()
```

### 消息操作
```typescript
storeMessage(msg: NewMessage)
storeMessageDirect(msg)
getNewMessages(jids[], lastTimestamp, botPrefix, limit?): { messages, newTimestamp }
getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit?): NewMessage[]
getLastBotMessageTimestamp(chatJid, botPrefix): string | undefined
```

### 任务操作
```typescript
createTask(task)
getTaskById(id): ScheduledTask | undefined
getTasksForGroup(groupFolder): ScheduledTask[]
getAllTasks(): ScheduledTask[]
updateTask(id, updates)
deleteTask(id)
getDueTasks(): ScheduledTask[]
updateTaskAfterRun(id, nextRun, lastResult)
logTaskRun(log: TaskRunLog)
```

### 会话操作
```typescript
getSession(chatJid): string | undefined
setSession(chatJid, sessionId, groupFolder?)
deleteSession(chatJid)
getAllSessions(): Record<string, string>
getSessionByGroupFolder(groupFolder): string | undefined // deprecated
```

### 群组操作
```typescript
getRegisteredGroup(jid): (RegisteredGroup & { jid: string }) | undefined
setRegisteredGroup(jid, group: RegisteredGroup)
getAllRegisteredGroups(): Record<string, RegisteredGroup>
```

### 状态操作
```typescript
getRouterState(key): string | undefined
setRouterState(key, value)
```

---

*文档生成时间: 2026-04-06*
