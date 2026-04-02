import { registerChannel } from './registry.js';
import WebSocket from 'ws';
import crypto from 'crypto';
import { Channel, NewMessage } from '../types.js';
import { WECOM_BOT_ID, WECOM_SECRET } from '../config.js';

// Cache response URLs for single chats - expires after 1 hour
const responseUrlCache = new Map<string, { url: string; expiresAt: number }>();
// Cache pending reply requests - map userId to { reqId, msgId } for passive reply
const pendingReplies = new Map<string, { reqId: string; msgId: string }>();

/**
 * Generate req_id for WebSocket frames
 */
function generateReqId(prefix = 'req'): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export interface WeComConfig {
  botId: string;
  secret: string;
  wsUrl?: string;
  heartbeatIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

class WeComChannel implements Channel {
  name = 'wecom';
  private config: WeComConfig;
  private onMessage: (chatJid: string, msg: NewMessage) => void;
  private onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  private ws: WebSocket | null = null;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;

  constructor(
    onMessage: (chatJid: string, msg: NewMessage) => void,
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => void,
  ) {
    const botId = WECOM_BOT_ID;
    const secret = WECOM_SECRET;
    const wsUrl = process.env.WECOM_WS_URL || 'wss://openws.work.weixin.qq.com';

    if (!botId || !secret) {
      console.warn(
        '[WeCom] Missing required environment variables: WECOM_BOT_ID, WECOM_SECRET',
      );
      // Return null from factory, not constructor
      throw new Error('Missing WeCom credentials');
    }

    this.config = {
      botId,
      secret,
      wsUrl,
      heartbeatIntervalMs: parseInt(
        process.env.WECOM_HEARTBEAT_INTERVAL_MS || '30000',
      ),
      reconnectInitialDelayMs: parseInt(
        process.env.WECOM_RECONNECT_INITIAL_DELAY_MS || '1000',
      ),
      reconnectMaxDelayMs: parseInt(
        process.env.WECOM_RECONNECT_MAX_DELAY_MS || '30000',
      ),
    };
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wecom:');
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // WeCom AI Bot WebSocket URL (no credentials in URL)
      const wsUrl = this.config.wsUrl || 'wss://openws.work.weixin.qq.com';
      console.log('[WeCom] Connecting to:', wsUrl);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[WeCom] WebSocket connected, sending authentication...');
        this.connected = true;
        this.reconnectAttempts = 0;
        // Send authentication frame after connection established
        this.sendAuth();
        // Resolve immediately; authentication result will be handled by message handler
        resolve();
      });

      this.ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const raw = data.toString();
          console.log('[WeCom] Raw WebSocket message received:', raw);
          const message = JSON.parse(raw);
          console.log(
            '[WeCom] Parsed message:',
            JSON.stringify(message, null, 2),
          );

          // Handle authentication response (errcode: 0 means success)
          // Auth response format: { headers: { req_id }, errcode: 0, errmsg: "ok" }
          if (
            message.errcode === 0 &&
            message.headers?.req_id?.startsWith('auth_')
          ) {
            console.log('[WeCom] Authentication successful!');
            this.startHeartbeat();
            return;
          }

          // Handle authentication failure
          if (message.errcode !== undefined && message.errcode !== 0) {
            console.error('[WeCom] Authentication failed:', message.errmsg);
            this.connected = false;
            this.scheduleReconnect();
            return;
          }

          // Handle pong response to heartbeat
          // Pong format: { headers: { req_id: "ping_..." }, errcode: 0, errmsg: "ok" }
          if (
            message.headers?.req_id?.startsWith('ping_') &&
            message.errcode === 0
          ) {
            console.log('[WeCom] Received pong response');
            return;
          }

          await this.handleMessage(message);
        } catch (error) {
          console.error('[WeCom] Error parsing message:', error);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[WeCom] WebSocket closed (code=${code}), reconnecting...`);
        this.connected = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        console.error('[WeCom] WebSocket error:', error);
        reject(error);
      });
    });
  }

  /**
   * Send authentication frame
   * Format: { cmd: "aibot_subscribe", headers: { req_id }, body: { secret, bot_id } }
   * Note: Enterprise WeChat API expects snake_case field names
   */
  private sendAuth(): void {
    const reqId = generateReqId('auth');
    const authFrame = {
      cmd: 'aibot_subscribe',
      headers: { req_id: reqId },
      body: {
        secret: this.config.secret,
        bot_id: this.config.botId, // Enterprise WeChat API uses snake_case
      },
    };
    console.log('[WeCom] Sending authentication frame');
    this.ws?.send(JSON.stringify(authFrame));
  }

  /**
   * Send heartbeat ping
   * Format: { cmd: "ping", headers: { req_id } }
   */
  private sendHeartbeat(): void {
    const reqId = generateReqId('ping');
    const pingFrame = {
      cmd: 'ping',
      headers: { req_id: reqId },
    };
    console.log('[WeCom] Sending heartbeat ping');
    this.ws?.send(JSON.stringify(pingFrame));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendHeartbeat();
      } else {
        console.log('[WeCom] Cannot send heartbeat - WebSocket not open');
      }
    }, this.config.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      (this.config.reconnectInitialDelayMs || 1000) *
        Math.pow(2, this.reconnectAttempts),
      this.config.reconnectMaxDelayMs || 30000,
    );
    console.log(
      `[WeCom] Reconnecting in ${delay}ms (attempt ${++this.reconnectAttempts})`,
    );
    setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[WeCom] Reconnect failed:', err);
      });
    }, delay);
  }

  private async handleMessage(message: any): Promise<void> {
    console.log('[WeCom] handleMessage called');

    // Handle message callback (aibot_msg_callback)
    if (message.cmd === 'aibot_msg_callback' && message.body) {
      const body = message.body;
      console.log(
        '[WeCom] Processing message callback, msgtype:',
        body.msgtype,
      );

      const timestamp = body.create_time
        ? new Date(body.create_time * 1000).toISOString()
        : new Date().toISOString();

      // Determine chat JID
      const userId = body.from?.userid || 'unknown';
      const chatJid = `wecom:${userId}`;
      const senderName = body.from?.name || userId;

      // Emit chat metadata for discovery
      this.onChatMetadata(chatJid, timestamp, senderName, 'wecom', false);
      console.log('[WeCom] Chat metadata emitted for:', chatJid);

      // Cache response URL for single chats (expires in 1 hour)
      if (body.response_url) {
        responseUrlCache.set(userId, {
          url: body.response_url,
          expiresAt: Date.now() + 3600000,
        });
        console.log('[WeCom] Cached response_url for:', userId);
      }

      // Cache req_id for passive reply
      const reqId = message.headers?.req_id;
      const msgId = body.msgid;
      if (reqId && msgId) {
        pendingReplies.set(userId, { reqId, msgId });
        console.log(
          '[WeCom] Cached pending reply for:',
          userId,
          'reqId:',
          reqId,
        );
      }

      // Handle text messages
      if (body.msgtype === 'text' && body.text?.content) {
        console.log(
          '[WeCom] Text message content:',
          body.text.content.substring(0, 100),
        );
        const newMessage: NewMessage = {
          id: `wecom:${userId}:${body.create_time || Date.now()}:${msgId || generateReqId('msg')}`,
          chat_jid: chatJid,
          sender: userId,
          sender_name: senderName,
          content: body.text.content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };
        this.onMessage(chatJid, newMessage);
        console.log('[WeCom] Message emitted to router');
      } else if (body.msgtype === 'image') {
        console.log('[WeCom] Image message received, url:', body.image?.url);
      } else if (body.msgtype === 'file') {
        console.log(
          '[WeCom] File message received, filename:',
          body.file?.filename,
        );
      } else if (body.msgtype === 'voice') {
        console.log('[WeCom] Voice message received');
      } else if (body.msgtype === 'mixed') {
        console.log('[WeCom] Mixed message received');
      } else {
        console.log('[WeCom] Unknown message type:', body.msgtype);
      }
      return;
    }

    // Handle event callback (aibot_event_callback)
    if (message.cmd === 'aibot_event_callback' && message.body) {
      const body = message.body;
      console.log(
        '[WeCom] Processing event callback, event type:',
        body.event?.EventType || body.event?.eventtype,
      );

      if (body.event) {
        const event = body.event;
        const eventType = event.EventType || event.eventtype;

        // Handle disconnected_event - do NOT reconnect immediately
        // disconnected_event means "a new connection kicked this one off"
        // Reconnecting immediately will just get kicked again.
        // Instead, keep the connection open and wait for messages.
        if (eventType === 'disconnected_event') {
          console.log(
            '[WeCom] Received disconnected_event:',
            JSON.stringify(event, null, 2),
          );
          console.log(
            '[WeCom] Ignoring disconnected_event — keeping connection open, waiting for messages',
          );
          // Do NOT close connection or schedule reconnect
          // Just log and return, continue listening for messages
          return;
        }

        // Skip events without required fields
        const eventTime = event.create_time || event.CreateTime;
        const fromUser = event.FromUserName || event.from_user_name;
        if (!eventTime || !fromUser) {
          console.log('[WeCom] Event missing required fields, skipping');
          return;
        }

        const timestamp = new Date(eventTime * 1000).toISOString();
        const chatJid = `wecom:${fromUser}`;
        this.onChatMetadata(chatJid, timestamp, fromUser, 'wecom', false);
        console.log('[WeCom] Event metadata emitted for:', chatJid);

        // Cache req_id for passive reply (event_callback path for single chat)
        const reqId = message.headers?.req_id;
        const msgId = body.msgid;
        if (reqId && msgId) {
          pendingReplies.set(fromUser, { reqId, msgId });
          console.log(
            '[WeCom] Cached pending reply for event from:',
            fromUser,
            'reqId:',
            reqId,
          );
        }

        const eventContent = event.Content || event.content;
        if (eventType === 'text' && eventContent) {
          const newMessage: NewMessage = {
            id: `wecom:${fromUser}:${eventTime}:${event.MessageId}`,
            chat_jid: chatJid,
            sender: fromUser,
            sender_name: fromUser,
            content: eventContent,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
          };
          this.onMessage(chatJid, newMessage);
          console.log('[WeCom] Event message emitted to router');
        }
      }
      return;
    }

    console.log(
      '[WeCom] Unrecognized message format:',
      JSON.stringify(message),
    );
  }

  async sendMessage(jid: string, text: string, reqId?: string): Promise<void> {
    if (!jid.startsWith('wecom:')) {
      throw new Error(`[WeCom] Invalid JID format: ${jid}`);
    }

    const userId = jid.replace('wecom:', '');

    // Try to use cached response_url for single chats
    const cached = responseUrlCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      // Use HTTPS POST to response_url
      // Enterprise WeChat response_url expects { text: { content: "..." } } format
      const https = await import('https');
      const payload = { text: { content: text } };

      return new Promise((resolve, reject) => {
        const url = new URL(cached.url);
        const options = {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const response = JSON.parse(data);
            if (response.errcode === 0) {
              console.log('[WeCom] Message sent via response_url to', userId);
              resolve();
            } else {
              console.error('[WeCom] Send failed:', response);
              reject(new Error(response.errmsg || 'Send failed'));
            }
          });
        });

        req.on('error', (e) => {
          console.error('[WeCom] Send request error:', e);
          reject(e);
        });

        req.write(JSON.stringify(payload));
        req.end();
      });
    }

    // Fallback: use WebSocket send
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        '[WeCom] WebSocket not connected and no response_url cached',
      );
    }

    // Get pending reply info if no reqId provided
    let replyReqId = reqId;
    if (!replyReqId) {
      const pending = pendingReplies.get(userId);
      if (pending) {
        replyReqId = pending.reqId;
        console.log('[WeCom] Using pending reply reqId for:', userId);
      }
    }

    // Use aibot_respond_msg if we have a reqId (passive reply), otherwise aibot_send_msg (active push)
    const cmd = replyReqId ? 'aibot_respond_msg' : 'aibot_send_msg';
    const frameReqId = replyReqId || generateReqId('send');

    // Note: aibot_send_msg does NOT support text type, only markdown/template_card/media
    // So we use markdown type for text content when active pushing
    const payload: any = {
      cmd,
      headers: { req_id: frameReqId },
      body: {
        msgtype: 'markdown',
        markdown: { content: text },
      },
    };

    if (replyReqId && cmd === 'aibot_respond_msg') {
      // Passive reply also needs chatid
      payload.body.chatid = userId;
    } else if (cmd === 'aibot_send_msg') {
      // Active push requires chatid
      payload.body.chatid = userId;
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('[WeCom] WebSocket is null'));
        return;
      }
      this.ws.send(JSON.stringify(payload), (error: Error | undefined) => {
        if (error) {
          console.error('[WeCom] Send message error:', error);
          reject(error);
        } else {
          console.log('[WeCom] Message sent via', cmd, 'to', userId);
          resolve();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.connected = false;
      console.log('[WeCom] Disconnected');
      resolve();
    });
  }

  async syncGroups(force?: boolean): Promise<void> {
    // WeCom individual chats don't need sync
    console.log(
      '[WeCom] syncGroups called (not implemented for individual chats)',
    );
  }
}

// Self-registration
registerChannel('wecom', (opts) => {
  if (!WECOM_BOT_ID || !WECOM_SECRET) {
    return null;
  }
  return new WeComChannel(opts.onMessage, opts.onChatMetadata);
});
