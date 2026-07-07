import { getDatabase } from '../db';
import { SessionRepo } from '../db/repos/session.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { Session, SessionStatus, Message, MessageRole } from '../types/domain';
import { ChatHistorySession, ConversationDetail, PaginationResponse } from '../types/api';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export class ConversationService {
  private sessionRepo: SessionRepo;
  private messageRepo: MessageRepo;

  constructor() {
    const db = getDatabase();
    this.sessionRepo = new SessionRepo(db);
    this.messageRepo = new MessageRepo(db);
  }

  createSession(userIdent: string): Session {
    const session = this.sessionRepo.create(userIdent);
    logger.info({ sessionId: session.id, userIdent }, 'New session created');
    return session;
  }

  getOrCreateSession(userIdent: string): Session {
    let session = this.sessionRepo.findByUserIdent(userIdent, SessionStatus.ACTIVE);
    if (!session) {
      session = this.createSession(userIdent);
    }
    return session;
  }

  saveMessage(params: {
    sessionId: string;
    role: MessageRole;
    content: string;
    intent?: string | null;
    intentConf?: number | null;
  }): Message {
    const message = this.messageRepo.create({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      intent: params.intent as Message['intent'],
      intentConf: params.intentConf,
    });
    this.sessionRepo.touch(params.sessionId);
    return message;
  }

  getMessages(sessionId: string): Message[] {
    return this.messageRepo.findBySession(sessionId);
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

  getUserConversations(params: {
    userIdent: string;
    page?: number;
    pageSize?: number;
  }): PaginationResponse<ChatHistorySession> {
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
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        intent: m.intent,
        intentConf: m.intentConf,
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

  exportConversations(params: {
    dateFrom?: string;
    dateTo?: string;
  }): Array<Record<string, unknown>> {
    // Load ALL sessions for export (exports are occasional, data volume is typically manageable).
    const sessions = this.sessionRepo.list(null, 999999, 0);
    const result: Array<Record<string, unknown>> = [];

    for (const session of sessions) {
      const sessionDate = session.createdAt.slice(0, 10);
      if (params.dateFrom && sessionDate < params.dateFrom) continue;
      if (params.dateTo && sessionDate > params.dateTo) continue;

      const messages = this.messageRepo.findBySession(session.id);
      result.push({
        sessionId: session.id,
        userIdent: session.userIdent,
        status: session.status,
        messageCount: messages.length,
        createdAt: session.createdAt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          intent: m.intent,
          satisfaction: m.satisfaction,
          createdAt: m.createdAt,
        })),
      });
    }

    return result;
  }
}

export const conversationService = new ConversationService();
