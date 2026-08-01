import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { faqService } from '../services/faq.service';
import { IntentCategory } from '../types/domain';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { toPublicFaqEntry } from './public-faq.dto';

const router = Router();

const searchSchema = z.object({
  q: z.string().min(1, '搜索关键词不能为空').max(500, '搜索关键词过长'),
  limit: z.coerce.number().int().positive().max(20).default(5),
});

const listSchema = z.object({
  category: z.nativeEnum(IntentCategory).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * GET /api/faq
 * List FAQ entries, optionally filtered by category.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const { category, page, pageSize } = parsed.data;

    const result = faqService.listFaq({
      category: category ?? undefined,
      page,
      pageSize,
    });

    res.json({
      code: 0,
      data: { ...result, items: result.items.map(toPublicFaqEntry) },
      message: 'ok',
    });
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
