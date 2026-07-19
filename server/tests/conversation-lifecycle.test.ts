import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { closeDatabase, initSchema } from '../db';
import { SessionRepo } from '../db/repos/session.repo';
import { ConversationService } from '../services/conversation.service';
import { IntentCategory, MessageRole, SessionStatus } from '../types/domain';
import { ConflictError } from '../utils/errors';

const NOW = new Date('2026-07-18T00:00:00.000Z');

function createFixture(exportMaxMessages: number = 10): {
  db: Database.Database;
  service: ConversationService;
  sessions: SessionRepo;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return {
    db,
    service: new ConversationService(db, {
      inactivityMinutes: 30,
      exportMaxMessages,
      now: () => new Date(NOW),
    }),
    sessions: new SessionRepo(db),
  };
}

function testInactiveSessionsCloseWithoutDeletingMessages(): void {
  const { db, service, sessions } = createFixture();
  try {
    const session = service.createSession('lifecycle-user');
    service.saveMessage({
      sessionId: session.id,
      role: MessageRole.USER,
      content: '需要保留的审计消息',
    });
    db.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?',
    ).run('2026-07-17T22:00:00.000Z', session.id);

    const detail = service.getConversationDetail(session.id);
    assert.equal(detail.session.status, SessionStatus.CLOSED);
    const expired = sessions.findById(session.id);
    assert.equal(expired?.status, SessionStatus.CLOSED);
    assert.equal(expired?.closeReason, 'inactivity_timeout');
    assert.equal(service.getMessages(session.id).length, 1);

    const resumed = service.resolveSessionForMessage(session.id, 'lifecycle-user');
    assert.equal(resumed.id, session.id);
    assert.equal(resumed.status, SessionStatus.ACTIVE);
    assert.equal(resumed.closedAt, null);
    assert.equal(resumed.closeReason, null);

    service.closeSession(session.id, 'completed');
    const replacement = service.resolveSessionForMessage(session.id, 'lifecycle-user');
    assert.notEqual(replacement.id, session.id);
    assert.equal(replacement.status, SessionStatus.ACTIVE);
  } finally {
    db.close();
  }
}

function testDateFilteringAndCompleteBoundedExport(): void {
  const { db, service } = createFixture();
  try {
    const included = service.createSession('=formula-user');
    const excluded = service.createSession('other-user');
    service.saveMessage({
      sessionId: included.id,
      role: MessageRole.USER,
      content: `=HYPERLINK("https://example.invalid"),${'完整内容'.repeat(80)}`,
      intent: IntentCategory.ORDER,
    });
    service.saveMessage({
      sessionId: included.id,
      role: MessageRole.ASSISTANT,
      content: '第二条完整回复',
      intent: IntentCategory.ORDER,
    });
    service.saveMessage({
      sessionId: excluded.id,
      role: MessageRole.USER,
      content: '不应进入筛选导出',
      intent: IntentCategory.REFUND,
    });
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
      .run('2026-07-16T16:30:00.000Z', included.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
      .run('2026-07-16T13:00:00.000Z', excluded.id);

    const utcPage = service.getAdminConversations({
      page: 1,
      pageSize: 20,
      dateFrom: '2026-07-17',
      dateTo: '2026-07-17',
      intent: IntentCategory.ORDER,
    });
    assert.equal(utcPage.total, 0);

    const page = service.getAdminConversations({
      page: 1,
      pageSize: 20,
      dateFrom: '2026-07-17',
      dateTo: '2026-07-17',
      timezoneOffsetMinutes: -480,
      intent: IntentCategory.ORDER,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, included.id);

    const exported = service.exportConversations({
      dateFrom: '2026-07-17',
      dateTo: '2026-07-17',
      timezoneOffsetMinutes: -480,
      intent: IntentCategory.ORDER,
    });
    assert.equal(exported.messageCount, 2);
    assert.match(exported.csv, /第二条完整回复/);
    assert.match(exported.csv, /完整内容完整内容完整内容/);
    assert.doesNotMatch(exported.csv, /不应进入筛选导出/);
    assert.match(exported.csv, /'=formula-user/);
    assert.match(exported.csv, /'=HYPERLINK/);

    const limited = new ConversationService(db, {
      inactivityMinutes: 30,
      exportMaxMessages: 1,
      now: () => new Date(NOW),
    });
    assert.throws(
      () => limited.exportConversations({
        dateFrom: '2026-07-17',
        dateTo: '2026-07-17',
        timezoneOffsetMinutes: -480,
      }),
      (error: unknown) => (
        error instanceof ConflictError
        && /超过同步导出上限 1 条/.test(error.message)
      ),
    );
  } finally {
    db.close();
  }
}

function testConversationQueryIndexesExist(): void {
  const { db } = createFixture();
  try {
    const sessionIndexes = db.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>;
    const messageIndexes = db.prepare('PRAGMA index_list(messages)').all() as Array<{ name: string }>;
    assert.ok(sessionIndexes.some((index) => index.name === 'idx_sessions_created_at'));
    assert.ok(sessionIndexes.some((index) => index.name === 'idx_sessions_status_updated'));
    assert.ok(sessionIndexes.some((index) => index.name === 'idx_sessions_status_created'));
    assert.ok(sessionIndexes.some((index) => index.name === 'idx_sessions_user_updated'));
    assert.ok(sessionIndexes.some((index) => index.name === 'idx_sessions_user_status_created'));
    assert.ok(messageIndexes.some((index) => index.name === 'idx_messages_session_created'));
  } finally {
    db.close();
  }
}

testInactiveSessionsCloseWithoutDeletingMessages();
testDateFilteringAndCompleteBoundedExport();
testConversationQueryIndexesExist();
closeDatabase();
console.log('conversation lifecycle tests passed');
