import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { QualityRunRepo } from '../db/repos/quality-run.repo';
import {
  evaluateQualityCandidates,
  policyKey,
  type RetrievedQualityCase,
} from '../eval/quality-evaluator';
import { QUALITY_BASELINE_VERSION_ID } from '../eval/quality-baseline';
import type { RetrievalResult } from '../types/ai';
import type {
  PolicyGateResult,
  QualityCase,
  QualityRun,
  RetrievalPolicy,
  RetrievalPolicyConfig,
} from '../types/quality';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { QualityLabService, getQualityLabService } from './quality-lab.service';

interface QualityRunServiceOptions {
  qualityLab?: QualityLabService;
  searchCurrent?: (query: string) => Promise<RetrievalResult[]>;
  searchCurrentBatch?: (queries: string[]) => Promise<RetrievalResult[][]>;
  now?: () => Date;
  autoDrain?: boolean;
}

export class QualityRunService {
  private readonly repo: QualityRunRepo;
  private readonly qualityLab: QualityLabService;
  private readonly searchCurrentBatch: (queries: string[]) => Promise<RetrievalResult[][]>;
  private readonly now: () => Date;
  private readonly autoDrain: boolean;
  private draining = false;

  constructor(
    private readonly db: Database.Database = getDatabase(),
    options: QualityRunServiceOptions = {},
  ) {
    this.repo = new QualityRunRepo(db);
    this.qualityLab = options.qualityLab ?? getQualityLabService();
    this.searchCurrentBatch = options.searchCurrentBatch
      ?? (options.searchCurrent
        ? ((queries) => Promise.all(queries.map(options.searchCurrent as (
          query: string,
        ) => Promise<RetrievalResult[]>)))
        : async (queries) => {
          const { knowledgeRetriever } = await import('../ai/knowledge-system');
          return knowledgeRetriever.searchCandidatesBatch(queries, 100);
        });
    this.now = options.now ?? (() => new Date());
    this.autoDrain = options.autoDrain ?? true;
  }

  start(): void {
    this.repo.interruptIncomplete(this.now().toISOString());
  }

  createRun(params: {
    datasetVersionIds: string[];
    policies: RetrievalPolicyConfig[];
    createdBy: string;
  }): QualityRun {
    const versionIds = [...new Set(params.datasetVersionIds)];
    if (versionIds.length === 0) throw new ValidationError('Select at least one dataset version');
    const versions = versionIds.map((id) => {
      const version = this.qualityLab.getVersion(id);
      if (!version) throw new NotFoundError('Dataset version not found');
      if (version.status !== 'published') {
        throw new ConflictError('Only published dataset versions can be evaluated');
      }
      return version;
    });
    const totalCases = versions.reduce((sum, version) => sum + version.caseCount, 0);
    if (totalCases === 0 || totalCases > 500) {
      throw new ValidationError('A run must contain between 1 and 500 cases');
    }
    const currentPolicy = this.qualityLab.getCurrentPolicy();
    const policies = this.validatePolicies([currentPolicy.config, ...params.policies]);
    const includesCurrentKnowledge = versions.some((version) => version.targetKind === 'current');
    const run = this.repo.create({
      datasetVersionIds: versionIds,
      policies,
      totalCases,
      knowledgeFingerprint: includesCurrentKnowledge ? this.knowledgeFingerprint() : null,
      activePolicyId: currentPolicy.id,
      createdBy: params.createdBy,
      now: this.now().toISOString(),
    });
    if (this.autoDrain) queueMicrotask(() => void this.drain());
    return run;
  }

  getRun(id: string): QualityRun {
    let run = this.repo.get(id);
    if (!run) throw new NotFoundError('Quality run not found');
    if (
      run.status === 'completed'
      && run.knowledgeFingerprint
      && run.knowledgeFingerprint !== this.knowledgeFingerprint()
    ) {
      this.repo.markStale(id);
      run = this.repo.get(id) as QualityRun;
    }
    return run;
  }

  listRuns(page: number = 1, pageSize: number = 20): {
    items: QualityRun[];
    total: number;
    page: number;
    pageSize: number;
  } {
    return {
      items: this.repo.list(pageSize, (page - 1) * pageSize).map((run) => {
        if (
          run.status === 'completed'
          && run.knowledgeFingerprint
          && run.knowledgeFingerprint !== this.knowledgeFingerprint()
        ) {
          this.repo.markStale(run.id);
          return this.repo.get(run.id) as QualityRun;
        }
        return run;
      }),
      total: this.repo.count(),
      page,
      pageSize,
    };
  }

  cancelRun(id: string): QualityRun {
    const run = this.getRun(id);
    if (!['queued', 'running'].includes(run.status)) return run;
    this.repo.requestCancel(id);
    if (run.status === 'queued') this.repo.markCancelled(id, this.now().toISOString());
    return this.getRun(id);
  }

  checkPromotion(runId: string, candidateKey: string): PolicyGateResult {
    let run = this.repo.get(runId, false);
    if (!run) throw new NotFoundError('Quality run not found');
    if (
      run.status === 'completed'
      && run.knowledgeFingerprint
      && run.knowledgeFingerprint !== this.knowledgeFingerprint()
    ) {
      this.repo.markStale(run.id);
      run = this.repo.get(runId, false) as QualityRun;
    }
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (run.status !== 'completed') reasons.push('run_not_completed');
    if (!run.datasetVersionIds.includes(QUALITY_BASELINE_VERSION_ID)) {
      reasons.push('builtin_baseline_required');
    }
    const currentVersions = run.datasetVersionIds
      .map((id) => this.qualityLab.getVersion(id))
      .filter((version) => version?.targetKind === 'current');
    if (currentVersions.length === 0) reasons.push('current_knowledge_dataset_required');
    const currentCases = currentVersions.flatMap(
      (version) => this.qualityLab.listCases(version!.id),
    );
    const answerable = currentCases.filter(
      (testCase) => testCase.expectedGroundingStatus === 'sufficient',
    ).length;
    const insufficient = currentCases.filter(
      (testCase) => testCase.expectedGroundingStatus === 'insufficient',
    ).length;
    const highRisk = currentCases.filter(
      (testCase) => ['high_risk', 'escalated'].includes(testCase.expectedGroundingStatus),
    ).length;
    if (currentCases.length < 12 || answerable < 6 || insufficient < 4 || highRisk < 2) {
      reasons.push('current_knowledge_coverage_insufficient');
    }
    if (!run.knowledgeFingerprint || run.knowledgeFingerprint !== this.knowledgeFingerprint()) {
      reasons.push('knowledge_fingerprint_changed');
    }
    const currentPolicy = this.qualityLab.getCurrentPolicy();
    if (run.activePolicyId !== currentPolicy.id) reasons.push('current_policy_changed');
    const candidate = run.candidates.find((item) => item.key === candidateKey);
    if (!candidate) reasons.push('candidate_not_found');
    const baseline = run.candidates.find(
      (item) => item.key === policyKey(currentPolicy.config),
    );
    if (!baseline) reasons.push('current_policy_result_missing');
    if (candidate && baseline) {
      if (candidate.metrics.unsafeAnswerCount !== 0) reasons.push('unsafe_answers_present');
      if (candidate.metrics.overRefusalCount > baseline.metrics.overRefusalCount) {
        reasons.push('over_refusal_regressed');
      }
      if (candidate.metrics.decisionAccuracy < baseline.metrics.decisionAccuracy) {
        reasons.push('decision_accuracy_regressed');
      }
      if (candidate.metrics.recallAt3 < baseline.metrics.recallAt3) {
        reasons.push('recall_at_3_regressed');
      }
      if (candidate.metrics.mrr < baseline.metrics.mrr) reasons.push('mrr_regressed');
      if (
        baseline.metrics.p95LatencyMs > 0
        && candidate.metrics.p95LatencyMs > baseline.metrics.p95LatencyMs * 1.25
      ) {
        warnings.push('p95_latency_increase_over_25_percent');
      }
    }
    return { eligible: reasons.length === 0, warnings, reasons };
  }

  activateCandidate(params: {
    runId: string;
    candidateKey: string;
    expectedCurrentPolicyId: string;
    actor: string;
  }): RetrievalPolicy {
    const gate = this.checkPromotion(params.runId, params.candidateKey);
    if (!gate.eligible) {
      throw new ConflictError(`Policy gate failed: ${gate.reasons.join(', ')}`);
    }
    const candidate = (this.repo.get(params.runId, false) as QualityRun).candidates.find(
      (item) => item.key === params.candidateKey,
    ) as NonNullable<QualityRun['candidates'][number]>;
    return this.qualityLab.activatePolicy({
      expectedCurrentPolicyId: params.expectedCurrentPolicyId,
      config: candidate.policy,
      sourceRunId: params.runId,
      sourceCandidateKey: params.candidateKey,
      actor: params.actor,
    });
  }

  async processNext(): Promise<void> {
    const run = this.repo.nextQueued();
    if (!run) return;
    this.repo.markRunning(run.id, this.now().toISOString());
    try {
      const policies = this.readPolicyGrid(run.id);
      const retrieved: RetrievedQualityCase[] = [];
      let embeddingCalls = 0;
      let estimatedTokens = 0;
      const entries = run.datasetVersionIds.flatMap((versionId) => {
        const version = this.qualityLab.getVersion(versionId) as NonNullable<
          ReturnType<QualityLabService['getVersion']>
        >;
        return this.qualityLab.listCases(versionId).map((testCase) => ({ version, testCase }));
      });
      const currentEntries = entries.filter(({ version }) => version.targetKind === 'current');
      const batchStarted = performance.now();
      const currentCandidates = currentEntries.length > 0
        ? await this.searchCurrentBatch(currentEntries.map(({ testCase }) => testCase.query))
        : [];
      const batchLatency = performance.now() - batchStarted;
      if (currentEntries.length > 0) {
        embeddingCalls = 1;
        estimatedTokens = currentEntries.reduce(
          (sum, { testCase }) => sum + Math.max(1, Math.ceil(Array.from(testCase.query).length / 2)),
          0,
        );
      }
      let currentIndex = 0;
      for (const { version, testCase } of entries) {
        if (this.getRun(run.id).cancelRequested) {
          this.repo.markCancelled(run.id, this.now().toISOString());
          return;
        }
        const fixtureStarted = performance.now();
        const candidates = version.targetKind === 'fixture'
          ? qualityFixtureCandidates(testCase)
          : currentCandidates[currentIndex++] ?? [];
        retrieved.push({
          testCase,
          candidates,
          latencyMs: version.targetKind === 'fixture'
            ? Number((performance.now() - fixtureStarted).toFixed(3))
            : Number((batchLatency / currentEntries.length).toFixed(3)),
        });
        this.repo.updateProgress(run.id, retrieved.length);
      }
      const candidates = evaluateQualityCandidates({
        cases: retrieved,
        policies,
        embeddingCallCount: embeddingCalls,
        estimatedTokenCount: estimatedTokens,
      });
      this.repo.saveCompleted(run.id, candidates, this.now().toISOString());
    } catch (error) {
      this.repo.markFailed(
        run.id,
        error instanceof Error ? error.name : 'QUALITY_RUN_FAILED',
        this.now().toISOString(),
      );
    }
  }

  knowledgeFingerprint(): string {
    const rows = this.db.prepare(
      `SELECT 'faq' AS type, id, updated_at AS revision, COALESCE(embedding_profile, '') AS profile
       FROM faq_entries WHERE is_active = 1
       UNION ALL
       SELECT 'document' AS type, chunk.id, document.updated_at AS revision,
              COALESCE(chunk.embedding_profile, '') AS profile
       FROM document_chunks chunk
       JOIN documents document ON document.id = chunk.document_id
       WHERE document.is_active = 1 AND document.status = 'ready'
       ORDER BY type, id`,
    ).all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  private readPolicyGrid(runId: string): RetrievalPolicyConfig[] {
    const row = this.db.prepare(
      'SELECT policy_grid FROM quality_runs WHERE id = ?',
    ).get(runId) as { policy_grid: string };
    return JSON.parse(row.policy_grid) as RetrievalPolicyConfig[];
  }

  private validatePolicies(policies: RetrievalPolicyConfig[]): RetrievalPolicyConfig[] {
    const unique = new Map<string, RetrievalPolicyConfig>();
    for (const policy of policies) {
      const values = [
        policy.directFaqThreshold,
        policy.generationEvidenceThreshold,
        policy.sourceDiversityRatio,
      ];
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new ValidationError('Policy thresholds must be between 0 and 1');
      }
      if (policy.generationEvidenceThreshold > policy.directFaqThreshold) {
        throw new ValidationError('Generation threshold cannot exceed direct FAQ threshold');
      }
      if (!['none', 'local_overlap_v1'].includes(policy.rerankerMode)) {
        throw new ValidationError('Unsupported reranker mode');
      }
      unique.set(policyKey(policy), policy);
    }
    if (unique.size > 64) throw new ValidationError('A run may compare at most 64 strategies');
    return [...unique.values()];
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.repo.nextQueued()) await this.processNext();
    } finally {
      this.draining = false;
    }
  }
}

export function qualityFixtureCandidates(testCase: QualityCase): RetrievalResult[] {
  if (testCase.expectedGroundingStatus === 'insufficient') return [];
  if (testCase.expectedGroundingStatus === 'high_risk') {
    return [{
      knowledgeType: 'document',
      knowledgeId: 'fixture-risk-decoy',
      title: 'Order help',
      content: 'General order policy information.',
      similarity: 0.7,
      source: 'vector',
      vectorScore: 0.7,
      fusionScore: 0.02,
    }];
  }
  return testCase.expectedSources.map((source, index) => ({
    knowledgeType: source.knowledgeType,
    knowledgeId: source.knowledgeId,
    documentId: source.knowledgeType === 'document' ? source.knowledgeId : undefined,
    title: source.knowledgeType === 'faq' ? testCase.query : `Fixture source ${source.knowledgeId}`,
    content: source.knowledgeType === 'faq'
      ? '这是经过验证的 FAQ 原文答案。'
      : `${testCase.query} 的经过验证的文档依据。`,
    similarity: source.knowledgeType === 'faq' ? 0.92 : 0.68,
    source: source.knowledgeType === 'faq' ? 'hybrid' : 'vector',
    keywordScore: source.knowledgeType === 'faq' ? 0.92 : undefined,
    vectorScore: source.knowledgeType === 'faq' ? 0.8 : 0.68,
    fusionScore: 0.08 - index * 0.001,
  }));
}

let qualityRunService: QualityRunService | null = null;

export function getQualityRunService(): QualityRunService {
  if (!qualityRunService) qualityRunService = new QualityRunService();
  return qualityRunService;
}
