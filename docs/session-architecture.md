# 会话架构设计文档

> 本文档描述 NanoClaw 的会话管理架构，包括私聊和群聊的会话隔离策略、Agent session 管理机制，以及多通道消息存储设计。

## 底层逻辑

NanoClaw 采用 **Chat-Centric 会话模型** —— 每个物理会话（chat_jid）天然对应一个 Agent session，无需先注册 group。

**设计原则**：
- 私聊按人：每个私聊窗口有独立的 Agent session
- 群聊按群：每个群聊窗口有独立的 Agent session，群内所有用户共享
- 多通道统一：WhatsApp、Telegram、企业微信等所有通道使用相同的会话模型

---

## 会话模型总览

### 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 物理会话层 (chat_jid)                              │
│  ─────────────────────────────────────────────────────────  │
│  - 企业微信私聊：wecom:luhj, wecom:zhangsan                 │
│  - 企业微信群聊：wecom:group123                              │
│  - WhatsApp 私聊：whatsapp:123                               │
│  - WhatsApp 群聊：whatsapp:456@g.us                          │
│  - Telegram 私聊：tg:789                                     │
│  - Telegram 群组：tg:-100123                                 │
└────────────────────┬────────────────────────────────────────┘
                     │ 直接映射
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Agent 会话层 (session_id per chat_jid)             │
│  ─────────────────────────────────────────────────────────  │
│  sessions["wecom:luhj"] = "session_abc123"                  │
│  sessions["wecom:group123"] = "session_xyz789"              │
│  - 每个 chat_jid 有独立的 session_id                           │
│  - 群聊内所有用户共享同一个 session_id                         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 容器内会话 (.jsonl 文件)                            │
│  ─────────────────────────────────────────────────────────  │
│  groups/{folder}/.claude/sessions/{session_id}.jsonl       │
│  - Claude Agent 的 conversation history                     │
│  - 随 session_id 变化而创建/废弃                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 会话映射规则

| 场景 | chat_jid 示例 | session_key | 说明 |
|------|---------------|-------------|------|
| 企业微信私聊 | `wecom:luhj` | `wecom:luhj` | 每人独立 session |
| 企业微信群聊 | `wecom:group123` | `wecom:group123` | 每群独立 session，群内共享 |
| WhatsApp 私聊 | `whatsapp:123` | `whatsapp:123` | 每人独立 session |
| WhatsApp 群聊 | `whatsapp:456@g.us` | `whatsapp:456@g.us` | 每群独立 session |
| Telegram 私聊 | `tg:789` | `tg:789` | 每人独立 session |
| Telegram 群组 | `tg:-100123` | `tg:-100123` | 每群独立 session |

### 会话共享示例

**场景**：企业微信群 `wecom:group123` 内有用户 A、B、C

| 时间 | 事件 | session_key | 说明 |
|------|------|-------------|------|
| T1 | 用户 A @机器人：hi | `wecom:group123` | 创建 session_001 |
| T2 | 用户 B @机器人：hello | `wecom:group123` | 使用 session_001（共享） |
| T3 | 用户 C @机器人：hey | `wecom:group123` | 使用 session_001（共享） |
| T4 | 机器人回复 | `wecom:group123` | 基于 session_001 的上下文 |

**关键设计**：群聊内所有用户的消息都发到同一个 `chat_jid`（群 ID），天然共享同一个 Agent session。

---

## 数据库设计

### sessions 表

```sql
CREATE TABLE sessions (
  chat_jid TEXT PRIMARY KEY,           -- 物理会话标识（私聊/群聊）
  session_id TEXT NOT NULL,            -- Agent session ID
  group_folder TEXT,                   -- 可选：关联逻辑分组（定时任务用）
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (group_folder) REFERENCES registered_groups(folder)
);
CREATE INDEX idx_sessions_group ON sessions(group_folder);
```

**字段说明**：
- `chat_jid`：物理会话的唯一标识，格式为 `{channel}:{id}`
- `session_id`：Claude Agent 的 conversation ID，容器启动时传入
- `group_folder`：可选字段，用于定时任务按 group 查询 session
- `updated_at`：最后更新时间，用于清理过期 session

### messages 表

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
  msgtype TEXT,                        -- 消息类型：text/image/file/voice/mixed
  metadata TEXT,                       -- JSON 字符串，通道特有信息
  raw_payload TEXT,                    -- 完整原始消息体 JSON
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
CREATE INDEX idx_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_msgtype ON messages(msgtype);
```

**扩展字段说明**：
- `msgtype`：消息类型，用于区分文本、图片、文件、语音、混合消息
- `metadata`：JSON 字符串，存储通道特有信息（req_id、response_url 等）
- `raw_payload`：完整原始消息体 JSON，用于审计和调试

---

## metadata JSON 结构

### 企业微信文本消息

```json
{
  "channel": "wecom",
  "req_id": "hD7y1yvmQrKp7evQhlRTkQAA",
  "msgid": "e95db1c6da2a7cad29d045f5fb40341c",
  "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
  "chattype": "single",
  "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=xxx",
  "response_url_expires": 1775209919,
  "msgtype": "text",
  "from": {
    "userid": "luhj",
    "name": "卢华俊"
  }
}
```

### 企业微信图片消息

```json
{
  "channel": "wecom",
  "req_id": "xxx",
  "msgid": "yyy",
  "aibotid": "zzz",
  "chattype": "single",
  "response_url": "https://...",
  "response_url_expires": 1775209919,
  "msgtype": "image",
  "from": {
    "userid": "luhj",
    "name": "卢华俊"
  },
  "image": {
    "url": "https://example.com/image.png"
  }
}
```

### 企业微信群聊消息

```json
{
  "channel": "wecom",
  "req_id": "xxx",
  "msgid": "yyy",
  "aibotid": "zzz",
  "chattype": "group",
  "response_url": "https://...",
  "response_url_expires": 1775209919,
  "msgtype": "text",
  "from": {
    "userid": "zhangsan",
    "name": "张三"
  },
  "group_id": "group123"
}
```

---

## 消息类型支持

| msgtype | content 格式 | metadata 扩展字段 | Agent 看到的内容 |
|---------|-------------|------------------|-----------------|
| `text` | 原始文本 | - | 文本内容 |
| `image` | `[图片] URL` | `image.url` | `[图片] https://...` |
| `file` | `[文件] filename` | `file.filename`, `file.fileurl` | `[文件] report.pdf` |
| `voice` | `[语音]` | `voice.url` | `[语音] https://...` |
| `mixed` | `[混合消息]` | `mixed.content[]` | `[混合消息] 包含 3 个元素` |

---

## 代码实现

### 核心函数

#### `getSession(chatJid: string): string | undefined`

```typescript
// src/db.ts
export function getSession(chatJid: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE chat_jid = ?')
    .get(chatJid) as { session_id: string } | undefined;
  return row?.session_id;
}
```

#### `setSession(chatJid, sessionId, groupFolder?)`

```typescript
// src/db.ts
export function setSession(
  chatJid: string,
  sessionId: string,
  groupFolder?: string,  // 可选：用于定时任务查询
): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_jid, session_id, group_folder, updated_at) VALUES (?, ?, ?, datetime("now"))',
  ).run(chatJid, sessionId, groupFolder || null);
}
```

#### `getSessionByGroupFolder(groupFolder: string)`

```typescript
// src/db.ts - 用于定时任务
export function getSessionByGroupFolder(
  groupFolder: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}
```

---

## 消息处理流程

### 完整链路

```
┌──────────────────────────────────────────────────────────────────┐
│  1. 企业微信 WebSocket 推送 (官方 SDK)                              │
│  cmd: aibot_msg_callback                                          │
│  body: { from: { userid }, text: { content }, ... }               │
│  headers: { req_id: "xxx" }                                       │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  2. 通道层 (src/channels/wecom.ts)                                │
│  - SDK 事件监听：wsClient.on('message.text', ...)                  │
│  - 缓存 pending reply: { reqId, msgId }                           │
│  - 构建 NewMessage 对象                                           │
│  - 填充 metadata 和 raw_payload                                   │
│  - 调用回调 onMessage(chatJid, msg)                              │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  3. 存储层 (src/db.ts:storeMessage)                               │
│  - INSERT OR REPLACE INTO messages                               │
│  - 字段：id, chat_jid, sender, content, msgtype, metadata, ...   │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  4. 消息轮询 (src/index.ts:startMessageLoop)                      │
│  - getNewMessages() 获取未处理消息                                 │
│  - 检查 trigger 模式（非主组需要触发词）                              │
│  - 调用 processGroupMessages()                                    │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  5. Agent 处理 (src/container-runner.ts)                          │
│  - getSession(chatJid) 获取 session_id                            │
│  - runContainerAgent(sessionId, ...)                             │
│  - 容器内 Claude 处理消息                                          │
│  - 输出新 session_id → setSession(chatJid, newId)                │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  6. 回复消息 (src/channels/wecom.ts:sendMessage)                  │
│  - 获取缓存的 pending reply: { reqId, msgId }                     │
│  - SDK reply(): wsClient.reply({ headers: { req_id } }, body)   │
│  - msgtype: 'markdown' (WeCom 要求)                                │
│  - 等待 ack 确认                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 定时任务适配

定时任务仍按 `group_folder` 管理 session：

```typescript
// src/task-scheduler.ts
let sessionId: string | undefined;
if (task.context_mode === 'group') {
  // 优先使用 chat_jid，没有则使用 group_folder
  sessionId = task.chat_jid
    ? sessions[task.chat_jid]
    : getSessionByGroupFolder(task.group_folder);
}
```

**context_mode 说明**：
- `'group'`：使用 group 的共享 session
- `'isolated'`：使用独立的 session（不共享）

---

## 迁移指南

### 从旧架构迁移

```sql
-- Step 1: 备份旧数据
ALTER TABLE sessions RENAME TO sessions_old;

-- Step 2: 创建新表
CREATE TABLE sessions (
  chat_jid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  group_folder TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (group_folder) REFERENCES registered_groups(folder)
);
CREATE INDEX idx_sessions_group ON sessions(group_folder);

-- Step 3: 迁移数据（通过 registered_groups 映射）
INSERT INTO sessions (chat_jid, session_id, group_folder, updated_at)
SELECT rg.jid, so.session_id, so.group_folder, datetime('now')
FROM sessions_old so
JOIN registered_groups rg ON rg.folder = so.group_folder;

-- Step 4: 清理
DROP TABLE sessions_old;
```

### 消息表扩展

```sql
ALTER TABLE messages ADD COLUMN metadata TEXT;
ALTER TABLE messages ADD COLUMN msgtype TEXT;
ALTER TABLE messages ADD COLUMN raw_payload TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_msgtype ON messages(msgtype);
```

---

## 验收标准

### 会话隔离验证

```bash
# 验证 1：私聊独立 session
sqlite3 store/messages.db "SELECT * FROM sessions WHERE chat_jid = 'wecom:luhj';"
# 预期：返回 1 条记录

# 验证 2：群聊共享 session（用户 A 和用户 B 同群）
sqlite3 store/messages.db "SELECT * FROM sessions WHERE chat_jid = 'wecom:group123';"
# 预期：返回 1 条记录（两人共享）
```

### 消息完整存储验证

```bash
# 验证 1：文本消息完整存储
sqlite3 store/messages.db "SELECT id, msgtype, metadata, raw_payload FROM messages WHERE msgtype = 'text' LIMIT 1;"
# 预期：metadata 和 raw_payload 非空

# 验证 2：图片消息存储
sqlite3 store/messages.db "SELECT id, msgtype, content, metadata FROM messages WHERE msgtype = 'image' LIMIT 1;"
# 预期：metadata 包含 image.url 字段
```

---

## 相关文件

- `src/db.ts` — 数据库操作和 session 管理
- `src/index.ts` — 消息路由和 session 调用
- `src/channels/wecom.ts` — 企业微信消息解析和 metadata 填充（使用官方 SDK）
- `src/router.ts` — 消息格式化（支持多媒体）
- `src/task-scheduler.ts` — 定时任务 session 适配

---

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-04-04 | 1.1 | 更新消息流程：添加官方 SDK 回复链路 |
| 2026-04-03 | 1.0 | 初始版本：Chat-Centric 会话模型 + 完整消息存储 |
