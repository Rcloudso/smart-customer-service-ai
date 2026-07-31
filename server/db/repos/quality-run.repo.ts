import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  QualityCandidateResult,
  QualityCaseResult,
  QualityRun,
  QualityRunStatus,
  QualityBackendTarget,
  RetrievalPolicyConfig,
} from '../../types/quality';

interface RunRow {
  id: string;
  dataset_version_ids: string;
  policy_grid: string;
  backend_targets: string;
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
  backend_target: string;
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
    backendTargets: QualityBackendTarget[];
    totalCases: number;
    knowledgeFingerprint: string | null;
    activePolicyId: string;
    createdBy: string;
    now: string;
  }): QualityRun {
    const id = uuidv4();
    this.db.prepare(
      `INSERT INTO quality_runs (
         id, dataset_version_ids, policy_grid, backend_targets, status, progress, total_cases,
         knowledge_fingerprint, active_policy_id, failure_code, cancel_requested,
         created_by, created_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL)`,
    ).run(
      id,
      JSON.stringify(params.datasetVersionIds),
      JSON.stringify(params.policies),
      JSON.stringify(params.backendTargets),
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
        sources: parseJson(caseRow.sources, []),
        latencyMs: caseRow.latency_ms,
        passed: Boolean(caseRow.passed),
        failureReason: caseRow.failure_reason,
      });
      casesByCandidate.set(caseRow.candidate_key, cases);
    }
    const candidates: QualityCandidateResult[] = candidateRows.flatMap((candidate) => {
      const backendTarget = parseJson<QualityBackendTarget | null>(
        candidate.backend_target,
        null,
      );
      const policy = parseJson<RetrievalPolicyConfig | null>(candidate.policy_config, null);
      const metrics = parseJson<QualityCandidateResult['metrics'] | null>(
        candidate.metrics,
        null,
      );
      if (!backendTarget || !policy || !metrics) return [];
      return [{
        key: candidate.candidate_key,
        backendTarget,
        policy,
        metrics,
        recommended: Boolean(candidate.recommended),
        cases: casesByCandidate.get(candidate.candidate_key) ?? [],
      }];
    });
    return {
      id: row.id,
      datasetVersionIds: parseJson<string[]>(row.dataset_version_ids, []),
      policies: parseJson<RetrievalPolicyConfig[]>(row.policy_grid, []),
      backendTargets: parseJson<QualityBackendTarget[]>(
        row.backend_targets,
        [{ provider: 'memory' }],
      ),
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

  getPolicyGrid(id: string): RetrievalPolicyConfig[] {
    const row = this.db.prepare(
      'SELECT policy_grid FROM quality_runs WHERE id = ?',
    ).get(id) as { policy_grid: string } | undefined;
    return row ? parseJson(row.policy_grid, []) : [];
  }

  findLatestCompletedCandidate(candidateKey: string): {
    runId: string;
    candidateKey: string;
  } | null {
    const row = this.db.prepare(`
      SELECT candidate.run_id, candidate.candidate_key
      FROM quality_run_candidates candidate
      JOIN quality_runs run ON run.id = candidate.run_id
      WHERE run.status = 'completed' AND candidate.candidate_key = ?
      ORDER BY run.completed_at DESC
      LIMIT 1
    `).get(candidateKey) as { run_id: string; candidate_key: string } | undefined;
    return row ? { runId: row.run_id, candidateKey: row.candidate_key } : null;
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
           run_id, candidate_key, backend_target, policy_config, metrics, recommended
         ) VALUES (?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(candidate.backendTarget),
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

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
