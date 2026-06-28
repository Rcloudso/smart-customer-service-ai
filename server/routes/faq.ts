import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { faqService } from '../services/faq.service';
import { IntentCategory } from '../types/domain';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

const searchSchema = z.object({
  q: z.string().min(1, '搜索关键词不能为空'),
  limit: z.coerce.number().int().positive().max(20).default(5),
});

/**
 * GET /api/faq
 * List FAQ entries, optionally filtered by category.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as IntentCategory | undefined;

    if (category && !Object.values(IntentCategory).includes(category)) {
      throw new ValidationError(`无效的分类: ${category}`);
    }

    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;

    const result = faqService.listFaq({
      category: category ?? undefined,
      page,
      pageSize,
    });

    res.json({ code: 0, data: result, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/faq/search
 * Search FAQ entries by keyword with semantic search.
 */
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { q, limit } = parsed.data;

    const results = await faqService.searchFaq(q, limit);

    logger.debug({ query: q, resultsCount: results.length }, 'FAQ search performed');

    res.json({ code: 0, data: results, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
