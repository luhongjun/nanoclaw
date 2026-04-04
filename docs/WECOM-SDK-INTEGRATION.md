# 企业微信 SDK 集成文档

> 记录使用 `@wecom/aibot-node-sdk` 集成企业微信 AI Bot 的关键发现、踩坑经验和最佳实践。

## 快速开始

### 安装

```bash
npm install @wecom/aibot-node-sdk
```

### 初始化

```typescript
import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';

const wsClient = new AiBot.WSClient({
  botId: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_SECRET,
  wsUrl: process.env.WECOM_WS_URL || 'wss://openws.work.weixin.qq.com',
});
```

### 事件监听

```typescript
// 认证成功
wsClient.on('authenticated', () => {
  console.log('[WeCom] SDK authenticated!');
});

// 文本消息
wsClient.on('message.text', (frame: WsFrame) => {
  handleSDKMessage(frame);
});

// 图片消息
wsClient.on('message.image', (frame: WsFrame) => {
  handleSDKMessage(frame);
});

// 断开连接
wsClient.on('disconnected', (reason: string) => {
  console.log('[WeCom] SDK disconnected:', reason);
  // 重要：不要重连！disconnected_event 表示"新连接已接管"
});

// 连接 SDK
wsClient.connect();
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

## 关键踩坑经验

### 1. reply() 参数结构

**错误写法**（会导致 846605 错误）：
```typescript
// ❌ 错误：flat 结构
await wsClient.reply({
  req_id: replyReqId,
  msg_id: pending.msgId,
}, {
  msgtype: 'markdown',
  markdown: { content: '回复内容' },
});
```

**正确写法**：
```typescript
// ✅ 正确：嵌套在 headers 中
await wsClient.reply({
  headers: { req_id: replyReqId },
}, {
  msgtype: 'markdown',
  markdown: { content: '回复内容' },
});
```

**原因**：SDK 期望第一个参数是 `WsFrameHeaders` 类型，结构为 `{ headers: { req_id: string } }`。

---

### 2. disconnected_event 是正常行为

**错误理解**：
> disconnected_event 表示连接失败，需要重连

**正确理解**：
> disconnected_event 表示"新连接已接管，旧连接关闭"——这是**正常启动流程**

**场景**：
1. 应用启动，SDK 建立第一个连接
2. 认证成功，服务器发送 `disconnected_event` 给旧连接（如果有）
3. 第一个连接就是成功的连接，**不需要重连**

**错误代码**（会导致无限重连循环）：
```typescript
// ❌ 错误：disconnected 事件中重连
wsClient.on('disconnected', (reason: string) => {
  this.connected = false;
  this.scheduleReconnect(); // 无限循环！
});
```

**正确代码**：
```typescript
// ✅ 正确：只记录状态，不重连
wsClient.on('disconnected', (reason: string) => {
  console.log('[WeCom] SDK disconnected:', reason);
  this.connected = false;
  // 不要重连！如果是正常 startup，第一个连接已经成功了
  if (reason.includes('New connection established')) {
    console.log('[WeCom] 这是正常的——第一个连接成功了，服务器在清理旧连接');
  }
});
```

---

### 3. 消息类型必须使用 markdown

**错误**（会导致 40008 错误）：
```typescript
// ❌ 错误：WeCom 不支持 text 类型回复
await wsClient.reply(frame, {
  msgtype: 'text',
  text: { content: '回复内容' },
});
```

**正确**：
```typescript
// ✅ 正确：使用 markdown
await wsClient.reply(frame, {
  msgtype: 'markdown',
  markdown: { content: '回复内容' },
});
```

---

### 4. 频率限制（45009 错误）

**现象**：
```
errcode: 45009, errmsg: api freq out of limit
```

**原因**：短时间内多次认证失败导致重连循环，触发频率限制。

**解决方案**：
1. 等待 30-60 秒让频率限制重置
2. 修复重连逻辑，避免无限重连
3. 重启服务

---

## 完整实现示例

```typescript
import { registerChannel } from './registry.js';
import crypto from 'crypto';
import { Channel, NewMessage } from '../types.js';
import { WECOM_BOT_ID, WECOM_SECRET } from '../config.js';
import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';

// 缓存 pending reply 请求
const pendingReplies = new Map<string, { reqId: string; msgId: string }>();

function generateReqId(prefix = 'req'): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class WeComChannel implements Channel {
  name = 'wecom';
  private wsClient: AiBot.WSClient | null = null;
  private connected = false;

  constructor(
    private onMessage: (chatJid: string, msg: NewMessage) => void,
    private onChatMetadata: (chatJid: string, timestamp: string) => void,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wsClient = new AiBot.WSClient({
        botId: WECOM_BOT_ID,
        secret: WECOM_SECRET,
        wsUrl: 'wss://openws.work.weixin.qq.com',
      });

      this.wsClient.on('authenticated', () => {
        console.log('[WeCom] SDK authenticated!');
        this.connected = true;
        resolve();
      });

      this.wsClient.on('disconnected', (reason: string) => {
        console.log('[WeCom] SDK disconnected:', reason);
        this.connected = false;
        // 不要重连！
      });

      this.wsClient.on('error', (error: Error) => {
        console.error('[WeCom] SDK error:', error);
        reject(error);
      });

      this.wsClient.on('message.text', (frame: WsFrame) => {
        this.handleSDKMessage(frame);
      });

      this.wsClient.connect();
    });
  }

  private handleSDKMessage(frame: WsFrame): void {
    const body = frame.body;
    if (!body) return;

    const userId = body.from?.userid || 'unknown';
    const chatJid = `wecom:${userId}`;
    const timestamp = body.create_time
      ? new Date(body.create_time * 1000).toISOString()
      : new Date().toISOString();

    // 缓存 pending reply
    const reqId = frame.headers?.req_id;
    const msgId = body.msgid;
    if (reqId && msgId) {
      pendingReplies.set(userId, { reqId, msgId });
    }

    // 发送消息到 router
    if (body.msgtype === 'text' && body.text?.content) {
      const newMessage: NewMessage = {
        id: `wecom:${userId}:${body.create_time || Date.now()}:${msgId}`,
        chat_jid: chatJid,
        sender: userId,
        sender_name: body.from?.name || userId,
        content: body.text.content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        msgtype: 'text',
        metadata: {
          req_id: reqId,
          msgid: msgId,
          aibotid: body.aibotid,
          chattype: body.chattype,
          from: body.from,
        },
        raw_payload: frame,
      };
      this.onMessage(chatJid, newMessage);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.wsClient) {
      throw new Error('[WeCom] SDK client not initialized');
    }

    const userId = jid.replace('wecom:', '');
    const pending = pendingReplies.get(userId);

    if (pending?.reqId) {
      // 被动回复
      await this.wsClient.reply({
        headers: { req_id: pending.reqId },
      }, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
      console.log('[WeCom] Message sent via SDK reply to', userId);
    } else {
      // 主动推送
      await this.wsClient.sendMessage(userId, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
      console.log('[WeCom] Message sent via SDK sendMessage to', userId);
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    this.connected = false;
  }
}

registerChannel('wecom', (opts) => {
  if (!WECOM_BOT_ID || !WECOM_SECRET) {
    return null;
  }
  return new WeComChannel(opts.onMessage, opts.onChatMetadata);
});
```

---

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `WECOM_BOT_ID` | 企业微信 Bot ID | 必填 |
| `WECOM_SECRET` | 企业微信 Secret | 必填 |
| `WECOM_WS_URL` | WebSocket 服务器地址 | `wss://openws.work.weixin.qq.com` |
| `WECOM_HEARTBEAT_INTERVAL_MS` | 心跳间隔（毫秒） | `30000` |
| `WECOM_RECONNECT_INITIAL_DELAY_MS` | 重连初始延迟（已废弃） | - |
| `WECOM_RECONNECT_MAX_DELAY_MS` | 重连最大延迟（已废弃） | - |

---

## 错误码速查表

| errcode | 说明 | 解决方案 |
|---------|------|----------|
| 0 | 成功 | - |
| 40001 | 凭证无效 | 检查 `bot_id` 和 `secret` |
| 40008 | 无效的消息类型 | 使用 `markdown` 而非 `text` |
| 40014 | 参数错误 | 检查 `reply()` 参数结构 |
| 45009 | 频率超限 | 等待 30-60 秒，修复重连逻辑 |
| 50001 | 服务器内部错误 | 稍后重试 |
| 846605 | 无效的 req_id | 检查 `reply()` 第一个参数是 `{ headers: { req_id } }` |

---

## 相关文件

- `src/channels/wecom.ts` — 完整实现代码
- `docs/wecom-message-format.md` — 消息协议格式详解
- `docs/session-architecture.md` — 会话架构设计

---

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-04-04 | 1.0 | 初始版本，记录 SDK 集成踩坑经验 |
