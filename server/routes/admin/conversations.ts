import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { conversationService } from '../../services/conversation.service';
import { escalationService } from '../../services/escalation.service';
import { getDatabase } from '../../db';
import { escapeLikePattern } from '../../utils/sql';
import { logger } from '../../utils/logger';

const router = Router();

// All routes in this file require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  intent: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  keyword: z.string().optional(),
});

/**
 * GET /api/admin/conversations
 * List conversations with filtering and pagination.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        code: 400,
        data: null,
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
      return;
    }

    const { page, limit, intent, from, to, keyword } = parsed.data;

    const db = getDatabase();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (from) {
      conditions.push('s.created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('s.created_at <= ?');
      params.push(to + 'T23:59:59.999Z');
    }
    if (intent) {
      conditions.push(
        'EXISTS (SELECT 1 FROM messages mi WHERE mi.session_id = s.id AND mi.intent = ?)',
      );
      params.push(intent);
    }
    if (keyword) {
      conditions.push(
        "EXISTS (SELECT 1 FROM messages mk WHERE mk.session_id = s.id AND LOWER(mk.content) LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escapeLikePattern(keyword.toLowerCase())}%`);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const rows = db.prepare(
      `SELECT
         s.id,
         s.user_ident,
         s.status,
         s.created_at,
         s.updated_at,
         s.closed_at,
         COUNT(m.id) as message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       ${whereClause}
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, (page - 1) * limit) as Array<{
      id: string;
      user_ident: string;
      status: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
      message_count: number;
    }>;

    const items = rows.map((row) => ({
      id: row.id,
      userIdent: row.user_ident,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      messageCount: row.message_count,
    }));

    const total = (db.prepare(
      `SELECT COUNT(*) as c FROM sessions s ${whereClause}`,
    ).get(...params) as { c: number }).c;

    res.json({
      code: 0,
      data: {
        items,
        total,
        page,
        pageSize: limit,
      },
      message: 'ok',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/conversations/export
 * Export conversations as CSV.
 */
router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dateFrom = req.query.from as string | undefined;
    const dateTo = req.query.to as string | undefined;

    const data = conversationService.exportConversations({ dateFrom, dateTo });

    // Build CSV
    const escapeCsv = (val: unknown): string => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = ['SessionID', 'UserIdent', 'Status', 'MessageCount', 'CreatedAt', 'Messages'];
    const csvRows = [headers.join(',')];

    for (const row of data) {
      const messages = Array.isArray(row.messages)
        ? (row.messages as Array<Record<string, unknown>>)
            .map((m: Record<string, unknown>) => `${m.role}: ${String(m.content ?? '').slice(0, 200)}`)
            .join(' | ')
        : '';
      csvRows.push([
        escapeCsv(row.sessionId),
        escapeCsv(row.userIdent),
        escapeCsv(row.status),
        escapeCsv(row.messageCount),
        escapeCsv(row.createdAt),
        escapeCsv(messages),
      ].join(','));
    }

    const csvContent = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="conversations-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csvContent); // BOM for Excel UTF-8 support

    logger.info({ count: data.length }, 'Conversations exported');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/conversations/:sessionId
 * Get conversation detail with messages.
 */
router.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string;

    const detail = conversationService.getConversationDetail(sessionId);

    // Add escalation info if available
    const escalation = escalationService.findBySession(sessionId);
    if (escalation) {
      detail.escalation = {
        id: escalation.id,
        reason: escalation.reason,
        status: escalation.status,
        createdAt: escalation.createdAt,
      };
    }

    res.json({ code: 0, data: detail, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

// CRITICAL: the /export route must be registered before /:sessionId
// This is handled by Express route ordering — /export is defined above

export default router;
