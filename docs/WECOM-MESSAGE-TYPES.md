# 企业微信消息类型分析

> 本文档分析企业微信 AI Bot SDK 接收到的消息类型与特征，用于指导后续代码设计和消息处理逻辑。

**最后更新**: 2026-04-04  
**数据来源**: 实际运行日志和数据库记录

---

## 消息类型总览

| 类型 | msgtype | content 字段 | 关键数据位置 | 日志标识 |
|------|---------|-------------|-------------|---------|
| **text** | `"text"` | 有文本内容 | `body.text.content` | `[WeCom] SDK received text message` |
| **image** | `"image"` | 空 | `body.image.url`, `body.image.aeskey` | `[WeCom] SDK received image message` |
| **file** | `"file"` | 空 | `body.file.url`, `body.file.aeskey` | `[WeCom] SDK received file message` |
| **voice** | `"voice"` | 空 | `body.voice.url`, `body.voice.aeskey` | `[WeCom] SDK received voice message` |
| **mixed** | `"mixed"` | 空 | `body.mixed.msg_item[]` | `[WeCom] SDK received mixed message` |

**注意：**
- 非文本消息（image/file/voice/mixed）的 `content` 字段为空
- 数据库查询时必须通过 `msgtype IN (...)` 放行，否则会被过滤
- `text` 消息可能包含 `quote` 字段表示引用回复

---

## 数据库设计检查

### 当前设计

```sql
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,           -- 文本消息存内容，非文本消息为空
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  msgtype TEXT,           -- text/image/file/voice/mixed
  metadata TEXT,          -- JSON 字符串，存储通道特定数据
  raw_payload TEXT,       -- JSON 字符串，完整原始报文
  PRIMARY KEY (id, chat_jid)
);
```

### 设计评估

**✅ 合理之处：**
1. `msgtype` 字段区分消息类型 — 支持多类型查询
2. `metadata` 存储结构化数据 — 便于访问常用字段
3. `raw_payload` 完整保存 — 可回溯原始数据

**⚠️ 待改进：**
1. `content` 字段语义不统一 — 文本消息存内容，非文本消息为空
   - 建议：考虑添加 `text_content` 字段，或统一 content 格式
2. `metadata` 结构不固定 — 依赖代码维护
   - 建议：文档化各 msgtype 的 metadata 结构

### 各类型 metadata 结构

**text:**
```json
{
  "req_id": "...",
  "msgid": "...",
  "aibotid": "...",
  "chattype": "single",
  "from": {"userid": "..."},
  "quote": {"msgtype": "text", "text": {"content": "..."}}  // 可选
}
```

**image:**
```json
{
  "req_id": "...",
  "msgid": "...",
  "image": {
    "url": "https://...",
    "aeskey": "..."
  }
}
```

**file:**
```json
{
  "req_id": "...",
  "msgid": "...",
  "file": {
    "url": "https://...",
    "aeskey": "...",
    "filename": "...",
    "file_size": "..."
  }
}
```

**mixed:**
```json
{
  "req_id": "...",
  "msgid": "...",
  "mixed": {
    "msg_item": [
      {"msgtype": "text", "text": {"content": "..."}},
      {"msgtype": "image", "image": {"url": "...", "aeskey": "..."}}
    ]
  }
}
```

---

## 1. text（文本消息）

### 特征
- 最常见的消息类型（占比约 85%）
- `content` 字段包含实际文本
- 可能包含 `quote` 字段表示引用回复

### 原始报文示例

```json
{
  "cmd": "aibot_msg_callback",
  "headers": {"req_id": "5UA36x6tQye1ux_l9hDGTgAA"},
  "body": {
    "msgid": "0a65bd64be3d46644f6a66901d87d0aa",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "chattype": "single",
    "from": {"userid": "luhj"},
    "msgtype": "text",
    "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?...",
    "text": {
      "content": "我引用这句话是什么"
    },
    "quote": {
      "msgtype": "text",
      "text": {"content": "在吗"}
    }
  }
}
```

### 数据库存储
```typescript
{
  msgtype: 'text',
  content: '我引用这句话是什么',
  metadata: {
    req_id: '5UA36x6tQye1ux_l9hDGTgAA',
    msgid: '0a65bd64be3d46644f6a66901d87d0aa',
    aibotid: 'aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c',
    chattype: 'single',
    from: {userid: 'luhj'},
    quote: {msgtype: 'text', text: {content: '在吗'}}
  }
}
```

### 处理代码位置
`src/channels/wecom.ts:184-207`

---

## 2. image（图片消息）

### 特征
- `content` 为空（图片消息没有文本内容）
- 图片 URL 存储在 COS（腾讯云对象存储）
- 需要 `aeskey` 解密图片

### 原始报文示例

```json
{
  "cmd": "aibot_msg_callback",
  "headers": {"req_id": "YTmioq1HRuiuiOXoRmaMIAAA"},
  "body": {
    "msgid": "b2c5fe7e4d34ab21545fa25ebfa701bc",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "chattype": "single",
    "from": {"userid": "luhj"},
    "msgtype": "image",
    "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?...",
    "image": {
      "url": "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/BGFT1GK/7624763334239690015?sign=...",
      "aeskey": "uMbOwKQ8R4KvFoGGkJNd1U9uys2gqkBvjoF9sMKPOKI"
    }
  }
}
```

### 数据库存储
```typescript
{
  msgtype: 'image',
  content: '',
  metadata: {
    req_id: 'YTmioq1HRuiuiOXoRmaMIAAA',
    msgid: 'b2c5fe7e4d34ab21545fa25ebfa701bc',
    image: {
      url: 'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/...',
      aeskey: 'uMbOwKQ8R4KvFoGGkJNd1U9uys2gqkBvjoF9sMKPOKI'
    }
  },
  raw_payload: '...' // 完整原始报文
}
```

### 处理代码位置
`src/channels/wecom.ts:208-235`

---

## 3. file（文件消息）

### 特征
- `content` 为空（文件消息没有文本内容）
- 文件 URL 存储在 COS，带签名
- 需要 `aeskey` 解密文件

### 原始报文示例

```json
{
  "cmd": "aibot_msg_callback",
  "headers": {"req_id": "aIDI65fDSeaEaNrqv9RAnQAA"},
  "body": {
    "msgid": "2940c0b22da085e147f7cda056bf6bfb",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "chattype": "single",
    "from": {"userid": "luhj"},
    "msgtype": "file",
    "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?...",
    "file": {
      "url": "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/Lg6uqaM/7624797395767098646?sign=q-sign-algorithm%3Dsha1%26...",
      "aeskey": "BLtp2jLqS76plm0us09stU2njhb2vEYNtNf5jcZPRns"
    }
  }
}
```

### 数据库存储
```typescript
{
  msgtype: 'file',
  content: '',
  metadata: {
    req_id: 'aIDI65fDSeaEaNrqv9RAnQAA',
    msgid: '2940c0b22da085e147f7cda056bf6bfb',
    file: {
      url: 'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/...?sign=...',
      aeskey: 'BLtp2jLqS76plm0us09stU2njhb2vEYNtNf5jcZPRns'
    }
  }
}
```

### 处理代码位置
`src/channels/wecom.ts:236-260`

---

## 4. mixed（混合消息）

### 特征
- `content` 为空
- 包含多个消息项的数组
- 每项可以是 text、image 等类型
- 用户同时发送文本和图片时产生

### 原始报文示例

```json
{
  "cmd": "aibot_msg_callback",
  "headers": {"req_id": "fvZma18OQEWvygkmyM5cXAAA"},
  "body": {
    "msgid": "e76f959a918140e683f2f40406e178e0",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "chattype": "single",
    "from": {"userid": "luhj"},
    "msgtype": "mixed",
    "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?...",
    "mixed": {
      "msg_item": [
        {
          "msgtype": "text",
          "text": {"content": "2. 显示评分开关：控制分数、完成率两项的显示；关闭则两项都不显示；"}
        },
        {
          "msgtype": "image",
          "image": {
            "url": "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/f40yHJ4/7624797590510934590?sign=...",
            "aeskey": "uMbOwKQ8R4KvFoGGkJNd1U9uys2gqkBvjoF9sMKPOKI"
          }
        }
      ]
    }
  }
}
```

### 数据库存储
```typescript
{
  msgtype: 'mixed',
  content: '',
  metadata: {
    req_id: 'fvZma18OQEWvygkmyM5cXAAA',
    msgid: 'e76f959a918140e683f2f40406e178e0',
    mixed: {
      msg_item: [
        {msgtype: 'text', text: {content: '...'}},
        {msgtype: 'image', image: {url: '...', aeskey: '...'}}
      ]
    }
  }
}
```

### 处理代码位置
`src/channels/wecom.ts:286-310`

---

## 消息处理链路

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    企业微信 AI Bot WebSocket                             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SDK Listener (src/channels/wecom.ts:135-138)                           │
│  aiBot.on('message', async (frame) => handleSDKMessage(frame))         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  handleSDKMessage(frame)                                                │
│  ├─ 提取 body, headers, msgtype                                        │
│  └─ 根据 msgtype 分支处理                                              │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         │                                               │
         ▼                                               ▼
┌─────────────────┐                           ┌─────────────────┐
│ msgtype=text    │                           │ msgtype=image   │
│ content=body.text.content │                 │ content=""      │
│ metadata=body.text        │                 │ metadata=image  │
└────────┬────────┘                           └────────┬────────┘
         │                                             │
         ▼                                             ▼
┌─────────────────┐                           ┌─────────────────┐
│ msgtype=file    │                           │ msgtype=mixed   │
│ content=""      │                           │ content=""      │
│ metadata=file   │                           │ metadata=mixed  │
└────────┬────────┘                           └────────┬────────┘
         │                                             │
         └───────────────────────┬─────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  onMessage(chatJid, newMessage)                                         │
│  → 调用 router.ts 存入数据库                                             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SQLite messages 表                                                      │
│  - id, chat_jid, sender, content, timestamp                             │
│  - is_from_me, is_bot_message                                           │
│  - msgtype, metadata (JSON), raw_payload (JSON)                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 数据库查询注意事项

### getMessagesSince() 查询逻辑

```sql
SELECT * FROM (
  SELECT id, chat_jid, sender, sender_name, content, timestamp, 
         is_from_me, is_bot_message, msgtype, metadata, raw_payload
  FROM messages
  WHERE chat_jid = ? AND timestamp > ?
    AND is_bot_message = 0 
    AND content NOT LIKE '[BOT]%'
    AND (content != '' AND content IS NOT NULL 
         OR msgtype IN ('image', 'file', 'voice', 'mixed'))
  ORDER BY timestamp DESC
  LIMIT ?
) ORDER BY timestamp
```

**关键点：**
- 非文本消息（image/file/voice/mixed）的 `content` 为空
- 必须通过 `msgtype IN (...)` 条件放行，否则会被过滤掉

---

## 设计建议

### 1. 消息类型路由
后续处理逻辑应根据 `msgtype` 进行路由：
```typescript
switch (message.msgtype) {
  case 'text':
    // 直接处理文本
    break;
  case 'image':
    // 下载图片 → OCR 识别 → 提取文字 → 处理
    break;
  case 'file':
    // 下载文件 → 解析格式 → 提取内容 → 处理
    break;
  case 'mixed':
    // 遍历 msg_item[] → 分别处理每项
    break;
}
```

### 2. 内容增强策略
- **image**: 需要调用 OCR 服务提取图片文字
- **file**: 需要根据文件类型解析内容
- **mixed**: 需要合并多个消息项的内容

### 3. 响应策略
- **text**: 直接返回文本响应
- **image/file/mixed**: 可能需要返回图文混合响应

---

## 相关文件

- `src/channels/wecom.ts` - 企业微信消息接收与发送
- `src/db.ts` - 数据库查询逻辑
- `src/router.ts` - 消息路由与存储
