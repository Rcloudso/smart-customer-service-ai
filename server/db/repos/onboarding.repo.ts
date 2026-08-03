import Database from 'better-sqlite3';
import { OnboardingState, SamplePackInstallation } from '../../types/onboarding';

export class OnboardingRepo {
  constructor(private readonly db: Database.Database) {}

  getState(): OnboardingState {
    const row = this.db.prepare('SELECT * FROM installation_state WHERE id = 1').get() as Record<string, unknown>;
    return {
      installKind: row.install_kind as OnboardingState['installKind'],
      status: row.onboarding_status as OnboardingState['status'],
      runId: row.current_run_id as string | null,
      startedAt: row.started_at as string | null,
      sampleLoadedAt: row.sample_loaded_at as string | null,
      firstAnswerAt: row.first_answer_at as string | null,
      firstAnswerSessionId: row.first_answer_session_id as string | null,
      firstAnswerMessageId: row.first_answer_message_id as string | null,
      evidenceReviewedAt: row.evidence_reviewed_at as string | null,
      completedAt: row.completed_at as string | null,
      dismissedAt: row.dismissed_at as string | null,
      lastFailureCode: row.last_failure_code as string | null,
    };
  }

  start(runId: string, now: string): OnboardingState {
    this.db.prepare(`
      UPDATE installation_state
      SET onboarding_status = 'in_progress', current_run_id = ?,
          started_at = COALESCE(started_at, ?), dismissed_at = NULL,
          last_failure_code = NULL, updated_at = ?
      WHERE id = 1 AND onboarding_status != 'completed'
    `).run(runId, now, now);
    return this.getState();
  }

  recordSampleLoaded(now: string): void {
    this.db.prepare(`
      UPDATE installation_state SET sample_loaded_at = ?, last_failure_code = NULL, updated_at = ?
      WHERE id = 1
    `).run(now, now);
  }

  recordFirstAnswer(sessionId: string, messageId: string, now: string): void {
    this.db.prepare(`
      UPDATE installation_state
      SET first_answer_at = COALESCE(first_answer_at, ?),
          first_answer_session_id = COALESCE(first_answer_session_id, ?),
          first_answer_message_id = COALESCE(first_answer_message_id, ?),
          last_failure_code = NULL, updated_at = ?
      WHERE id = 1
    `).run(now, sessionId, messageId, now);
  }

  complete(now: string): OnboardingState {
    this.db.prepare(`
      UPDATE installation_state
      SET onboarding_status = 'completed', evidence_reviewed_at = ?, completed_at = ?,
          last_failure_code = NULL, updated_at = ?
      WHERE id = 1 AND first_answer_message_id IS NOT NULL
    `).run(now, now, now);
    return this.getState();
  }

  dismiss(now: string): OnboardingState {
    this.db.prepare(`
      UPDATE installation_state
      SET onboarding_status = 'dismissed', dismissed_at = ?, updated_at = ?
      WHERE id = 1 AND onboarding_status != 'completed'
    `).run(now, now);
    return this.getState();
  }

  recordFailure(code: string, now: string): void {
    this.db.prepare(
      'UPDATE installation_state SET last_failure_code = ?, updated_at = ? WHERE id = 1',
    ).run(code, now);
  }

  getPack(packVersion: string): SamplePackInstallation | null {
    const row = this.db.prepare(
      'SELECT * FROM sample_pack_installations WHERE pack_version = ?',
    ).get(packVersion) as Record<string, unknown> | undefined;
    return row ? this.mapPack(row) : null;
  }

  claimPack(packVersion: string, attemptId: string, now: string): {
    installation: SamplePackInstallation;
    claimed: boolean;
  } {
    return this.db.transaction(() => {
      const existing = this.getPack(packVersion);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO sample_pack_installations (
            pack_version, status, faq_ids, document_id, attempt_id, failure_code,
            created_at, updated_at, completed_at
          ) VALUES (?, 'installing', '[]', NULL, ?, NULL, ?, ?, NULL)
        `).run(packVersion, attemptId, now, now);
        return { installation: this.getPack(packVersion) as SamplePackInstallation, claimed: true };
      }
      if (existing.status === 'failed') {
        this.db.prepare(`
          UPDATE sample_pack_installations
          SET status = 'installing', attempt_id = ?, failure_code = NULL, updated_at = ?
          WHERE pack_version = ? AND status = 'failed'
        `).run(attemptId, now, packVersion);
        return { installation: this.getPack(packVersion) as SamplePackInstallation, claimed: true };
      }
      return { installation: existing, claimed: false };
    })();
  }

  saveFaqIds(packVersion: string, attemptId: string, faqIds: string[], now: string): void {
    this.db.prepare(`
      UPDATE sample_pack_installations SET faq_ids = ?, updated_at = ?
      WHERE pack_version = ? AND attempt_id = ? AND status = 'installing'
    `).run(JSON.stringify(faqIds), now, packVersion, attemptId);
  }

  saveDocumentId(packVersion: string, attemptId: string, documentId: string, now: string): void {
    this.db.prepare(`
      UPDATE sample_pack_installations SET document_id = ?, updated_at = ?
      WHERE pack_version = ? AND attempt_id = ? AND status = 'installing'
    `).run(documentId, now, packVersion, attemptId);
  }

  markPackReady(packVersion: string, attemptId: string, now: string): SamplePackInstallation {
    this.db.prepare(`
      UPDATE sample_pack_installations
      SET status = 'ready', failure_code = NULL, completed_at = ?, updated_at = ?
      WHERE pack_version = ? AND attempt_id = ? AND status = 'installing'
    `).run(now, now, packVersion, attemptId);
    return this.getPack(packVersion) as SamplePackInstallation;
  }

  markPackFailed(packVersion: string, attemptId: string, code: string, now: string): void {
    this.db.prepare(`
      UPDATE sample_pack_installations SET status = 'failed', failure_code = ?, updated_at = ?
      WHERE pack_version = ? AND attempt_id = ? AND status = 'installing'
    `).run(code, now, packVersion, attemptId);
  }

  private mapPack(row: Record<string, unknown>): SamplePackInstallation {
    let faqIds: string[] = [];
    try {
      const parsed = JSON.parse(String(row.faq_ids));
      if (Array.isArray(parsed)) faqIds = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      faqIds = [];
    }
    return {
      packVersion: row.pack_version as string,
      status: row.status as SamplePackInstallation['status'],
      faqIds,
      documentId: row.document_id as string | null,
      attemptId: row.attempt_id as string | null,
      failureCode: row.failure_code as string | null,
      completedAt: row.completed_at as string | null,
    };
  }
}
