import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { conversationService } from '../../services/conversation.service';
import { escalationService } from '../../services/escalation.service';
import { logger } from '../../utils/logger';
import { IntentCategory, SessionStatus } from '../../types/domain';
import { ValidationError } from '../../utils/errors';

const router = Router();

// All routes in this file require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, '日期无效');

const filterSchema = z.object({
  intent: z.nativeEnum(IntentCategory).optional(),
  status: z.nativeEnum(SessionStatus).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  keyword: z.string().trim().max(200, '关键词不能超过200字符').optional(),
  timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0),
  timezoneOffsetTo: z.coerce.number().int().min(-840).max(840).optional(),
}).refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  { message: '开始日期不能晚于结束日期' },
);

const listSchema = filterSchema.and(z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}));

/**
 * GET /api/admin/conversations
 * List conversations with filtering and pagination.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const {
      page,
      limit,
      intent,
      status,
      from,
      to,
      keyword,
      timezoneOffset,
      timezoneOffsetTo,
    } = parsed.data;
    const result = conversationService.getAdminConversations({
      page,
      pageSize: limit,
      intent,
      status,
      keyword,
      dateFrom: from,
      dateTo: to,
      timezoneOffsetMinutes: timezoneOffset,
      timezoneOffsetToMinutes: timezoneOffsetTo,
    });

    res.json({
      code: 0,
      data: result,
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
    const parsed = filterSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const {
      from,
      to,
      intent,
      status,
      keyword,
      timezoneOffset,
      timezoneOffsetTo,
    } = parsed.data;
    const result = conversationService.exportConversations({
      dateFrom: from,
      dateTo: to,
      intent,
      status,
      keyword,
      timezoneOffsetMinutes: timezoneOffset,
      timezoneOffsetToMinutes: timezoneOffsetTo,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="conversations-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Export-Message-Count', String(result.messageCount));
    res.send(result.csv);

    logger.info({ messageCount: result.messageCount }, 'Filtered conversation messages exported');
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
