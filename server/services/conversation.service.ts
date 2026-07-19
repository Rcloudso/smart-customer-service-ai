import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import {
  ConversationFilters,
  SessionRepo,
} from '../db/repos/session.repo';
import { MessageRepo } from '../db/repos/message.repo';
import {
  AnswerMode,
  GroundingStatus,
  IntentCategory,
  KnowledgeRetrievalSnapshot,
  Session,
  SessionStatus,
  Message,
  MessageRole,
} from '../types/domain';
import { ChatHistorySession, ConversationDetail, PaginationResponse } from '../types/api';
import { ConflictError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { config } from '../config';
import { EscalationService } from './escalation.service';

interface ConversationServiceOptions {
  inactivityMinutes?: number;
  exportMaxMessages?: number;
  now?: () => Date;
}

export interface AdminConversationQuery {
  page?: number;
  pageSize?: number;
  intent?: IntentCategory;
  status?: SessionStatus;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
  timezoneOffsetMinutes?: number;
  timezoneOffsetToMinutes?: number;
}

export interface SaveMessageParams {
  sessionId: string;
  role: MessageRole;
  content: string;
  intent?: string | null;
  intentConf?: number | null;
  replyToMessageId?: string | null;
  retrievalSnapshot?: KnowledgeRetrievalSnapshot[];
  answerMode?: AnswerMode | null;
  groundingStatus?: GroundingStatus | null;
  groundingReason?: string | null;
}

export class ConversationService {
  private db: Database.Database;
  private sessionRepo: SessionRepo;
  private messageRepo: MessageRepo;
  private escalationService: EscalationService;
  private readonly inactivityMinutes: number;
  private readonly exportMaxMessages: number;
  private readonly now: () => Date;

  constructor(
    db: Database.Database = getDatabase(),
    options: ConversationServiceOptions = {},
  ) {
    this.db = db;
    this.sessionRepo = new SessionRepo(db);
    this.messageRepo = new MessageRepo(db);
    this.escalationService = new EscalationService(db);
    this.inactivityMinutes = options.inactivityMinutes ?? config.conversations.inactivityMinutes;
    this.exportMaxMessages = options.exportMaxMessages ?? config.conversations.exportMaxMessages;
    this.now = options.now ?? (() => new Date());
  }

  createSession(userIdent: string): Session {
    const session = this.sessionRepo.create(userIdent);
    logger.info({ sessionId: session.id, userIdent }, 'New session created');
    return session;
  }

  getOrCreateSession(userIdent: string): Session {
    this.expireInactiveSessions();
    let session = this.sessionRepo.findByUserIdent(userIdent, SessionStatus.ACTIVE);
    if (!session) {
      session = this.createSession(userIdent);
    }
    return session;
  }

  resolveSessionForMessage(sessionId: string | undefined, userIdent: string): Session {
    this.expireInactiveSessions();
    if (sessionId) {
      const existing = this.sessionRepo.findById(sessionId);
      if (existing?.userIdent === userIdent) {
        if (existing.status === SessionStatus.ACTIVE) return existing;
        if (
          existing.status === SessionStatus.CLOSED
          && existing.closeReason === 'inactivity_timeout'
        ) {
          return this.sessionRepo.updateStatus(existing.id, SessionStatus.ACTIVE) ?? existing;
        }
      }
    }
    return this.createSession(userIdent);
  }

  expireInactiveSessions(): number {
    const now = this.now();
    const cutoff = new Date(
      now.getTime() - this.inactivityMinutes * 60 * 1000,
    ).toISOString();
    if (!this.sessionRepo.hasInactive(cutoff)) return 0;
    const expired = this.sessionRepo.expireInactive(cutoff, now.toISOString());
    if (expired > 0) {
      logger.info(
        { expired, inactivityMinutes: this.inactivityMinutes },
        'Inactive conversations closed',
      );
    }
    return expired;
  }

  closeSession(sessionId: string, reason: string): Session | null {
    const existing = this.sessionRepo.findById(sessionId);
    // Escalated sessions belong to the human handoff queue. Closing the bot-side
    // chat must not silently resolve or overwrite a pending escalation.
    if (!existing || existing.status !== SessionStatus.ACTIVE) return existing;
    return this.sessionRepo.updateStatus(sessionId, SessionStatus.CLOSED, reason);
  }

  closeUserSession(sessionId: string, userIdent: string): Session {
    const existing = this.sessionRepo.findById(sessionId);
    if (!existing || existing.userIdent !== userIdent) {
      throw new NotFoundError('对话记录不存在');
    }
    return this.closeSession(sessionId, 'user_closed') ?? existing;
  }

  saveMessage(params: SaveMessageParams): Message {
    const message = this.messageRepo.create({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      intent: params.intent as Message['intent'],
      intentConf: params.intentConf,
      replyToMessageId: params.replyToMessageId,
      retrievalSnapshot: params.retrievalSnapshot,
      answerMode: params.answerMode,
      groundingStatus: params.groundingStatus,
      groundingReason: params.groundingReason,
    });
    this.sessionRepo.touch(params.sessionId);
    return message;
  }

  saveMessageAndEscalate(params: SaveMessageParams, escalationReason: string): Message {
    return this.db.transaction(() => {
      const message = this.saveMessage(params);
      this.escalationService.createEscalation(params.sessionId, escalationReason);
      this.messageRepo.markEscalated(message.id);
      return { ...message, escalated: 1 };
    })();
  }

  getMessages(sessionId: string): Message[] {
    return this.messageRepo.findBySession(sessionId);
  }

  getMessage(messageId: string): Message | null {
    return this.messageRepo.findById(messageId);
  }

  assertSessionOwnership(sessionId: string, userIdent: string): Session {
    const session = this.sessionRepo.findById(sessionId);
    if (!session || session.userIdent !== userIdent) {
      throw new NotFoundError('对话记录不存在');
    }
    return session;
  }

  getConversations(params: {
    page?: number;
    pageSize?: number;
    status?: SessionStatus;
  }): PaginationResponse<Session & { messageCount: number }> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const sessions = this.sessionRepo.list(params.status ?? null, pageSize, offset);
    const total = this.sessionRepo.count(params.status ?? null);

    const items = sessions.map((session) => ({
      ...session,
      messageCount: this.messageRepo.countBySession(session.id),
    }));

    return { items, total, page, pageSize };
  }

  getAdminConversations(
    params: AdminConversationQuery,
  ): PaginationResponse<Session & { messageCount: number }> {
    this.expireInactiveSessions();
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 20, 100);
    const filters = this.toRepoFilters(params);
    const offset = (page - 1) * pageSize;
    const items = this.sessionRepo.listWithFilters(filters, pageSize, offset);
    const total = this.sessionRepo.countWithFilters(filters);
    return { items, total, page, pageSize };
  }

  getUserConversations(params: {
    userIdent: string;
    page?: number;
    pageSize?: number;
  }): PaginationResponse<ChatHistorySession> {
    this.expireInactiveSessions();
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 20, 50);
    const offset = (page - 1) * pageSize;

    const sessions = this.sessionRepo.listByUserIdent(params.userIdent, pageSize, offset);
    const total = this.sessionRepo.countByUserIdent(params.userIdent);

    const items = sessions.map((session) => {
      const messages = this.messageRepo.findBySession(session.id);
      const firstUserMessage = messages.find((message) => message.role === MessageRole.USER);
      return {
        ...session,
        messageCount: messages.length,
        preview: firstUserMessage?.content ?? null,
      };
    });

    return { items, total, page, pageSize };
  }

  getConversationDetail(sessionId: string): ConversationDetail {
    this.expireInactiveSessions();
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new NotFoundError('对话记录不存在');
    }

    const messages = this.messageRepo.findBySession(sessionId);

    return {
      session: {
        id: session.id,
        userIdent: session.userIdent,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        intent: m.intent,
        intentConf: m.intentConf,
        retrievalSnapshot: m.retrievalSnapshot,
        answerMode: m.answerMode,
        groundingStatus: m.groundingStatus,
        groundingReason: m.groundingReason,
        satisfaction: m.satisfaction,
        escalated: m.escalated,
        createdAt: m.createdAt,
      })),
      escalation: null, // Will be populated by escalation service if needed
    };
  }

  getUserConversationDetail(userIdent: string, sessionId: string): ConversationDetail {
    const session = this.sessionRepo.findById(sessionId);
    if (!session || session.userIdent !== userIdent) {
      throw new NotFoundError('对话记录不存在');
    }

    return this.getConversationDetail(sessionId);
  }

  exportConversations(params: Omit<AdminConversationQuery, 'page' | 'pageSize'>): {
    csv: string;
    messageCount: number;
  } {
    this.expireInactiveSessions();
    const filters = this.toRepoFilters(params);
    const messageCount = this.sessionRepo.countExportMessages(filters);
    if (messageCount > this.exportMaxMessages) {
      throw new ConflictError(
        `筛选结果包含 ${messageCount} 条消息，超过同步导出上限 ${this.exportMaxMessages} 条，请缩小日期或关键词范围`,
      );
    }

    const rows = this.sessionRepo.exportMessageRows(filters, this.exportMaxMessages);
    const headers = [
      'SessionID',
      'UserIdent',
      'Status',
      'SessionCreatedAt',
      'MessageID',
      'Role',
      'Intent',
      'Satisfaction',
      'MessageCreatedAt',
      'Content',
    ];
    const csvRows = [headers.join(',')];
    for (const row of rows) {
      csvRows.push([
        row.sessionId,
        row.userIdent,
        row.status,
        row.sessionCreatedAt,
        row.messageId,
        row.role,
        row.intent,
        row.satisfaction,
        row.messageCreatedAt,
        row.content,
      ].map((value) => this.escapeCsv(value)).join(','));
    }

    return {
      csv: '\uFEFF' + csvRows.join('\n'),
      messageCount,
    };
  }

  getActiveSessionCount(): number {
    this.expireInactiveSessions();
    return this.sessionRepo.activeCount(this.inactivityCutoff());
  }

  getInactivityMinutes(): number {
    return this.inactivityMinutes;
  }

  private inactivityCutoff(): string {
    return new Date(
      this.now().getTime() - this.inactivityMinutes * 60 * 1000,
    ).toISOString();
  }

  private toRepoFilters(
    params: Omit<AdminConversationQuery, 'page' | 'pageSize'>,
  ): ConversationFilters {
    return {
      intent: params.intent,
      status: params.status,
      keyword: params.keyword?.trim() || undefined,
      createdFrom: params.dateFrom
        ? this.utcBoundaryForLocalDay(
          params.dateFrom,
          params.timezoneOffsetMinutes ?? 0,
        )
        : undefined,
      createdToExclusive: params.dateTo
        ? this.utcBoundaryForLocalDay(
          params.dateTo,
          params.timezoneOffsetToMinutes
            ?? params.timezoneOffsetMinutes
            ?? 0,
          1,
        )
        : undefined,
    };
  }

  private utcBoundaryForLocalDay(
    date: string,
    timezoneOffsetMinutes: number,
    additionalDays: number = 0,
  ): string {
    const boundary = new Date(`${date}T00:00:00.000Z`);
    boundary.setUTCDate(boundary.getUTCDate() + additionalDays);
    boundary.setUTCMinutes(boundary.getUTCMinutes() + timezoneOffsetMinutes);
    return boundary.toISOString();
  }

  private escapeCsv(value: unknown): string {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    if (/[\r\n,"]/.test(text)) {
      text = `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}

export const conversationService = new ConversationService();
