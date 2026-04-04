import { registerChannel } from './registry.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Channel, NewMessage } from '../types.js';
import { WECOM_BOT_ID, WECOM_SECRET, DATA_DIR } from '../config.js';
import AiBot, { MessageType, EventType } from '@wecom/aibot-node-sdk';
import type { WsFrame, BaseMessage } from '@wecom/aibot-node-sdk';

// Cache pending reply requests - map userId to { reqId, msgId } for passive reply
const pendingReplies = new Map<string, { reqId: string; msgId: string }>();

// Image cache directory - stores downloaded images for agent access
const IMAGE_CACHE_DIR =
  process.env.NANOCLAW_IMAGE_DIR || path.join(DATA_DIR, 'images');

// Ensure image directory exists
function ensureImageDir(): void {
  if (!fs.existsSync(IMAGE_CACHE_DIR)) {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
  }
}

/**
 * Generate req_id for frames
 */
function generateReqId(prefix = 'req'): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generate unique filename for downloaded image
 */
function generateImageFilename(msgId: string, ext: string = 'jpg'): string {
  const hash = crypto.createHash('md5').update(msgId).digest('hex').slice(0, 8);
  return `wecom_${Date.now()}_${hash}.${ext}`;
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
  private wsClient: AiBot.WSClient | null = null;
  private connected = false;
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
      // Initialize official SDK client
      this.wsClient = new AiBot.WSClient({
        botId: this.config.botId,
        secret: this.config.secret,
        wsUrl: this.config.wsUrl,
      });

      // Setup SDK event listeners
      this.wsClient.on('authenticated', () => {
        console.log('[WeCom] SDK authenticated!');
        this.connected = true;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.wsClient.on('connected', () => {
        console.log('[WeCom] SDK connected');
      });

      this.wsClient.on('disconnected', (reason: string) => {
        console.log('[WeCom] SDK disconnected:', reason);
        this.connected = false;
        // When server sends disconnected_event, it means "a new connection has taken over"
        // This is NORMAL behavior on startup - our first connection succeeded, server is cleaning up
        // DO NOT reconnect here - the working connection is already active
        if (reason.includes('New connection established')) {
          console.log(
            '[WeCom] This is normal - our first connection succeeded, server cleaned up the old one',
          );
          // The working connection is already established, no need to reconnect
        }
      });

      this.wsClient.on('error', (error: Error) => {
        console.error('[WeCom] SDK error:', error);
        reject(error);
      });

      // Setup message listeners using SDK enums
      this.wsClient.on(`message.${MessageType.Text}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received text message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`message.${MessageType.Image}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received image message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`message.${MessageType.File}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received file message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`message.${MessageType.Voice}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received voice message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`message.${MessageType.Mixed}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received mixed message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`message.${MessageType.Video}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received video message');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(`event.${EventType.EnterChat}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received enter_chat event');
        this.handleSDKMessage(frame);
      });

      this.wsClient.on(
        `event.${EventType.TemplateCardEvent}`,
        (frame: WsFrame) => {
          console.log('[WeCom] SDK received template_card_event');
          this.handleSDKMessage(frame);
        },
      );

      this.wsClient.on(`event.${EventType.FeedbackEvent}`, (frame: WsFrame) => {
        console.log('[WeCom] SDK received feedback_event');
        this.handleSDKMessage(frame);
      });

      // Connect SDK
      console.log('[WeCom] Connecting via SDK...');
      this.wsClient.connect();
    });
  }

  private handleSDKMessage(frame: WsFrame<BaseMessage>): void {
    const body = frame.body;
    if (!body) return;

    const timestamp = body.create_time
      ? new Date(body.create_time * 1000).toISOString()
      : new Date().toISOString();

    const userId = body.from?.userid || 'unknown';
    const chatJid = `wecom:${userId}`;
    const senderName = (body.from as any)?.name || userId;

    // Emit chat metadata
    this.onChatMetadata(chatJid, timestamp, senderName, 'wecom', false);
    console.log('[WeCom] Chat metadata emitted for:', chatJid);

    const reqId = frame.headers?.req_id;
    const msgId = body.msgid;
    if (reqId && msgId) {
      pendingReplies.set(userId, { reqId, msgId });
      console.log('[WeCom] Cached pending reply for:', userId, 'reqId:', reqId);
    }

    // Helper to build base metadata with optional quote (all message types support quote)
    const buildBaseMetadata = (): Record<string, any> => ({
      req_id: reqId,
      msgid: msgId,
      aibotid: body.aibotid,
      chattype: body.chattype,
      from: body.from,
      // Include quote if present (for reply context) - works for all message types
      ...(body.quote && { quote: body.quote }),
    });

    // Helper to build NewMessage
    const buildMessage = (
      msgtype: string,
      content: string,
      extraMetadata: Record<string, any> = {},
    ): NewMessage => ({
      id: `wecom:${userId}:${body.create_time || Date.now()}:${msgId || generateReqId('msg')}`,
      chat_jid: chatJid,
      sender: userId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      msgtype,
      metadata: { ...buildBaseMetadata(), ...extraMetadata },
      raw_payload: frame,
    });

    // Handle text messages
    if (body.msgtype === MessageType.Text && body.text?.content) {
      this.onMessage(chatJid, buildMessage('text', body.text.content));
      console.log('[WeCom] Text message emitted to router');
    }
    // Handle image messages - download and decrypt for agent access
    else if (body.msgtype === MessageType.Image && body.image?.url) {
      this.handleImageMessage(body.image.url, body.image.aeskey, msgId)
        .then((imageInfo) => {
          this.onMessage(
            chatJid,
            buildMessage('image', imageInfo.containerPath || imageInfo.url, {
              image: {
                url: body.image!.url,
                aeskey: body.image!.aeskey,
                localPath: imageInfo.localPath,
                containerPath: imageInfo.containerPath,
              },
            }),
          );
          console.log('[WeCom] Image message emitted to router');
        })
        .catch((err) => {
          console.error('[WeCom] Failed to download image:', err);
          // Fallback: emit message with URL only
          this.onMessage(
            chatJid,
            buildMessage('image', `[图片](${body.image!.url})`, {
              image: { url: body.image!.url, aeskey: body.image!.aeskey },
            }),
          );
        });
    }
    // Handle file messages
    else if (body.msgtype === MessageType.File && body.file) {
      this.onMessage(chatJid, buildMessage('file', '', { file: body.file }));
      console.log('[WeCom] File message emitted to router');
    }
    // Handle voice messages - extract voice.content (ASR text) as message content
    else if (body.msgtype === MessageType.Voice && body.voice) {
      // voice.content contains the speech-to-text result
      const voiceContent = (body.voice as any).content || '';
      this.onMessage(
        chatJid,
        buildMessage('voice', voiceContent, {
          voice: body.voice,
        }),
      );
      console.log('[WeCom] Voice message emitted to router');
    }
    // Handle mixed messages
    else if (body.msgtype === MessageType.Mixed && body.mixed) {
      this.onMessage(chatJid, buildMessage('mixed', '', { mixed: body.mixed }));
      console.log('[WeCom] Mixed message emitted to router');
    }
    // Handle video messages
    else if (body.msgtype === MessageType.Video && body.video?.url) {
      this.onMessage(chatJid, buildMessage('video', '', { video: body.video }));
      console.log('[WeCom] Video message emitted to router');
    }
    // Handle event messages
    else if (body.msgtype === 'event' && body.event) {
      const eventType = body.event.eventtype || (body.event as any).EventType;
      console.log('[WeCom] Received event:', eventType);

      const eventDescriptions: Record<string, string> = {
        [EventType.EnterChat]: '[事件] 用户进入会话',
        [EventType.TemplateCardEvent]: '[事件] 卡片按钮点击',
        [EventType.FeedbackEvent]: '[事件] 用户反馈',
      };

      const content = eventDescriptions[eventType] || `[事件] ${eventType}`;
      this.onMessage(
        chatJid,
        buildMessage('event', content, { event: body.event }),
      );
      console.log(`[WeCom] ${eventType} event emitted to router`);
    }
  }

  async sendMessage(jid: string, text: string, reqId?: string): Promise<void> {
    if (!jid.startsWith('wecom:')) {
      throw new Error(`[WeCom] Invalid JID format: ${jid}`);
    }

    if (!this.wsClient) {
      throw new Error('[WeCom] SDK client not initialized');
    }

    const userId = jid.replace('wecom:', '');

    try {
      // Try to use pending reply for passive response first
      const pending = pendingReplies.get(userId);
      console.log(
        '[WeCom] sendMessage called for:',
        userId,
        'pending:',
        pending,
      );
      const replyReqId = reqId || pending?.reqId;
      console.log(
        '[WeCom] replyReqId:',
        replyReqId,
        'pending.msgId:',
        pending?.msgId,
      );

      if (replyReqId && pending?.msgId) {
        // Passive reply: use reply() method with correct frame structure
        // SDK expects: reply(frame: { headers: { req_id } }, body: ...)
        console.log('[WeCom] Sending passive reply with req_id:', replyReqId);
        await this.wsClient.reply(
          {
            headers: { req_id: replyReqId },
          },
          {
            msgtype: 'markdown',
            markdown: { content: text },
          },
        );
        console.log('[WeCom] Message sent via SDK reply to', userId);
      } else {
        // Active push: use sendMessage() method
        console.log('[WeCom] No pending reply, sending active push');
        await this.wsClient.sendMessage(userId, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
        console.log('[WeCom] Message sent via SDK sendMessage to', userId);
      }
    } catch (error: any) {
      console.error('[WeCom] SDK send failed:', error.message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    this.connected = false;
    console.log('[WeCom] Disconnected');
  }

  async syncGroups(force?: boolean): Promise<void> {
    console.log(
      '[WeCom] syncGroups called (not implemented for individual chats)',
    );
  }

  /**
   * Download and decrypt image from WeCom.
   * Returns local path (for host) and container path (for agent).
   */
  private async handleImageMessage(
    url: string,
    aesKey: string | undefined,
    msgId: string,
  ): Promise<{ localPath: string; containerPath: string; url: string }> {
    if (!this.wsClient) {
      throw new Error('WSClient not initialized');
    }

    ensureImageDir();

    // Download and decrypt image using SDK
    const { buffer } = await this.wsClient.downloadFile(url, aesKey);

    // Generate unique filename
    const filename = generateImageFilename(msgId || generateReqId('img'));
    const localPath = path.join(IMAGE_CACHE_DIR, filename);

    // Save to local disk
    fs.writeFileSync(localPath, buffer);
    console.log('[WeCom] Image saved to:', localPath);

    // Container path is mounted at /workspace/images
    const containerPath = `/workspace/images/${filename}`;

    return { localPath, containerPath, url };
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
}

// Self-registration
registerChannel('wecom', (opts) => {
  if (!WECOM_BOT_ID || !WECOM_SECRET) {
    return null;
  }
  return new WeComChannel(opts.onMessage, opts.onChatMetadata);
});
