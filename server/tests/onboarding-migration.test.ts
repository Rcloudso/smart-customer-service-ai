import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { MessageRole } from '../types/domain';

function testFreshInstallAndIdempotentRestart(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const install = db.prepare('SELECT install_kind, onboarding_status FROM installation_state WHERE id = 1')
      .get() as { install_kind: string; onboarding_status: string };
    assert.deepEqual(install, { install_kind: 'fresh', onboarding_status: 'not_started' });
    initSchema(db);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS total FROM installation_state').get() as { total: number }).total,
      1,
    );
  } finally {
    db.close();
  }
}

function testExistingDatabaseBecomesLegacyAndKeepsCustomerStats(): void {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, user_ident TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, intent TEXT, intent_conf REAL, satisfaction INTEGER,
        escalated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      INSERT INTO sessions VALUES ('legacy-session', 'legacy-user', 'active', '2026-01-01', '2026-01-01', NULL);
      INSERT INTO messages VALUES ('legacy-message', 'legacy-session', 'user', 'hello', 'general', 1, 5, 0, '2026-01-01');
    `);
    initSchema(db);
    const install = db.prepare('SELECT install_kind, onboarding_status FROM installation_state WHERE id = 1')
      .get() as { install_kind: string; onboarding_status: string };
    assert.deepEqual(install, { install_kind: 'legacy', onboarding_status: 'legacy' });
    assert.deepEqual(
      db.prepare('SELECT origin, onboarding_run_id FROM sessions WHERE id = ?').get('legacy-session'),
      { origin: 'customer', onboarding_run_id: null },
    );
    assert.equal(new SessionRepo(db).overviewMetrics().totalSessions, 1);
  } finally {
    db.close();
  }
}

function testOnboardingSessionsAreExcludedFromOperationsAnalytics(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const sessions = new SessionRepo(db);
    const messages = new MessageRepo(db);
    const customer = sessions.create('customer');
    const onboarding = sessions.create('onboarding-user', {
      origin: 'onboarding',
      onboardingRunId: '11111111-1111-4111-8111-111111111111',
    });
    messages.create({ sessionId: customer.id, role: MessageRole.USER, content: 'customer' });
    messages.create({ sessionId: onboarding.id, role: MessageRole.USER, content: 'onboarding' });
    assert.equal(sessions.overviewMetrics().totalSessions, 1);
    assert.equal(sessions.overviewMetrics().totalMessages, 1);
    assert.equal(sessions.list(null, 20, 0).length, 1);
    assert.equal(sessions.findById(onboarding.id)?.origin, 'onboarding');
  } finally {
    db.close();
  }
}

testFreshInstallAndIdempotentRestart();
testExistingDatabaseBecomesLegacyAndKeepsCustomerStats();
testOnboardingSessionsAreExcludedFromOperationsAnalytics();
console.log('onboarding migration tests passed');
