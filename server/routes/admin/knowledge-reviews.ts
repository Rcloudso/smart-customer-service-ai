import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { knowledgeReviewService } from '../../services/knowledge-review.service';
import {
  IntentCategory,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
} from '../../types/domain';
import { ValidationError } from '../../utils/errors';

const router = Router();

router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const listSchema = z.object({
  status: z.nativeEnum(KnowledgeReviewStatus).optional(),
  triggerReason: z.nativeEnum(KnowledgeReviewTriggerReason).optional(),
  keyword: z.string().max(200, '关键词不能超过200个字符').optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const convertSchema = z.object({
  question: z.string().trim().min(1, '问题不能为空').max(2000),
  answer: z.string().trim().min(1, '回答不能为空').max(10000),
  category: z.nativeEnum(IntentCategory),
  keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

const dismissSchema = z.object({
  reason: z.string().trim().max(500, '忽略原因不能超过500个字符').optional(),
});

function validationMessage(error: z.ZodError): string {
  return error.errors.map((item) => item.message).join('; ');
}

router.get('/stats', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ code: 0, data: knowledgeReviewService.getStats(), message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    res.json({ code: 0, data: knowledgeReviewService.list(parsed.data), message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/convert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = convertSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const result = await knowledgeReviewService.convert(req.params.id, {
      ...parsed.data,
      updatedBy: req.user?.username ?? 'unknown',
    });
    res.json({ code: 0, data: result, message: '已转为 FAQ' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/dismiss', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = dismissSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const result = knowledgeReviewService.dismiss(req.params.id, parsed.data.reason);
    res.json({ code: 0, data: result, message: '已忽略' });
  } catch (error) {
    next(error);
  }
});

export default router;
