import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { escalationService } from '../../services/escalation.service';
import { EscalationStatus } from '../../types/domain';
import { ValidationError } from '../../utils/errors';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const categorySchema = z.enum([
  'account_security',
  'complaint',
  'refund',
  'order',
  'technical',
  'general',
  'unknown',
]);
const prioritySchema = z.enum(['urgent', 'high', 'normal']);
const queueSchema = z.enum([
  'account_security',
  'complaints',
  'after_sales',
  'order_support',
  'technical_support',
  'general_support',
  'manual_triage',
]);
const listSchema = z.object({
  status: z.nativeEnum(EscalationStatus).default(EscalationStatus.PENDING),
  category: categorySchema.optional(),
  priority: prioritySchema.optional(),
  queue: queueSchema.optional(),
  keyword: z.string().trim().max(200, '关键词不能超过200字符').optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
const idSchema = z.string().uuid('escalationId 格式无效');

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((error) => error.message).join('; '));
    }
    const result = escalationService.listEscalations({
      ...parsed.data,
      recommendedQueue: parsed.data.queue,
    });
    res.json({ code: 0, data: result, message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.get('/:escalationId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = idSchema.safeParse(req.params.escalationId);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((error) => error.message).join('; '));
    }
    const result = escalationService.getEscalationDetail(parsed.data);
    res.json({ code: 0, data: result, message: 'ok' });
  } catch (error) {
    next(error);
  }
});

export default router;
