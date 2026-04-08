// 迁移 sessions 表从旧 schema 到新 schema
// 用法：node scripts/migrate-sessions.js

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', 'store', 'messages.db');
const db = new Database(dbPath);

console.log('=== 开始迁移 sessions 表 ===\n');

try {
  // 检查是否已经有新的 sessions 表
  const existingTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();

  if (existingTable) {
    console.log('sessions 表已存在，跳过创建');
  } else {
    // 创建新 sessions 表 (chat_jid PRIMARY KEY)
    console.log('创建新 sessions 表...');
    db.exec(`
      CREATE TABLE sessions (
        chat_jid TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        group_folder TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    console.log('✓ sessions 表创建成功');
  }

  // 迁移旧数据
  const oldSessions = db.prepare('SELECT * FROM sessions_old').all();
  if (oldSessions.length > 0) {
    console.log(`迁移 ${oldSessions.length} 条旧会话数据...`);

    for (const session of oldSessions) {
      // 从 group_folder 推断 chat_jid
      // 旧格式：wecom-luhj → 新格式：wecom:luhj
      let chatJid = session.group_folder.replace('-', ':');

      db.prepare(`
        INSERT OR REPLACE INTO sessions (chat_jid, session_id, group_folder, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(chatJid, session.session_id, session.group_folder);

      console.log(`  迁移：${session.group_folder} → ${chatJid}`);
    }
    console.log('✓ 数据迁移完成');
  } else {
    console.log('无旧会话数据需要迁移');
  }

  // 验证
  const newSessions = db.prepare('SELECT * FROM sessions').all();
  console.log('\n=== 迁移后会话数据 ===');
  newSessions.forEach(s => {
    console.log(`Chat JID: ${s.chat_jid} | Session: ${s.session_id} | Group: ${s.group_folder}`);
  });

  console.log('\n✓ 迁移完成！');

} catch (error) {
  console.error('迁移失败:', error.message);
  process.exit(1);
} finally {
  db.close();
}
