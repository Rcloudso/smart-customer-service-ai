import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { EscalationRepo } from '../db/repos/escalation.repo';
import { EscalationPacketRepo } from '../db/repos/escalation-packet.repo';
import {
  EscalationListFilters,
  EscalationListItem,
} from '../db/repos/escalation-packet.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { SessionRepo } from '../db/repos/session.repo';
import {
  EscalationLog,
  EscalationPacket,
  EscalationStatus,
  GroundingStatus,
  IntentCategory,
  KnowledgeRetrievalSnapshot,
  Message,
  Session,
  SessionStatus,
} from '../types/domain';
import { logger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import { config } from '../config';
import { getLLMClient, LLMClient } from '../ai/llm-client';
import {
  buildDeterministicEscalationPacket,
  enrichEscalationPacket,
} from './escalation-triage';

export interface PreparedEscalation {
  log: EscalationLog;
  packet: EscalationPacket;
}

export interface PrepareEscalationInput {
  sessionId: string;
  reason: string;
  intent?: IntentCategory | null;
  groundingStatus?: GroundingStatus | null;
  messages?: Message[];
  retrievalSnapshot?: KnowledgeRetrievalSnapshot[];
}

export interface AdminEscalationQuery extends EscalationListFilters {
  page?: number;
  pageSize?: number;
}

interface EscalationServiceOptions {
  llmClient?: LLMClient;
  enableModelExtraction?: boolean;
  now?: () => Date;
}

export class EscalationService {
  private db: Database.Database;
  private escalationRepo: EscalationRepo;
  private packetRepo: EscalationPacketRepo;
  private messageRepo: MessageRepo;
  private sessionRepo: SessionRepo;
  private readonly injectedLlmClient: LLMClient | null;
  private readonly enableModelExtraction: boolean;
  private readonly now: () => Date;

  constructor(
    db: Database.Database = getDatabase(),
    options: EscalationServiceOptions = {},
  ) {
    this.db = db;
    this.escalationRepo = new EscalationRepo(db);
    this.packetRepo = new EscalationPacketRepo(db);
    this.messageRepo = new MessageRepo(db);
    this.sessionRepo = new SessionRepo(db);
    this.enableModelExtraction = options.enableModelExtraction ?? Boolean(config.llm.apiKey);
    this.injectedLlmClient = options.llmClient ?? null;
    this.now = options.now ?? (() => new Date());
  }

  checkEscalation(content: string): { shouldEscalate: boolean; reason: string | null } {
    const explicitTriggers = ['转人工', '人工客服', '找人工', '找客服', '人工服务', '投诉', '我要投诉'];

    const hasExplicit = explicitTriggers.some((t) => content.includes(t));
    if (hasExplicit) {
      return { shouldEscalate: true, reason: '用户要求转人工客服' };
    }

    const frustrationTriggers = ['一直说', '没用', '听不懂', '机器人', '破系统', '垃圾'];
    const hasFrustration = frustrationTriggers.some((t) => content.includes(t));
    if (hasFrustration) {
      return { shouldEscalate: true, reason: '用户表达不满情绪' };
    }

    return { shouldEscalate: false, reason: null };
  }

  async prepareEscalation(input: PrepareEscalationInput): Promise<PreparedEscalation> {
    const now = this.now();
    const messages = input.messages ?? this.messageRepo.findBySession(input.sessionId);
    const log: EscalationLog = {
      id: uuidv4(),
      sessionId: input.sessionId,
      reason: input.reason,
      status: EscalationStatus.PENDING,
      resolvedAt: null,
      createdAt: now.toISOString(),
    };
    const deterministicPacket = buildDeterministicEscalationPacket({
      escalationId: log.id,
      sessionId: input.sessionId,
      reason: input.reason,
      intent: input.intent,
      groundingStatus: input.groundingStatus,
      messages,
      retrievalSnapshot: input.retrievalSnapshot,
      now,
    });
    const llmClient = this.enableModelExtraction
      ? (this.injectedLlmClient ?? getLLMClient())
      : null;
    const packet = llmClient
      ? await enrichEscalationPacket(
        deterministicPacket,
        messages,
        llmClient,
      )
      : deterministicPacket;
    return { log, packet };
  }

  persistPreparedEscalation(prepared: PreparedEscalation): EscalationLog {
    this.escalationRepo.create(prepared.log);
    this.packetRepo.create(prepared.packet);
    this.sessionRepo.updateStatus(prepared.log.sessionId, SessionStatus.ESCALATED);
    logger.info(
      {
        escalationId: prepared.log.id,
        sessionId: prepared.log.sessionId,
        priority: prepared.packet.priority,
        queue: prepared.packet.recommendedQueue,
      },
      'Structured escalation created',
    );
    return prepared.log;
  }

  async createEscalation(
    sessionId: string,
    reason: string,
    input: Omit<PrepareEscalationInput, 'sessionId' | 'reason'> = {},
  ): Promise<EscalationLog> {
    const prepared = await this.prepareEscalation({ ...input, sessionId, reason });
    this.db.transaction(() => {
      this.persistPreparedEscalation(prepared);
    })();
    return prepared.log;
  }

  getQueue(): EscalationLog[] {
    return this.packetRepo.listLatestBySession(
      { status: EscalationStatus.PENDING },
      100,
      0,
    ).map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      reason: item.reason,
      status: item.status,
      resolvedAt: item.resolvedAt,
      createdAt: item.createdAt,
    }));
  }

  getQueueStatus(): { pending: number; resolved: number; total: number } {
    return this.escalationRepo.countByStatus();
  }

  findBySession(sessionId: string): EscalationLog | null {
    return this.escalationRepo.findBySession(sessionId);
  }

  findPacketBySession(sessionId: string): EscalationPacket | null {
    return this.packetRepo.findBySession(sessionId);
  }

  listEscalations(params: AdminEscalationQuery): {
    items: EscalationListItem[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 20, 100);
    const filters: EscalationListFilters = {
      status: params.status,
      category: params.category,
      priority: params.priority,
      recommendedQueue: params.recommendedQueue,
      keyword: params.keyword,
    };
    return {
      items: this.packetRepo.listLatestBySession(
        filters,
        pageSize,
        (page - 1) * pageSize,
      ),
      total: this.packetRepo.countLatestBySession(filters),
      page,
      pageSize,
    };
  }

  getEscalationDetail(escalationId: string): {
    escalation: EscalationLog;
    packet: EscalationPacket;
    session: Session;
    messages: Message[];
    referencedMessageIds: string[];
  } {
    const escalation = this.escalationRepo.findById(escalationId);
    const packet = this.packetRepo.findByEscalationId(escalationId);
    if (!escalation || !packet) {
      throw new NotFoundError('转人工记录不存在');
    }
    const session = this.sessionRepo.findById(escalation.sessionId);
    if (!session) {
      throw new NotFoundError('对话记录不存在');
    }
    return {
      escalation,
      packet,
      session,
      messages: this.messageRepo.findBySession(escalation.sessionId),
      referencedMessageIds: [...new Set(
        packet.confirmedFacts.map((fact) => fact.sourceMessageId),
      )],
    };
  }
}

export const escalationService = new EscalationService();
