# 企业微信 SDK 集成

本文档详细说明 NanoClaw 与企业微信的集成方式，包括 SDK 配置、消息接收流程和回复机制。

## 概述

NanoClaw 使用企业微信官方 AI Bot SDK (`@wecom/aibot-node-sdk`) 通过 WebSocket 连接实现实时消息通信。

```
企业微信服务器 (WebSocket) → WeComChannel → 主进程 (消息存储) → 轮询循环 → 容器执行 → 回复发送
```

## 配置

### 环境变量

```bash
# .env 文件
WECOM_BOT_ID=your_bot_id        # 机器人 ID
WECOM_SECRET=your_secret_key    # 机器人密钥
WECOM_WS_URL=wss://openws.work.weixin.qq.com  # WebSocket 地址 (可选)
```

### 凭证获取

1. 登录企业微信管理后台
2. 进入「应用管理」→「自建应用」
3. 创建或选择机器人应用
4. 获取 `AgentId` 和 `Secret`

---

## 消息接收流程

### 1. WebSocket 连接建立

**文件**: `src/channels/wecom.ts`

```typescript
import * as AiBot from '@wecom/aibot-node-sdk';

// 初始化 WebSocket 客户端
this.wsClient = new AiBot.WSClient({
  botId: this.config.botId,      // WECOM_BOT_ID
  secret: this.config.secret,    // WECOM_SECRET
  wsUrl: this.config.wsUrl,      // wss://openws.work.weixin.qq.com
});
```

### 2. 消息类型监听

SDK 监听多种消息类型和事件：

| 事件类型 | 说明 | 触发时机 |
|----------|------|----------|
| `message.text` | 文本消息 | 用户发送文本 |
| `message.image` | 图片消息 | 用户发送图片 |
| `message.file` | 文件消息 | 用户发送文件 |
| `message.voice` | 语音消息 | 用户发送语音 |
| `message.mixed` | 混合消息 | 图文混合等 |
| `message.video` | 视频消息 | 用户发送视频 |
| `event.enter_chat` | 进入会话 | 用户打开聊天窗口 |
| `event.template_card_event` | 模板卡片事件 | 卡片交互 |
| `event.feedback_event` | 反馈事件 | 用户反馈 |

### 3. 消息接收与转换

当收到 WebSocket 消息帧时 (`handleSDKMessage` 方法)：

```
WsFrame (原始帧)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. 解析 frame.body                                          │
│ 2. 提取 userId → chatJid = "wecom:{userId}"                 │
│ 3. 提取 senderName, timestamp, msgId                        │
│ 4. 缓存 pendingReplies (用于被动回复)                        │
│ 5. 构建 NewMessage 对象                                      │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
NewMessage {
  id: "wecom:{userId}:{timestamp}:{msgid}",
  chat_jid: "wecom:{userId}",
  sender: userId,
  sender_name: "显示名称",
  content: "消息内容",
  timestamp: "2026-04-06T10:00:00.000Z",
  is_from_me: false,
  is_bot_message: false,
  msgtype: 'text',
  metadata: { req_id, msgid, aibotid, chattype, from, ... },
  raw_payload: frame
}
```

### 4. 回调触发

```typescript
// 元数据回调 - 存储会话信息
this.onChatMetadata(chatJid, timestamp, senderName, 'wecom', false);

// 消息回调 - 触发主进程处理
this.onMessage(chatJid, newMessage);
```

### 5. 主进程消息处理

**文件**: `src/index.ts` - `channelOpts.onMessage`

```typescript
onMessage: (chatJid: string, msg: NewMessage) => {
  // 1. 拦截远程控制命令
  if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
    handleRemoteControl(trimmed, chatJid, msg);
    return;
  }

  // 2. 发送者白名单过滤 (drop 模式)
  if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
    return;  // 丢弃消息
  }

  // 3. 存储到 SQLite 数据库
  storeMessage(msg);
}
```

### 6. 轮询消息循环

**文件**: `src/index.ts` - `startMessageLoop()`

```
┌─────────────────────────────────────────────────────────────┐
│                   startMessageLoop()                         │
│                                                              │
│   while (true) {                                             │
│     1. 获取已注册群组 JIDs                                    │
│     2. getNewMessages(jids, lastTimestamp)                   │
│     3. 更新 lastTimestamp 游标                               │
│     4. 按群组分组消息                                        │
│     5. 对每个群组:                                           │
│        a. 检查是否已注册                                     │
│        b. 格式化消息                                         │
│        c. 发送到容器或入队                                   │
│     6. await sleep(POLL_INTERVAL) // 2秒                    │
��   }                                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 回复发送机制

### 被动回复 vs 主动推送

企业微信支持两种回复模式：

| 模式 | 方法 | 速度 | 适用场景 |
|------|------|------|----------|
| **被动回复** | `reply()` | 快 | 在收到消息后立即响应 |
| **主动推送** | `sendMessage()` | 稍慢 | 主动发起消息或延迟回复 |

### 实现代码

**文件**: `src/channels/wecom.ts` - `sendMessage()`

```typescript
async sendMessage(chatJid: string, text: string): Promise<void> {
  const userId = chatJid.replace('wecom:', '');

  if (pendingReplies.has(userId)) {
    // 被动回复 - 使用 reply() 方法
    // 在同一个 WebSocket 连接上响应，速度更快
    const { reqId } = pendingReplies.get(userId);
    await this.wsClient.reply(
      { headers: { req_id: reqId } },
      { markdown: { content: text } }
    );
    pendingReplies.delete(userId);
  } else {
    // 主动推送 - 使用 sendMessage() 方法
    await this.wsClient.sendMessage(userId, {
      markdown: { content: text }
    });
  }
}
```

### 消息格式

支持多种消息格式：

```typescript
// Markdown 格式
{ markdown: { content: '**粗体** `代码`' } }

// 文本格式
{ text: { content: '纯文本' } }

// 模板卡片
{
  template_card: {
    card_type: 'text_notice',
    main_title: { title: '标题', desc: '描述' },
    // ...
  }
}
```

---

## 完整流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                     企业微信服务器                                   │
│               wss://openws.work.weixin.qq.com                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket 消息帧
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  WeComChannel (src/channels/wecom.ts)                               │
│                                                                     │
│  AiBot.WSClient.on('message.text', handleSDKMessage)               │
│    │                                                                │
│    ├─▶ 解析 WsFrame → 提取 userId, content, timestamp              │
│    ├─▶ chatJid = "wecom:{userId}"                                  │
│    ├─▶ 构建 NewMessage 对象                                         │
│    ├─▶ onChatMetadata() → 存储会话元数据                            │
│    └─▶ onMessage(chatJid, newMessage)                              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ onMessage 回调
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  主进程 (src/index.ts)                                              │
│                                                                     │
│  channelOpts.onMessage(chatJid, msg)                               │
│    │                                                                │
│    ├─▶ 远程控制命令拦截                                             │
│    ├─▶ 白名单过滤 (可选)                                            │
│    └─▶ storeMessage(msg) → SQLite 数据库                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ 消息已存储
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  轮询循环 (startMessageLoop)                                        │
│                                                                     │
│  每 2 秒:                                                           │
│    │                                                                │
│    ├─▶ getNewMessages(jids, lastTimestamp)                         │
│    ├─▶ formatMessages() → XML 格式                                  │
│    └─▶ 发送到容器队列                                                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ 消息入队
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  processGroupMessages (src/index.ts)                                 │
│                                                                     │
│    ├─▶ 获取待处理消息                                                │
│    ├─▶ 格式化消息为 XML                                              │
│    └─▶ runContainerAgent() → container-runner.ts                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ 执行 Agent
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  容器执行 (src/container-runner.ts)                                 │
│                                                                     │
│    ├─▶ 启动 Docker 容器                                             │
│    ├─▶ Claude Agent SDK 处理消息                                    │
│    └─▶ 流式输出 via onOutput 回调                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ 输出回调
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  回复发送 (WeComChannel.sendMessage)                                │
│                                                                     │
│    ├─▶ 有 pending reply → reply() 被动回复                          │
│    └─▶ 无 pending reply → sendMessage() 主动推送                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     用户收到回复                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 数据结构

### NewMessage

```typescript
interface NewMessage {
  id: string;              // "wecom:{userId}:{timestamp}:{msgid}"
  chat_jid: string;        // "wecom:{userId}"
  sender: string;          // 用户ID
  sender_name: string;     // 显示名称
  content: string;         // 消息内容
  timestamp: string;       // ISO 时间戳
  is_from_me?: boolean;    // 是否自己发送
  is_bot_message?: boolean;// 是否机器人消息
  msgtype?: string;        // text/image/file/voice/mixed/video/event
  metadata?: Record<string, any>;  // 渠道特定元数据
  raw_payload?: any;       // 原始消息帧
}
```

### 消息元数据 (metadata)

```typescript
interface WeComMetadata {
  req_id: string;          // 请求 ID (用于被动回复)
  msgid: string;           // 消息 ID
  aibotid: string;         // AI Bot ID
  chattype: 'single' | 'group';  // 聊天类型
  from: {
    userid: string;        // 发送者用户 ID
    name: string;          // 发送者名称
  };
  // ... 其他字段
}
```

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/channels/wecom.ts` | 企业微信 WebSocket 连接和消息处理 |
| `src/channels/registry.ts` | 渠道自注册机制 |
| `src/index.ts` | 主消息循环和容器调度 |
| `src/db.ts` | 消息存储和检索 |
| `src/container-runner.ts` | 容器启动和 IPC |
| `src/sender-allowlist.ts` | 发送者白名单 |

---

## 架构设计说明

### 异步轮询架构

NanoClaw 采用 **异步轮询** 而非实时推送的架构：

| 特性 | 说明 |
|------|------|
| **实时接收** | WebSocket 实时接收消息 |
| **持久化存储** | 消息存入 SQLite |
| **轮询处理** | 每 2 秒轮询检查新消息 |
| **容器隔离** | 每个 Agent 在独立容器中执行 |
| **流式回复** | Agent 输出实时流式发送回用户 |

### 设计优点

1. **消息不丢失** - 持久化存储确保消息安全
2. **可控的并发** - 队列管理容器数量
3. **安全隔离** - 容器执行保护宿主机
4. **可扩展性** - 易于添加新的消息类型和处理逻辑

---

## 调试与排查

### 日志查看

```bash
# 查看容器日志
ls groups/wecom-{name}/logs/

# 查看主进程日志
# 日志输出到 stderr，可通过 systemd/launchd 查看journalctl --user -u nanoclaw -f

# macOS
log show --predicate 'process == "node"' --last 1h
```

### 常见问题

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 无法连接 | 凭证错误 | 检查 WECOM_BOT_ID 和 WECOM_SECRET |
| 收不到消息 | WebSocket 断开 | 检查网络连接，重启服务 |
| 回复失败 | pendingReplies 过期 | 检查 reply 时效性 (通常 5 秒) |

---

*文档生成时间: 2026-04-06*
