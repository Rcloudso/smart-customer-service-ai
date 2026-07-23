import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  QualityCase,
  QualityDatasetVersion,
  RetrievalPolicy,
  RetrievalPolicyEvent,
  RetrievalPolicyConfig,
} from '../../types/quality';

interface DatasetSummaryRow {
  id: string;
  dataset_id: string;
  name: string;
  description: string;
  origin: 'builtin' | 'custom';
  version_number: number;
  status: 'draft' | 'published';
  target_kind: 'fixture' | 'current';
  content_hash: string | null;
  case_count: number;
  published_at: string | null;
  created_by: string;
  created_at: string;
}

interface PolicyRow {
  id: string;
  version_number: number;
  direct_faq_threshold: number;
  generation_evidence_threshold: number;
  source_diversity_ratio: number;
  reranker_mode: 'none' | 'local_overlap_v1';
  source_run_id: string | null;
  source_candidate_key: string | null;
  created_by: string;
  created_at: string;
}

interface QualityCaseRow {
  id: string;
  version_id: string;
  query: string;
  expected_answer_mode: QualityCase['expectedAnswerMode'];
  expected_grounding_status: QualityCase['expectedGroundingStatus'];
  expected_sources: string;
  language: QualityCase['language'];
  tags: string;
  created_at: string;
}

interface PolicyEventRow {
  id: string;
  action: RetrievalPolicyEvent['action'];
  from_policy_id: string;
  to_policy_id: string;
  actor: string;
  source_run_id: string | null;
  created_at: string;
}

export class QualityLabRepo {
  constructor(private readonly db: Database.Database) {}

  bootstrapDefaultPolicy(
    id: string,
    config: RetrievalPolicyConfig,
    now: string,
  ): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        `INSERT OR IGNORE INTO retrieval_policies (
           id, version_number, direct_faq_threshold,
           generation_evidence_threshold, source_diversity_ratio,
           reranker_mode, source_run_id, source_candidate_key,
           created_by, created_at
         ) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL, 'system', ?)`,
      ).run(
        id,
        config.directFaqThreshold,
        config.generationEvidenceThreshold,
        config.sourceDiversityRatio,
        config.rerankerMode,
        now,
      );
      this.db.prepare(
        `INSERT OR IGNORE INTO retrieval_policy_state (
           singleton_id, active_policy_id, updated_at
         ) VALUES (1, ?, ?)`,
      ).run(id, now);
    });
    transaction();
  }

  bootstrapBuiltinDataset(params: {
    datasetId: string;
    versionId: string;
    name: string;
    description: string;
    contentHash: string;
    cases: Array<Omit<QualityCase, 'versionId' | 'createdAt'>>;
    now: string;
  }): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        `INSERT OR IGNORE INTO quality_datasets (
           id, name, description, origin, created_by, archived, created_at, updated_at
         ) VALUES (?, ?, ?, 'builtin', 'system', 0, ?, ?)`,
      ).run(params.datasetId, params.name, params.description, params.now, params.now);
      this.db.prepare(
        `INSERT OR IGNORE INTO quality_dataset_versions (
           id, dataset_id, version_number, status, target_kind, content_hash,
           published_at, created_by, created_at
         ) VALUES (?, ?, 1, 'published', 'fixture', ?, ?, 'system', ?)`,
      ).run(
        params.versionId,
        params.datasetId,
        params.contentHash,
        params.now,
        params.now,
      );
      const registered = this.db.prepare(
        'SELECT content_hash FROM quality_dataset_versions WHERE id = ?',
      ).get(params.versionId) as { content_hash: string | null };
      if (registered.content_hash !== params.contentHash) {
        this.db.prepare('DELETE FROM quality_cases WHERE version_id = ?').run(params.versionId);
        this.db.prepare(
          `UPDATE quality_dataset_versions
           SET content_hash = ?, published_at = ?
           WHERE id = ?`,
        ).run(params.contentHash, params.now, params.versionId);
      }
      const insertCase = this.db.prepare(
        `INSERT OR IGNORE INTO quality_cases (
           id, version_id, query, expected_answer_mode,
           expected_grounding_status, expected_sources, language, tags, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const testCase of params.cases) {
        insertCase.run(
          testCase.id,
          params.versionId,
          testCase.query,
          testCase.expectedAnswerMode,
          testCase.expectedGroundingStatus,
          JSON.stringify(testCase.expectedSources),
          testCase.language,
          JSON.stringify(testCase.tags),
          params.now,
        );
      }
    });
    transaction();
  }

  getCurrentPolicy(): RetrievalPolicy {
    const row = this.db.prepare(
      `SELECT p.*
       FROM retrieval_policy_state state
       JOIN retrieval_policies p ON p.id = state.active_policy_id
       WHERE state.singleton_id = 1`,
    ).get() as PolicyRow | undefined;
    if (!row) throw new Error('Active retrieval policy is not initialized');
    return this.mapPolicy(row);
  }

  getPolicy(id: string): RetrievalPolicy | null {
    const row = this.db.prepare(
      'SELECT * FROM retrieval_policies WHERE id = ?',
    ).get(id) as PolicyRow | undefined;
    return row ? this.mapPolicy(row) : null;
  }

  listPolicies(): RetrievalPolicy[] {
    return (this.db.prepare(
      'SELECT * FROM retrieval_policies ORDER BY version_number DESC',
    ).all() as PolicyRow[]).map((row) => this.mapPolicy(row));
  }

  listPolicyEvents(): RetrievalPolicyEvent[] {
    return (this.db.prepare(
      'SELECT * FROM retrieval_policy_events ORDER BY created_at DESC, id DESC',
    ).all() as PolicyEventRow[]).map((row) => ({
      id: row.id,
      action: row.action,
      fromPolicyId: row.from_policy_id,
      toPolicyId: row.to_policy_id,
      actor: row.actor,
      sourceRunId: row.source_run_id,
      createdAt: row.created_at,
    }));
  }

  activatePolicy(params: {
    expectedCurrentPolicyId: string;
    config: RetrievalPolicyConfig;
    sourceRunId: string | null;
    sourceCandidateKey: string | null;
    actor: string;
    action: RetrievalPolicyEvent['action'];
    now: string;
  }): RetrievalPolicy {
    const nextId = uuidv4();
    this.db.transaction(() => {
      const current = this.getCurrentPolicy();
      if (current.id !== params.expectedCurrentPolicyId) {
        throw new Error('QUALITY_POLICY_CONCURRENT_CHANGE');
      }
      const version = (this.db.prepare(
        'SELECT COALESCE(MAX(version_number), 0) + 1 AS version FROM retrieval_policies',
      ).get() as { version: number }).version;
      this.db.prepare(
        `INSERT INTO retrieval_policies (
           id, version_number, direct_faq_threshold,
           generation_evidence_threshold, source_diversity_ratio,
           reranker_mode, source_run_id, source_candidate_key,
           created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        nextId,
        version,
        params.config.directFaqThreshold,
        params.config.generationEvidenceThreshold,
        params.config.sourceDiversityRatio,
        params.config.rerankerMode,
        params.sourceRunId,
        params.sourceCandidateKey,
        params.actor,
        params.now,
      );
      const changed = this.db.prepare(
        `UPDATE retrieval_policy_state SET active_policy_id = ?, updated_at = ?
         WHERE singleton_id = 1 AND active_policy_id = ?`,
      ).run(nextId, params.now, params.expectedCurrentPolicyId).changes;
      if (changed !== 1) throw new Error('QUALITY_POLICY_CONCURRENT_CHANGE');
      this.db.prepare(
        `INSERT INTO retrieval_policy_events (
           id, action, from_policy_id, to_policy_id, actor, source_run_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidv4(),
        params.action,
        params.expectedCurrentPolicyId,
        nextId,
        params.actor,
        params.sourceRunId,
        params.now,
      );
    })();
    return this.getPolicy(nextId) as RetrievalPolicy;
  }

  listDatasets(): QualityDatasetVersion[] {
    const rows = this.db.prepare(
      `SELECT
         version.id,
         dataset.id AS dataset_id,
         dataset.name,
         dataset.description,
         dataset.origin,
         version.version_number,
         version.status,
         version.target_kind,
         version.content_hash,
         COUNT(test_case.id) AS case_count,
         version.published_at,
         version.created_by,
         version.created_at
       FROM quality_dataset_versions version
       JOIN quality_datasets dataset ON dataset.id = version.dataset_id
       LEFT JOIN quality_cases test_case ON test_case.version_id = version.id
       WHERE dataset.archived = 0
       GROUP BY version.id
       ORDER BY dataset.origin ASC, dataset.created_at DESC, version.version_number DESC`,
    ).all() as DatasetSummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      description: row.description,
      origin: row.origin,
      version: row.version_number,
      status: row.status,
      targetKind: row.target_kind,
      contentHash: row.content_hash,
      caseCount: row.case_count,
      publishedAt: row.published_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  createDataset(params: {
    name: string;
    description: string;
    createdBy: string;
    now: string;
  }): QualityDatasetVersion {
    const datasetId = uuidv4();
    const versionId = uuidv4();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO quality_datasets (
           id, name, description, origin, created_by, archived, created_at, updated_at
         ) VALUES (?, ?, ?, 'custom', ?, 0, ?, ?)`,
      ).run(
        datasetId,
        params.name,
        params.description,
        params.createdBy,
        params.now,
        params.now,
      );
      this.db.prepare(
        `INSERT INTO quality_dataset_versions (
           id, dataset_id, version_number, status, target_kind, content_hash,
           published_at, created_by, created_at
         ) VALUES (?, ?, 1, 'draft', 'current', NULL, NULL, ?, ?)`,
      ).run(versionId, datasetId, params.createdBy, params.now);
    })();
    return this.getVersion(versionId) as QualityDatasetVersion;
  }

  getVersion(versionId: string): QualityDatasetVersion | null {
    const row = this.db.prepare(
      `SELECT
         version.id,
         dataset.id AS dataset_id,
         dataset.name,
         dataset.description,
         dataset.origin,
         version.version_number,
         version.status,
         version.target_kind,
         version.content_hash,
         COUNT(test_case.id) AS case_count,
         version.published_at,
         version.created_by,
         version.created_at
       FROM quality_dataset_versions version
       JOIN quality_datasets dataset ON dataset.id = version.dataset_id
       LEFT JOIN quality_cases test_case ON test_case.version_id = version.id
       WHERE version.id = ?
       GROUP BY version.id`,
    ).get(versionId) as DatasetSummaryRow | undefined;
    return row ? this.mapDatasetVersion(row) : null;
  }

  listCases(versionId: string): QualityCase[] {
    const rows = this.db.prepare(
      `SELECT * FROM quality_cases
       WHERE version_id = ?
       ORDER BY created_at, id`,
    ).all(versionId) as QualityCaseRow[];
    return rows.map((row) => this.mapCase(row));
  }

  saveCase(params: {
    id?: string;
    versionId: string;
    query: string;
    expectedAnswerMode: QualityCase['expectedAnswerMode'];
    expectedGroundingStatus: QualityCase['expectedGroundingStatus'];
    expectedSources: QualityCase['expectedSources'];
    language: QualityCase['language'];
    tags: string[];
    now: string;
  }): QualityCase {
    const id = params.id ?? uuidv4();
    const existing = this.db.prepare(
      'SELECT id FROM quality_cases WHERE id = ? AND version_id = ?',
    ).get(id, params.versionId);
    if (existing) {
      this.db.prepare(
        `UPDATE quality_cases
         SET query = ?, expected_answer_mode = ?,
             expected_grounding_status = ?, expected_sources = ?,
             language = ?, tags = ?
         WHERE id = ? AND version_id = ?`,
      ).run(
        params.query,
        params.expectedAnswerMode,
        params.expectedGroundingStatus,
        JSON.stringify(params.expectedSources),
        params.language,
        JSON.stringify(params.tags),
        id,
        params.versionId,
      );
    } else {
      this.db.prepare(
        `INSERT INTO quality_cases (
           id, version_id, query, expected_answer_mode,
           expected_grounding_status, expected_sources, language, tags, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        params.versionId,
        params.query,
        params.expectedAnswerMode,
        params.expectedGroundingStatus,
        JSON.stringify(params.expectedSources),
        params.language,
        JSON.stringify(params.tags),
        params.now,
      );
    }
    const row = this.db.prepare('SELECT * FROM quality_cases WHERE id = ?').get(id) as QualityCaseRow;
    return this.mapCase(row);
  }

  replaceCases(
    versionId: string,
    cases: Array<Omit<QualityCase, 'id' | 'versionId' | 'createdAt'>>,
    now: string,
  ): QualityCase[] {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM quality_cases WHERE version_id = ?').run(versionId);
      const insert = this.db.prepare(
        `INSERT INTO quality_cases (
           id, version_id, query, expected_answer_mode,
           expected_grounding_status, expected_sources, language, tags, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const testCase of cases) {
        insert.run(
          uuidv4(),
          versionId,
          testCase.query,
          testCase.expectedAnswerMode,
          testCase.expectedGroundingStatus,
          JSON.stringify(testCase.expectedSources),
          testCase.language,
          JSON.stringify(testCase.tags),
          now,
        );
      }
    })();
    return this.listCases(versionId);
  }

  publishVersion(versionId: string, contentHash: string, publishedAt: string): QualityDatasetVersion {
    this.db.prepare(
      `UPDATE quality_dataset_versions
       SET status = 'published', content_hash = ?, published_at = ?
       WHERE id = ? AND status = 'draft'`,
    ).run(contentHash, publishedAt, versionId);
    return this.getVersion(versionId) as QualityDatasetVersion;
  }

  deriveVersion(versionId: string, createdBy: string, now: string): QualityDatasetVersion {
    const source = this.getVersion(versionId) as QualityDatasetVersion;
    const nextVersionId = uuidv4();
    this.db.transaction(() => {
      const nextVersion = (this.db.prepare(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS version
         FROM quality_dataset_versions WHERE dataset_id = ?`,
      ).get(source.datasetId) as { version: number }).version;
      this.db.prepare(
        `INSERT INTO quality_dataset_versions (
           id, dataset_id, version_number, status, target_kind, content_hash,
           published_at, created_by, created_at
         ) VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?)`,
      ).run(
        nextVersionId,
        source.datasetId,
        nextVersion,
        source.targetKind,
        createdBy,
        now,
      );
      const insertCase = this.db.prepare(
        `INSERT INTO quality_cases (
           id, version_id, query, expected_answer_mode,
           expected_grounding_status, expected_sources, language, tags, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const testCase of this.listCases(versionId)) {
        insertCase.run(
          uuidv4(),
          nextVersionId,
          testCase.query,
          testCase.expectedAnswerMode,
          testCase.expectedGroundingStatus,
          JSON.stringify(testCase.expectedSources),
          testCase.language,
          JSON.stringify(testCase.tags),
          now,
        );
      }
    })();
    return this.getVersion(nextVersionId) as QualityDatasetVersion;
  }

  private mapPolicy(row: PolicyRow): RetrievalPolicy {
    return {
      id: row.id,
      version: row.version_number,
      config: {
        directFaqThreshold: row.direct_faq_threshold,
        generationEvidenceThreshold: row.generation_evidence_threshold,
        sourceDiversityRatio: row.source_diversity_ratio,
        rerankerMode: row.reranker_mode,
      },
      sourceRunId: row.source_run_id,
      sourceCandidateKey: row.source_candidate_key,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private mapDatasetVersion(row: DatasetSummaryRow): QualityDatasetVersion {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      description: row.description,
      origin: row.origin,
      version: row.version_number,
      status: row.status,
      targetKind: row.target_kind,
      contentHash: row.content_hash,
      caseCount: row.case_count,
      publishedAt: row.published_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private mapCase(row: QualityCaseRow): QualityCase {
    return {
      id: row.id,
      versionId: row.version_id,
      query: row.query,
      expectedAnswerMode: row.expected_answer_mode,
      expectedGroundingStatus: row.expected_grounding_status,
      expectedSources: JSON.parse(row.expected_sources) as QualityCase['expectedSources'],
      language: row.language,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
    };
  }
}
