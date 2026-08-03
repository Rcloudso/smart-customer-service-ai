import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { EscalationPacketRepo } from '../db/repos/escalation-packet.repo';
import { EscalationRepo } from '../db/repos/escalation.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { buildDeterministicEscalationPacket } from '../services/escalation-triage';
import { EscalationStatus, MessageRole } from '../types/domain';

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

function testInterruptedSampleClaimIsRecoverableAfterRestart(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    db.prepare(`
      INSERT INTO sample_pack_installations (
        pack_version, status, faq_ids, attempt_id, created_at, updated_at
      ) VALUES ('sample-pack-v1', 'installing', '[]', 'abandoned-attempt', ?, ?)
    `).run('2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
    initSchema(db);
    assert.deepEqual(
      db.prepare(`
        SELECT status, failure_code FROM sample_pack_installations
        WHERE pack_version = 'sample-pack-v1'
      `).get(),
      { status: 'failed', failure_code: 'sample_pack_interrupted' },
    );
  } finally {
    db.close();
  }
}

function testOnboardingEscalationsAreExcludedFromOrdinaryQueues(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const session = new SessionRepo(db).create('onboarding-escalation', {
      origin: 'onboarding',
      onboardingRunId: '11111111-1111-4111-8111-111111111111',
    });
    const escalationId = '22222222-2222-4222-8222-222222222222';
    const escalationRepo = new EscalationRepo(db);
    escalationRepo.create({
      id: escalationId,
      sessionId: session.id,
      reason: 'test onboarding isolation',
      status: EscalationStatus.PENDING,
      resolvedAt: null,
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    const packetRepo = new EscalationPacketRepo(db);
    packetRepo.create(buildDeterministicEscalationPacket({
      escalationId,
      sessionId: session.id,
      reason: 'test onboarding isolation',
      messages: [],
      now: new Date('2026-08-03T00:00:00.000Z'),
    }));
    assert.deepEqual(escalationRepo.countByStatus(), { pending: 0, resolved: 0, total: 0 });
    assert.equal(escalationRepo.listPending().length, 0);
    assert.equal(packetRepo.countLatestBySession({}), 0);
    assert.equal(packetRepo.listLatestBySession({}, 20, 0).length, 0);
  } finally {
    db.close();
  }
}

testFreshInstallAndIdempotentRestart();
testExistingDatabaseBecomesLegacyAndKeepsCustomerStats();
testOnboardingSessionsAreExcludedFromOperationsAnalytics();
testInterruptedSampleClaimIsRecoverableAfterRestart();
testOnboardingEscalationsAreExcludedFromOrdinaryQueues();
console.log('onboarding migration tests passed');
