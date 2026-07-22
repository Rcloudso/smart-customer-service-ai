import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { EscalationRepo } from '../db/repos/escalation.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { EscalationLog, EscalationStatus, SessionStatus } from '../types/domain';
import { logger } from '../utils/logger';

export class EscalationService {
  private db: Database.Database;
  private escalationRepo: EscalationRepo;
  private sessionRepo: SessionRepo;

  constructor(db: Database.Database = getDatabase()) {
    this.db = db;
    this.escalationRepo = new EscalationRepo(db);
    this.sessionRepo = new SessionRepo(db);
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

  createEscalation(sessionId: string, reason: string): EscalationLog {
    const now = new Date().toISOString();
    const escalation: EscalationLog = {
      id: uuidv4(),
      sessionId,
      reason,
      status: EscalationStatus.PENDING,
      resolvedAt: null,
      createdAt: now,
    };

    this.db.transaction(() => {
      this.escalationRepo.create(escalation);
      this.sessionRepo.updateStatus(sessionId, SessionStatus.ESCALATED);
    })();

    logger.info({ escalationId: escalation.id, sessionId, reason }, 'Escalation created');
    return escalation;
  }

  getQueue(): EscalationLog[] {
    return this.escalationRepo.listPending();
  }

  getQueueStatus(): { pending: number; resolved: number; total: number } {
    return this.escalationRepo.countByStatus();
  }

  findBySession(sessionId: string): EscalationLog | null {
    return this.escalationRepo.findBySession(sessionId);
  }
}

export const escalationService = new EscalationService();
