import { getDatabase } from '../db';
import { SessionRepo } from '../db/repos/session.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { AdminOverview, IntentDistribution, SatisfactionTrend } from '../types/api';
import { IntentCategory } from '../types/domain';
import { logger } from '../utils/logger';
import { conversationService } from './conversation.service';

export class AnalyticsService {
  private sessionRepo: SessionRepo;
  private messageRepo: MessageRepo;

  constructor() {
    const db = getDatabase();
    this.sessionRepo = new SessionRepo(db);
    this.messageRepo = new MessageRepo(db);
  }

  getOverview(dateFrom?: string, dateTo?: string): AdminOverview {
    const db = getDatabase();
    const normalizedDateTo = dateTo && dateTo.length === 10
      ? `${dateTo}T23:59:59.999Z`
      : dateTo;
    const { totalSessions, totalMessages, avgSatisfaction } =
      this.sessionRepo.overviewMetrics(dateFrom, normalizedDateTo);

    const activeSessions = conversationService.getActiveSessionCount();

    // Calculate escalation rate — use the same date range
    const escalationCountStmt = db.prepare(
      `SELECT COUNT(DISTINCT e.session_id) as count FROM escalation_log e
       JOIN sessions s ON s.id = e.session_id
       WHERE s.origin = 'customer'
         AND (? IS NULL OR e.created_at >= ?) AND (? IS NULL OR e.created_at <= ?)`,
    );
    const escalationCount = (
      escalationCountStmt.get(
        dateFrom ?? null, dateFrom ?? null,
        dateTo ?? null, dateTo != null ? dateTo + 'T23:59:59.999Z' : null,
      ) as { count: number }
    ).count;

    const escalationRate = totalSessions > 0
      ? Math.round((escalationCount / totalSessions) * 10000) / 100
      : 0;

    return {
      totalConversations: totalSessions,
      totalMessages,
      avgSatisfaction: Math.round(avgSatisfaction * 100) / 100,
      escalationRate,
      activeSessions,
      activeWindowMinutes: conversationService.getInactivityMinutes(),
    };
  }

  getIntentDistribution(dateFrom?: string, dateTo?: string): IntentDistribution[] {
    // Normalize dateTo: if YYYY-MM-DD (10 chars), append T23:59:59.999Z so
    // that SQLite string comparison includes the entire end day.
    const normalizedDateTo = dateTo && dateTo.length === 10 ? dateTo + 'T23:59:59.999Z' : dateTo;
    const rawDist = this.messageRepo.intentDistribution(dateFrom, normalizedDateTo);
    const total = rawDist.reduce((sum, item) => sum + item.count, 0);

    // Ensure all categories are represented
    const allIntents = Object.values(IntentCategory);
    const distribution: IntentDistribution[] = allIntents.map((intent) => {
      const found = rawDist.find((d) => d.intent === intent);
      const count = found?.count ?? 0;
      return {
        intent,
        count,
        percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
      };
    });

    return distribution;
  }

  getSatisfactionTrend(dateFrom?: string, dateTo?: string): SatisfactionTrend[] {
    // Normalize dateTo: if YYYY-MM-DD (10 chars), append T23:59:59.999Z so
    // that SQLite string comparison includes the entire end day.
    const normalizedDateTo = dateTo && dateTo.length === 10 ? dateTo + 'T23:59:59.999Z' : dateTo;
    const rawTrend = this.messageRepo.satisfactionTrend(dateFrom, normalizedDateTo);

    // Fill in missing dates with zero values
    const trend: SatisfactionTrend[] = [];
    if (rawTrend.length > 0) {
      const startDate = dateFrom ? new Date(dateFrom) : new Date(rawTrend[0].date);
      const endDate = dateTo ? new Date(dateTo) : new Date(rawTrend[rawTrend.length - 1].date);

      const dateMap = new Map<string, SatisfactionTrend>();
      for (const item of rawTrend) {
        dateMap.set(item.date, item);
      }

      const current = new Date(startDate);
      while (current <= endDate) {
        const dateStr = current.toISOString().slice(0, 10);
        const existing = dateMap.get(dateStr);
        trend.push(
          existing ?? {
            date: dateStr,
            avgRating: 0,
            count: 0,
          },
        );
        current.setDate(current.getDate() + 1);
      }
    }

    return trend;
  }
}

export const analyticsService = new AnalyticsService();
