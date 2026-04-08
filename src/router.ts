import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);

    // Format content based on message type
    let formattedContent = m.content;
    if (m.msgtype === 'image' && m.metadata?.image) {
      const imageMeta = m.metadata.image as {
        url?: string;
        containerPath?: string;
        localPath?: string;
      };
      // Prefer container path for agent access (downloaded image)
      if (imageMeta.containerPath) {
        formattedContent = `[图片] 文件路径: ${imageMeta.containerPath}`;
      } else if (imageMeta.url) {
        formattedContent = `[图片](${imageMeta.url})`;
      } else {
        formattedContent = '[图片]';
      }
    } else if (m.msgtype === 'file' && m.metadata?.file) {
      const filename = m.metadata.file.filename || 'unknown';
      const fileurl = m.metadata.file.fileurl || '';
      formattedContent = `[文件] ${filename}${fileurl ? `(${fileurl})` : ''}`;
    } else if (m.msgtype === 'voice' && m.metadata?.voice?.url) {
      formattedContent = `[语音](${m.metadata.voice.url})`;
    } else if (m.msgtype === 'mixed') {
      const mixedContent = m.metadata?.mixed?.content || [];
      formattedContent = `[混合消息] 包含 ${mixedContent.length || 0} 个元素`;
    }

    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(formattedContent)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
