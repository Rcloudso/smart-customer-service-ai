import Database from 'better-sqlite3';
import { config } from '../config';
import { getDatabase } from '../db';
import { OperationsRepo } from '../db/repos/operations.repo';
import type { OperationHealth, OperationsOverview } from '../types/operations';
import { getRetrievalIndexJobService } from './retrieval-index-job.service';

const RECENT_PROBLEM_LIMIT = 12;

type RetrievalRuntimeStatus = Awaited<ReturnType<
  ReturnType<typeof getRetrievalIndexJobService>['status']
>>;

interface OperationsServiceOptions {
  retrievalStatus?: () => Promise<RetrievalRuntimeStatus>;
  now?: () => Date;
}

export class OperationsService {
  private readonly repo: OperationsRepo;
  private readonly retrievalStatus: () => Promise<RetrievalRuntimeStatus>;
  private readonly now: () => Date;

  constructor(db: Database.Database = getDatabase(), options: OperationsServiceOptions = {}) {
    this.repo = new OperationsRepo(db);
    this.retrievalStatus = options.retrievalStatus
      ?? (() => getRetrievalIndexJobService().status());
    this.now = options.now ?? (() => new Date());
  }

  async overview(): Promise<OperationsOverview> {
    const tasks = this.repo.taskCounts();
    const retrieval = await this.retrievalStatus();
    const qdrantHealth: OperationHealth = !retrieval.qdrantConfigured
      ? 'optional_disabled'
      : retrieval.qdrantHealth === 'healthy'
        ? 'healthy'
        : retrieval.qdrantHealth === 'degraded'
          ? 'degraded'
          : 'failed';
    const ocrConfigured = Boolean(config.ocr.serviceUrl);
    const ocrHealth: OperationHealth = !ocrConfigured
      ? 'optional_disabled'
      : tasks.ocr.failed > 0
        ? 'degraded'
        : 'configured';
    const localAnswer = !config.llm.apiKey;
    const localEmbedding = !config.embed.apiKey;

    return {
      generatedAt: this.now().toISOString(),
      services: [
        {
          key: 'sqlite', health: 'healthy', mode: this.repo.sqliteMode(),
          detail: 'authoritative_local_store', ownerPath: '/admin/operations',
        },
        {
          key: 'answer', health: 'healthy',
          mode: localAnswer ? 'deterministic_local' : 'provider_configured',
          detail: localAnswer ? 'no_key_required' : 'configuration_ready_not_probed',
          ownerPath: '/admin/config',
        },
        {
          key: 'embedding', health: 'healthy',
          mode: localEmbedding ? 'deterministic_local' : config.embed.provider,
          detail: localEmbedding ? 'no_key_required' : 'configuration_ready_not_probed',
          ownerPath: '/admin/config',
        },
        {
          key: 'qdrant', health: qdrantHealth,
          mode: retrieval.provider,
          detail: retrieval.qdrantConfigured
            ? `${retrieval.qdrantHealth}:${retrieval.syncStatus}`
            : 'optional_not_enabled',
          ownerPath: '/admin/retrieval-ops',
        },
        {
          key: 'ocr', health: ocrHealth,
          mode: !ocrConfigured
            ? 'optional_not_enabled'
            : config.ocr.backgroundEnabled ? 'background_worker' : 'inline',
          detail: !ocrConfigured ? 'text_documents_remain_available' : 'configuration_ready',
          ownerPath: '/admin/documents',
        },
      ],
      tasks,
      recentProblems: this.repo.recentProblems(RECENT_PROBLEM_LIMIT),
      limits: { recentProblems: RECENT_PROBLEM_LIMIT },
    };
  }
}

let singleton: OperationsService | null = null;

export function getOperationsService(): OperationsService {
  singleton ??= new OperationsService();
  return singleton;
}
