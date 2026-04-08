// 检查最近接收到的企微消息
// 用法：node scripts/check-messages.js

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', 'store', 'messages.db');

const db = new Database(dbPath, { readonly: true });

console.log('=== 最近 5 条企业微信消息 ===\n');

const messages = db.prepare(`
  SELECT id, chat_jid, sender, sender_name, content, msgtype, timestamp, metadata, raw_payload
  FROM messages
  WHERE chat_jid LIKE 'wecom:%'
  ORDER BY timestamp DESC
  LIMIT 5
`).all();

messages.forEach((m, i) => {
  console.log(`\n--- 消息 ${i + 1} ---`);
  console.log(`ID:        ${m.id}`);
  console.log(`Chat JID:  ${m.chat_jid}`);
  console.log(`Sender:    ${m.sender} (${m.sender_name})`);
  console.log(`Content:   ${m.content}`);
  console.log(`Msg Type:  ${m.msgtype || '(null)'}`);
  console.log(`Timestamp: ${m.timestamp}`);

  if (m.metadata) {
    try {
      const meta = JSON.parse(m.metadata);
      console.log(`Metadata:  ${JSON.stringify(meta, null, 2)}`);
    } catch {
      console.log(`Metadata:  ${m.metadata}`);
    }
  } else {
    console.log(`Metadata:  (null)`);
  }

  if (m.raw_payload) {
    try {
      const payload = JSON.parse(m.raw_payload);
      console.log(`Raw Payload: ${JSON.stringify(payload, null, 2)}`);
    } catch {
      console.log(`Raw Payload: ${m.raw_payload}`);
    }
  } else {
    console.log(`Raw Payload: (null)`);
  }
});

console.log('\n=== 会话状态 ===');
const sessions = db.prepare("SELECT chat_jid, session_id, group_folder FROM sessions WHERE chat_jid LIKE 'wecom:%'").all();
sessions.forEach(s => {
  console.log(`Chat: ${s.chat_jid} | Session: ${s.session_id} | Group: ${s.group_folder}`);
});

db.close();
