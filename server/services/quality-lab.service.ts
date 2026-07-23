import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { QualityLabRepo } from '../db/repos/quality-lab.repo';
import {
  QUALITY_BASELINE_CASES,
  QUALITY_BASELINE_DATASET_ID,
  QUALITY_BASELINE_KNOWLEDGE,
  QUALITY_BASELINE_VERSION_ID,
} from '../eval/quality-baseline';
import type {
  QualityCase,
  QualityDatasetVersion,
  RetrievalPolicy,
  RetrievalPolicyEvent,
  RetrievalPolicyConfig,
} from '../types/quality';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicyConfig = {
  directFaqThreshold: 0.8,
  generationEvidenceThreshold: 0.55,
  sourceDiversityRatio: 0.6,
  rerankerMode: 'none',
};

const DEFAULT_POLICY_ID = 'retrieval-policy-v0.2.7-default';

export class QualityLabService {
  private readonly repo: QualityLabRepo;

  constructor(
    db: Database.Database = getDatabase(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new QualityLabRepo(db);
  }

  bootstrap(): void {
    const now = this.now().toISOString();
    this.repo.bootstrapDefaultPolicy(DEFAULT_POLICY_ID, DEFAULT_RETRIEVAL_POLICY, now);
    const manifestHash = createHash('sha256')
      .update(JSON.stringify({
        cases: QUALITY_BASELINE_CASES,
        knowledge: QUALITY_BASELINE_KNOWLEDGE,
      }))
      .digest('hex');
    this.repo.bootstrapBuiltinDataset({
      datasetId: QUALITY_BASELINE_DATASET_ID,
      versionId: QUALITY_BASELINE_VERSION_ID,
      name: 'RAG Quality Baseline',
      description: 'Read-only deterministic FAQ, document, refusal and high-risk baseline.',
      contentHash: manifestHash,
      cases: QUALITY_BASELINE_CASES,
      now,
    });
  }

  getCurrentPolicy(): RetrievalPolicy {
    return this.repo.getCurrentPolicy();
  }

  getPolicy(id: string): RetrievalPolicy | null {
    return this.repo.getPolicy(id);
  }

  listPolicies(): RetrievalPolicy[] {
    return this.repo.listPolicies();
  }

  listPolicyEvents(): RetrievalPolicyEvent[] {
    return this.repo.listPolicyEvents();
  }

  listDatasets(): QualityDatasetVersion[] {
    return this.repo.listDatasets();
  }

  getVersion(versionId: string): QualityDatasetVersion | null {
    return this.repo.getVersion(versionId);
  }

  createDataset(params: {
    name: string;
    description?: string;
    createdBy: string;
  }): QualityDatasetVersion {
    const name = params.name.trim();
    if (!name) throw new ValidationError('Dataset name is required');
    return this.repo.createDataset({
      name,
      description: params.description?.trim() ?? '',
      createdBy: params.createdBy,
      now: this.now().toISOString(),
    });
  }

  listCases(versionId: string): QualityCase[] {
    if (!this.repo.getVersion(versionId)) throw new NotFoundError('Dataset version not found');
    return this.repo.listCases(versionId);
  }

  saveCase(
    versionId: string,
    params: Omit<QualityCase, 'id' | 'versionId' | 'createdAt'> & { id?: string },
  ): QualityCase {
    const version = this.repo.getVersion(versionId);
    if (!version) throw new NotFoundError('Dataset version not found');
    if (version.status === 'published') {
      throw new ConflictError('Published dataset versions are immutable');
    }
    const query = params.query.trim();
    if (!query) throw new ValidationError('Case query is required');
    if (version.caseCount >= 500 && !params.id) {
      throw new ValidationError('Dataset versions may contain at most 500 cases');
    }
    if (
      params.id
      && !this.repo.listCases(versionId).some((testCase) => testCase.id === params.id)
    ) {
      throw new NotFoundError('Quality case not found in dataset version');
    }
    this.validateExpectedDecision(params);
    return this.repo.saveCase({
      ...params,
      query,
      versionId,
      tags: [...new Set(params.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 10),
      now: this.now().toISOString(),
    });
  }

  importCases(
    versionId: string,
    cases: Array<Omit<QualityCase, 'id' | 'versionId' | 'createdAt'>>,
  ): QualityCase[] {
    const version = this.repo.getVersion(versionId);
    if (!version) throw new NotFoundError('Dataset version not found');
    if (version.status === 'published') {
      throw new ConflictError('Published dataset versions are immutable');
    }
    if (cases.length === 0 || cases.length > 500) {
      throw new ValidationError('JSON import must contain between 1 and 500 cases');
    }
    const normalized = cases.map((testCase) => {
      const query = testCase.query.trim();
      if (!query) throw new ValidationError('Case query is required');
      this.validateExpectedDecision(testCase);
      return {
        ...testCase,
        query,
        tags: [...new Set(testCase.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 10),
      };
    });
    return this.repo.replaceCases(versionId, normalized, this.now().toISOString());
  }

  activatePolicy(params: {
    expectedCurrentPolicyId: string;
    config: RetrievalPolicyConfig;
    sourceRunId: string;
    sourceCandidateKey: string;
    actor: string;
  }): RetrievalPolicy {
    try {
      return this.repo.activatePolicy({
        ...params,
        action: 'activate',
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'QUALITY_POLICY_CONCURRENT_CHANGE') {
        throw new ConflictError('Current policy changed; refresh before publishing');
      }
      throw error;
    }
  }

  rollbackPolicy(params: {
    targetPolicyId: string;
    expectedCurrentPolicyId: string;
    actor: string;
  }): RetrievalPolicy {
    const target = this.repo.getPolicy(params.targetPolicyId);
    if (!target) throw new NotFoundError('Target policy not found');
    try {
      return this.repo.activatePolicy({
        expectedCurrentPolicyId: params.expectedCurrentPolicyId,
        config: target.config,
        sourceRunId: target.sourceRunId,
        sourceCandidateKey: target.sourceCandidateKey,
        actor: params.actor,
        action: 'rollback',
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'QUALITY_POLICY_CONCURRENT_CHANGE') {
        throw new ConflictError('Current policy changed; refresh before rollback');
      }
      throw error;
    }
  }

  publishVersion(versionId: string, _actor: string): QualityDatasetVersion {
    const version = this.repo.getVersion(versionId);
    if (!version) throw new NotFoundError('Dataset version not found');
    if (version.origin === 'builtin') return version;
    if (version.status === 'published') return version;
    const cases = this.repo.listCases(versionId);
    if (cases.length === 0) throw new ValidationError('Cannot publish an empty dataset version');
    const contentHash = this.hashCases(cases);
    return this.repo.publishVersion(versionId, contentHash, this.now().toISOString());
  }

  deriveVersion(versionId: string, actor: string): QualityDatasetVersion {
    const version = this.repo.getVersion(versionId);
    if (!version) throw new NotFoundError('Dataset version not found');
    if (version.origin === 'builtin') {
      throw new ConflictError('Built-in datasets cannot be modified');
    }
    if (version.status !== 'published') {
      throw new ConflictError('Only published dataset versions can be derived');
    }
    return this.repo.deriveVersion(versionId, actor, this.now().toISOString());
  }

  private validateExpectedDecision(
    testCase: Pick<QualityCase, 'expectedAnswerMode' | 'expectedGroundingStatus' | 'expectedSources'>,
  ): void {
    const sufficient = testCase.expectedGroundingStatus === 'sufficient';
    if (sufficient && testCase.expectedAnswerMode === 'refusal') {
      throw new ValidationError('Sufficient cases cannot expect refusal');
    }
    if (!sufficient && testCase.expectedAnswerMode !== 'refusal') {
      throw new ValidationError('Non-sufficient cases must expect refusal');
    }
    if (sufficient && testCase.expectedSources.length === 0) {
      throw new ValidationError('Answerable cases require at least one expected source');
    }
  }

  private hashCases(cases: QualityCase[]): string {
    const canonical = cases
      .map(({ id: _id, versionId: _versionId, createdAt: _createdAt, ...testCase }) => testCase)
      .sort((left, right) => left.query.localeCompare(right.query));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}

let qualityLabService: QualityLabService | null = null;

export function getQualityLabService(): QualityLabService {
  if (!qualityLabService) {
    qualityLabService = new QualityLabService();
    qualityLabService.bootstrap();
  }
  return qualityLabService;
}
