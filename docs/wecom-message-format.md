# 企业微信 AI Bot 消息格式规范

> 本文档记录企业微信 AI Bot 通过 WebSocket 推送的消息协议格式，用于消息解析和回复功能的开发与维护。
> 
> **最后更新**: 2026-04-04 — 已迁移至官方 SDK `@wecom/aibot-node-sdk`

## 底层逻辑

企业微信 AI Bot 采用 WebSocket 长连接推送消息，标准化 JSON 协议结构。消息分为三类：

| cmd | 说明 | 触发场景 |
|-----|------|----------|
| `aibot_msg_callback` | 用户消息回调 | 用户发送消息到 bot |
| `aibot_event_callback` | 事件回调 | 系统事件（如断开连接） |
| `ping` | 心跳响应 | 服务端发送心跳探测 |

---

## SDK 集成（当前实现方式）

NanoClaw 使用官方 SDK `@wecom/aibot-node-sdk` 进行连接，而非原生 WebSocket。

### 初始化

```typescript
import AiBot from '@wecom/aibot-node-sdk';

const wsClient = new AiBot.WSClient({
  botId: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_SECRET,
  wsUrl: 'wss://openws.work.weixin.qq.com',
});
```

### 事件监听

```typescript
// 认证成功
wsClient.on('authenticated', () => {
  console.log('SDK authenticated!');
});

// 消息接收
wsClient.on('message.text', (frame: WsFrame) => {
  handleSDKMessage(frame);
});

// 断开连接（正常行为，不要重连）
wsClient.on('disconnected', (reason: string) => {
  console.log('Disconnected:', reason);
  // disconnected_event 表示"新连接已接管"，不要重连
});
```

### 发送消息

```typescript
// 被动回复（使用缓存的 req_id）
await wsClient.reply({
  headers: { req_id: replyReqId },
}, {
  msgtype: 'markdown',
  markdown: { content: '回复内容' },
});

// 主动推送
await wsClient.sendMessage(userId, {
  msgtype: 'markdown',
  markdown: { content: '推送内容' },
});
```

---

## 原生 WebSocket 协议（底层原理）

---

> 以下为原生 WebSocket 协议细节，供原理理解使用。实际开发请使用上方 SDK 方式。

## 消息结构总览

```
┌─────────────────────────────────────────────┐
│ 顶层结构                                     │
├─────────────────────────────────────────────┤
│ cmd          │ 命令类型（string）            │
│ headers      │ 请求头（object）              │
│ └─ req_id    │ 请求唯一标识（string）        │
│ body         │ 消息体（object）              │
│   ├─ msgid   │ 消息唯一 ID（string）         │
│   ├─ aibotid │ AI Bot 实例 ID（string）      │
│   ├─ chattype│ 会话类型（string）            │
│   ├─ from    │ 发送者信息（object）          │
│   ├─ msgtype │ 消息类型（string）            │
│   ├─ response_url │ 回复 URL（string）       │
│   ├─ create_time │ 创建时间戳（number）      │
│   └─ [type]  │ 消息内容（object，按 msgtype） │
└─────────────────────────────────────────────┘
```

---

## 完整消息示例

### 用户消息（aibot_msg_callback）

```json
{
  "cmd": "aibot_msg_callback",
  "headers": {
    "req_id": "hD7y1yvmQrKp7evQhlRTkQAA"
  },
  "body": {
    "msgid": "e95db1c6da2a7cad29d045f5fb40341c",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "chattype": "single",
    "from": {
      "userid": "luhj",
      "name": "卢华俊"
    },
    "msgtype": "text",
    "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=ikRF5Ek9Rsmoe4ajLUHtyAAA_KnVE3f-pfL8MepcH5GjULi-kPDOQ7ePhsWp5GgSe9O5hAkqwKrIl2fDLwrNtb6UK",
    "text": {
      "content": "在吗"
    },
    "create_time": 1775206319
  }
}
```

### 事件回调（aibot_event_callback）

```json
{
  "cmd": "aibot_event_callback",
  "headers": {
    "req_id": "lg_z2zkcSRa_oLnxqiCrLQAA"
  },
  "body": {
    "msgid": "f71bf5250bd3c16757574af4fb3dcda1",
    "aibotid": "aibl3j6v-TvToLbNHJ51EITzoJJ7-St-i0c",
    "msgtype": "event",
    "create_time": 1775206319,
    "event": {
      "eventtype": "disconnected_event",
      "FromUserName": "luhj",
      "CreateTime": 1775206319,
      "Content": ""
    }
  }
}
```

### 心跳响应（ping）

```json
{
  "headers": {
    "req_id": "ping_1775206189446_5792b030"
  },
  "errcode": 0,
  "errmsg": "ok"
}
```

---

## 字段详解

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string | 是 | 命令类型：`aibot_msg_callback` / `aibot_event_callback` / `ping` |
| `headers` | object | 是 | 请求头信息 |
| `headers.req_id` | string | 是 | 请求唯一标识，用于被动回复时关联请求 |
| `body` | object | 否 | 消息体，ping 响应无 body |
| `errcode` | number | 否 | 错误码，0 表示成功 |
| `errmsg` | string | 否 | 错误描述 |

### body 字段（aibot_msg_callback）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `msgid` | string | 是 | 消息唯一 ID，用于消息追踪和去重 |
| `aibotid` | string | 是 | AI Bot 实例 ID |
| `chattype` | string | 是 | 会话类型：`single`（单聊）/ `group`（群聊） |
| `from` | object | 是 | 发送者信息 |
| `from.userid` | string | 是 | 发送者用户 ID |
| `from.name` | string | 否 | 发送者姓名 |
| `msgtype` | string | 是 | 消息类型：`text` / `image` / `file` / `voice` / `mixed` / `video` / `event` |
| `response_url` | string | 否 | 回复消息的 HTTPS 回调 URL，1 小时有效期 |
| `create_time` | number | 是 | 消息创建时间戳（秒级 Unix 时间戳） |

### 消息内容字段（按 msgtype 区分）

#### text 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | object | 文本消息内容 |
| `text.content` | string | 文本内容 |

#### image 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `image` | object | 图片消息内容 |
| `image.url` | string | 图片 URL |

#### file 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | object | 文件消息内容 |
| `file.filename` | string | 文件名 |
| `file.fileurl` | string | 文件下载 URL |

#### voice 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `voice` | object | 语音消息内容 |
| `voice.url` | string | 语音文件 URL |
| `voice.duration` | number | 语音时长（毫秒） |

#### mixed 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `mixed` | object | 混合消息内容 |
| `mixed.content` | array | 多种类型内容的数组 |

#### video 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `video` | object | 视频消息内容 |
| `video.url` | string | 视频 URL |
| `video.aeskey` | string | 视频解密 key |

#### event 类型

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | object | 事件详情 |
| `event.eventtype` | string | 事件类型：`enter_chat` / `template_card_event` / `feedback_event` / `disconnected_event` |

##### template_card_event 特有字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `event.event_key` | string | 用户点击的按钮 key |
| `event.task_id` | string | 任务 ID |

##### feedback_event 特有字段

| 字段 | 类型 | 说明 |
|------|------|------|
| 无额外字段 | - | 仅包含 eventtype 标识事件类型 |

### body 字段（aibot_event_callback）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | object | 是 | 事件详情 |
| `event.eventtype` | string | 是 | 事件类型 |
| `event.EventType` | string | 否 | 事件类型（大写版本，兼容字段） |
| `event.FromUserName` | string | 否 | 发送者用户名（事件回调专用） |
| `event.from_user_name` | string | 否 | 发送者用户名（小写版本，兼容字段） |
| `event.create_time` | number | 否 | 事件创建时间（小写） |
| `event.CreateTime` | number | 否 | 事件创建时间（大写，兼容字段） |
| `event.Content` | string | 否 | 事件内容（文本事件时） |
| `event.content` | string | 否 | 事件内容（小写，兼容字段） |
| `event.MessageId` | string | 否 | 消息 ID（事件回调专用） |

---

## 事件类型（eventtype）

| 事件类型 | 说明 | 处理建议 |
|----------|------|----------|
| `enter_chat` | 用户当天首次进入机器人单聊会话 | 记录用户进入事件，可选：发送欢迎语 |
| `template_card_event` | 用户点击模板卡片按钮 | 根据 button_id 处理用户交互 |
| `feedback_event` | 用户对机器人回复进行反馈 | 记录反馈用于优化 |
| `disconnected_event` | 连接断开事件（新连接建立时推送给旧连接） | 保持连接，等待消息，不要立即重连 |
| `text` | 文本事件 | 按文本消息处理 `event.Content` |

---

## 回复消息协议

### SDK 方式（当前使用）

**被动回复**（推荐，使用缓存的 `req_id`）：

```typescript
await wsClient.reply({
  headers: { req_id: replyReqId },
}, {
  msgtype: 'markdown',
  markdown: { content: '回复内容' },
});
```

**主动推送**（`response_url` 过期后）：

```typescript
await wsClient.sendMessage(userId, {
  msgtype: 'markdown',
  markdown: { content: '推送内容' },
});
```

**关键点**：
- `reply()` 第一个参数是 `{ headers: { req_id } }`，不是 flat 对象
- WeCom 不支持 `text` 类型回复，必须使用 `markdown`
- `req_id` 来自收到消息时的 `frame.headers.req_id`

### 原生 WebSocket 方式（原理参考）

### 方式一：通过 response_url 回复（推荐）

**适用场景**：收到 `aibot_msg_callback` 后 1 小时内

**请求格式**：
```http
POST /cgi-bin/aibot/response?response_code=xxx HTTP/1.1
Host: qyapi.weixin.qq.com
Content-Type: application/json

{
  "text": {
    "content": "回复内容"
  }
}
```

**响应格式**：
```json
{
  "errcode": 0,
  "errmsg": "ok"
}
```

### 方式二：通过 WebSocket 主动推送

**适用场景**：主动推送或 response_url 已过期

**请求格式**：
```json
{
  "cmd": "aibot_send_msg",
  "headers": {
    "req_id": "send_1775206033327_2fbfb28f"
  },
  "body": {
    "chatid": "luhj",
    "msgtype": "markdown",
    "markdown": {
      "content": "回复内容"
    }
  }
}
```

> 注意：`aibot_send_msg` 不支持 `text` 类型，文本内容需使用 `markdown` 类型。

### 方式三：通过 WebSocket 被动回复

**适用场景**：收到消息后立即回复（使用缓存的 req_id）

**请求格式**：
```json
{
  "cmd": "aibot_respond_msg",
  "headers": {
    "req_id": "hD7y1yvmQrKp7evQhlRTkQAA"
  },
  "body": {
    "chatid": "luhj",
    "msgtype": "markdown",
    "markdown": {
      "content": "回复内容"
    }
  }
}
```

---

## 认证与心跳

### 认证流程

1. WebSocket 连接建立后，立即发送认证帧：
```json
{
  "cmd": "aibot_subscribe",
  "headers": {
    "req_id": "auth_1775206159268_29b9e262"
  },
  "body": {
    "secret": "YOUR_SECRET",
    "bot_id": "YOUR_BOT_ID"
  }
}
```

2. 认证成功响应：
```json
{
  "headers": {
    "req_id": "auth_1775206159268_29b9e262"
  },
  "errcode": 0,
  "errmsg": "ok"
}
```

### 心跳机制

**发送心跳**：
```json
{
  "cmd": "ping",
  "headers": {
    "req_id": "ping_1775206189446_5792b030"
  }
}
```

**心跳响应**：
```json
{
  "headers": {
    "req_id": "ping_1775206189446_5792b030"
  },
  "errcode": 0,
  "errmsg": "ok"
}
```

**心跳间隔**：默认 30 秒（`WECOM_HEARTBEAT_INTERVAL_MS=30000`）

---

## 错误码

| errcode | 说明 | 处理建议 |
|---------|------|----------|
| 0 | 成功 | - |
| 40001 | 凭证无效 | 检查 bot_id 和 secret 配置 |
| 40008 | 无效的消息类型 | 使用 `markdown` 而非 `text` |
| 40014 | 参数错误 | 检查请求格式，`reply()` 需要 `{ headers: { req_id } }` |
| 45009 | 频率超限 | 降低发送频率，增加间隔 |
| 50001 | 服务器内部错误 | 稍后重试 |
| 846605 | 无效的 req_id | 检查 `reply()` 参数结构是否正确 |

---

## 实现要点

### SDK 使用要点

**连接管理**：
- `disconnected_event` 是正常行为，表示"新连接已接管"
- 不要在 `disconnected` 事件中重连——第一个连接就是成功的连接
- SDK 内部处理心跳，默认 30 秒间隔

**消息回复**：
- 缓存收到消息的 `req_id` 和 `msgId`
- 被动回复使用 `reply({ headers: { req_id } }, body)` 结构
- 必须使用 `markdown` 类型，不支持 `text`

**错误处理**：
- 45009 频率超限：等待 30 秒后重试
- 846605 无效 req_id：检查 `reply()` 参数结构
- 40008 无效类型：确保使用 `markdown` 而非 `text`

### 消息去重
使用 `msgid` 字段进行消息去重，防止重复处理。

### response_url 缓存
收到消息后缓存 `response_url`，有效期 1 小时。过期后改用 WebSocket 主动推送。

### req_id 关联
收到消息时缓存 `req_id`，用于被动回复时关联请求。

### 断开重连
收到 `disconnected_event` 时不要立即重连——这表示已有新连接接管。保持监听，等待消息。

### 字段兼容性
企业微信 API 部分字段存在大小写两个版本（如 `EventType` / `eventtype`），实现时需兼容处理。

---

## 相关文件

- `src/channels/wecom.ts` — 企业微信通道实现（使用官方 SDK）
- `src/config.ts` — 配置项（`WECOM_BOT_ID`、`WECOM_SECRET`）

---

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-04-04 | 1.1 | 迁移至官方 SDK `@wecom/aibot-node-sdk`，更新 reply() 参数结构 |
| 2026-04-03 | 1.0 | 初始版本，记录消息协议格式 |
