import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  QualityCandidateResult,
  QualityCaseResult,
  QualityRun,
  QualityRunStatus,
  RetrievalPolicyConfig,
} from '../../types/quality';

interface RunRow {
  id: string;
  dataset_version_ids: string;
  policy_grid: string;
  status: QualityRunStatus;
  progress: number;
  total_cases: number;
  knowledge_fingerprint: string | null;
  active_policy_id: string;
  failure_code: string | null;
  cancel_requested: number;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface CandidateRow {
  candidate_key: string;
  policy_config: string;
  metrics: string;
  recommended: number;
}

interface CaseResultRow {
  case_id: string;
  candidate_key: string;
  actual_answer_mode: QualityCaseResult['actualAnswerMode'];
  actual_grounding_status: QualityCaseResult['actualGroundingStatus'];
  sources: string;
  latency_ms: number;
  passed: number;
  failure_reason: string | null;
}

export class QualityRunRepo {
  constructor(private readonly db: Database.Database) {}

  create(params: {
    datasetVersionIds: string[];
    policies: RetrievalPolicyConfig[];
    totalCases: number;
    knowledgeFingerprint: string | null;
    activePolicyId: string;
    createdBy: string;
    now: string;
  }): QualityRun {
    const id = uuidv4();
    this.db.prepare(
      `INSERT INTO quality_runs (
         id, dataset_version_ids, policy_grid, status, progress, total_cases,
         knowledge_fingerprint, active_policy_id, failure_code, cancel_requested,
         created_by, created_at, started_at, completed_at
       ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL)`,
    ).run(
      id,
      JSON.stringify(params.datasetVersionIds),
      JSON.stringify(params.policies),
      params.totalCases,
      params.knowledgeFingerprint,
      params.activePolicyId,
      params.createdBy,
      params.now,
    );
    return this.get(id) as QualityRun;
  }

  get(id: string, includeCases: boolean = true): QualityRun | null {
    const row = this.db.prepare('SELECT * FROM quality_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return null;
    const candidateRows = this.db.prepare(
      `SELECT * FROM quality_run_candidates WHERE run_id = ?
       ORDER BY recommended DESC, candidate_key`,
    ).all(id) as CandidateRow[];
    const caseRows = includeCases ? this.db.prepare(
      `SELECT * FROM quality_case_results WHERE run_id = ?
       ORDER BY candidate_key, case_id`,
    ).all(id) as CaseResultRow[] : [];
    const casesByCandidate = new Map<string, QualityCaseResult[]>();
    for (const caseRow of caseRows) {
      const cases = casesByCandidate.get(caseRow.candidate_key) ?? [];
      cases.push({
        caseId: caseRow.case_id,
        candidateKey: caseRow.candidate_key,
        actualAnswerMode: caseRow.actual_answer_mode,
        actualGroundingStatus: caseRow.actual_grounding_status,
        sources: JSON.parse(caseRow.sources) as QualityCaseResult['sources'],
        latencyMs: caseRow.latency_ms,
        passed: Boolean(caseRow.passed),
        failureReason: caseRow.failure_reason,
      });
      casesByCandidate.set(caseRow.candidate_key, cases);
    }
    const candidates: QualityCandidateResult[] = candidateRows.map((candidate) => ({
      key: candidate.candidate_key,
      policy: JSON.parse(candidate.policy_config) as RetrievalPolicyConfig,
      metrics: JSON.parse(candidate.metrics) as QualityCandidateResult['metrics'],
      recommended: Boolean(candidate.recommended),
      cases: casesByCandidate.get(candidate.candidate_key) ?? [],
    }));
    return {
      id: row.id,
      datasetVersionIds: JSON.parse(row.dataset_version_ids) as string[],
      policies: JSON.parse(row.policy_grid) as RetrievalPolicyConfig[],
      status: row.status,
      progress: row.progress,
      totalCases: row.total_cases,
      knowledgeFingerprint: row.knowledge_fingerprint,
      activePolicyId: row.active_policy_id,
      candidates,
      failureCode: row.failure_code,
      cancelRequested: Boolean(row.cancel_requested),
      createdBy: row.created_by,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  list(limit: number = 50, offset: number = 0): QualityRun[] {
    const ids = this.db.prepare(
      'SELECT id FROM quality_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as Array<{ id: string }>;
    return ids.map(({ id }) => this.get(id, false) as QualityRun);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS total FROM quality_runs').get() as {
      total: number;
    }).total;
  }

  nextQueued(): QualityRun | null {
    const row = this.db.prepare(
      `SELECT id FROM quality_runs
       WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
    ).get() as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  markRunning(id: string, now: string): void {
    this.db.prepare(
      `UPDATE quality_runs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`,
    ).run(now, id);
  }

  updateProgress(id: string, progress: number): void {
    this.db.prepare(
      'UPDATE quality_runs SET progress = ? WHERE id = ? AND status = \'running\'',
    ).run(progress, id);
  }

  saveCompleted(id: string, candidates: QualityCandidateResult[], now: string): void {
    this.db.transaction(() => {
      const insertCandidate = this.db.prepare(
        `INSERT INTO quality_run_candidates (
           run_id, candidate_key, policy_config, metrics, recommended
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertCase = this.db.prepare(
        `INSERT INTO quality_case_results (
           run_id, candidate_key, case_id, actual_answer_mode,
           actual_grounding_status, sources, latency_ms, passed, failure_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const candidate of candidates) {
        insertCandidate.run(
          id,
          candidate.key,
          JSON.stringify(candidate.policy),
          JSON.stringify(candidate.metrics),
          candidate.recommended ? 1 : 0,
        );
        for (const testCase of candidate.cases) {
          insertCase.run(
            id,
            candidate.key,
            testCase.caseId,
            testCase.actualAnswerMode,
            testCase.actualGroundingStatus,
            JSON.stringify(testCase.sources),
            testCase.latencyMs,
            testCase.passed ? 1 : 0,
            testCase.failureReason,
          );
        }
      }
      this.db.prepare(
        `UPDATE quality_runs
         SET status = 'completed', progress = total_cases, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, id);
    })();
  }

  markFailed(id: string, failureCode: string, now: string): void {
    this.db.prepare(
      `UPDATE quality_runs
       SET status = 'failed', failure_code = ?, completed_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(failureCode, now, id);
  }

  markStale(id: string): void {
    this.db.prepare(
      `UPDATE quality_runs SET status = 'stale'
       WHERE id = ? AND status = 'completed'`,
    ).run(id);
  }

  requestCancel(id: string): void {
    this.db.prepare(
      `UPDATE quality_runs SET cancel_requested = 1
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(id);
  }

  markCancelled(id: string, now: string): void {
    this.db.prepare(
      `UPDATE quality_runs SET status = 'cancelled', completed_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(now, id);
  }

  interruptIncomplete(now: string): number {
    return this.db.prepare(
      `UPDATE quality_runs
       SET status = 'interrupted', completed_at = ?
       WHERE status IN ('queued', 'running')`,
    ).run(now).changes;
  }
}
