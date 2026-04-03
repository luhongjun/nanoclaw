# 企业微信 AI Bot 消息格式规范

> 本文档记录企业微信 AI Bot 通过 WebSocket 推送的消息协议格式，用于消息解析和回复功能的开发与维护。

## 底层逻辑

企业微信 AI Bot 采用 WebSocket 长连接推送消息，标准化 JSON 协议结构。消息分为三类：

| cmd | 说明 | 触发场景 |
|-----|------|----------|
| `aibot_msg_callback` | 用户消息回调 | 用户发送消息到 bot |
| `aibot_event_callback` | 事件回调 | 系统事件（如断开连接） |
| `ping` | 心跳响应 | 服务端发送心跳探测 |

---

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
| `msgtype` | string | 是 | 消息类型：`text` / `image` / `file` / `voice` / `mixed` / `event` |
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
| `disconnected_event` | 连接断开事件 | 保持连接，等待消息，不要立即重连 |
| `text` | 文本事件 | 按文本消息处理 `event.Content` |

---

## 回复消息协议

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
| 40014 | 参数错误 | 检查请求格式和必填字段 |
| 45009 | 频率超限 | 降低发送频率，增加间隔 |
| 50001 | 服务器内部错误 | 稍后重试 |

---

## 实现要点

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

- `src/channels/wecom.ts` — 企业微信通道实现
- `src/config.ts` — 配置项（`WECOM_BOT_ID`、`WECOM_SECRET`）

---

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-04-03 | 1.0 | 初始版本，记录消息协议格式 |
