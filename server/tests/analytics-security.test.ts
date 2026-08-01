import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { SessionRepo } from '../db/repos/session.repo';

function main(): void {
  const db = new Database(':memory:');
  initSchema(db);
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, user_ident, status, created_at, updated_at)
     VALUES (?, ?, 'closed', ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (
       id, session_id, role, content, intent, intent_conf, satisfaction, escalated,
       retrieval_snapshot, created_at
     ) VALUES (?, ?, 'assistant', 'answer', 'general', 1, 5, 0, '[]', ?)`,
  );

  db.transaction(() => {
    for (let index = 0; index < 1_100; index += 1) {
      const sessionId = `session-${index}`;
      const createdAt = '2026-07-01T12:00:00.000Z';
      insertSession.run(sessionId, `user-${index}`, createdAt, createdAt);
      insertMessage.run(`message-${index}`, sessionId, createdAt);
    }
  })();

  const metrics = new SessionRepo(db).overviewMetrics(
    '2026-07-01',
    '2026-07-01T23:59:59.999Z',
  );
  assert.deepEqual(metrics, {
    totalSessions: 1_100,
    totalMessages: 1_100,
    avgSatisfaction: 5,
  });

  db.close();
  console.log('Analytics security checks passed');
}

main();
