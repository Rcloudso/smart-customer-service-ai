import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import Papa from 'papaparse';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { faqService } from '../../services/faq.service';
import { IntentCategory } from '../../types/domain';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All routes require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['text/csv', 'application/json', 'application/vnd.ms-excel'];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.csv') || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 CSV 和 JSON 格式的文件'));
    }
  },
});

const createFaqSchema = z.object({
  question: z.string().min(1, '问题不能为空'),
  answer: z.string().min(1, '回答不能为空'),
  category: z.enum(['refund', 'order', 'technical', 'general']),
  keywords: z.array(z.string()).default([]),
  isActive: z.number().int().min(0).max(1).optional(),
});

const updateFaqSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
  category: z.enum(['refund', 'order', 'technical', 'general']).optional(),
  keywords: z.array(z.string()).optional(),
  isActive: z.number().int().min(0).max(1).optional(),
});

/**
 * GET /api/admin/faq
 * List all FAQ entries with pagination.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as IntentCategory | undefined;
    const keyword = req.query.keyword as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;

    const result = faqService.listFaq({
      category: category ?? undefined,
      keyword: keyword ?? undefined,
      page,
      pageSize,
    });

    res.json({ code: 0, data: result, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/faq/index/status
 * Get FAQ vector index health and coverage.
 */
router.get('/index/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const status = faqService.getIndexStatus();
    res.json({ code: 0, data: status, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/faq/index/rebuild
 * Rebuild the FAQ vector index from active FAQ entries.
 */
router.post('/index/rebuild', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await faqService.rebuildIndex();
    res.json({ code: 0, data: status, message: 'FAQ索引已重建' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/faq
 * Create a new FAQ entry.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createFaqSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const entry = await faqService.createFaq({
      question: parsed.data.question,
      answer: parsed.data.answer,
      category: parsed.data.category as IntentCategory,
      keywords: parsed.data.keywords,
      updatedBy: req.user?.username ?? 'unknown',
    });

    res.status(201).json({ code: 0, data: entry, message: 'FAQ创建成功' });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/faq/:id
 * Update an existing FAQ entry.
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const parsed = updateFaqSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const updated = await faqService.updateFaq(id, {
      ...parsed.data,
      category: parsed.data.category as IntentCategory | undefined,
      updatedBy: req.user?.username ?? 'unknown',
    });

    res.json({ code: 0, data: updated, message: 'FAQ更新成功' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/faq/:id
 * Soft-delete an FAQ entry (set isActive = 0).
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    // Soft delete by setting isActive to 0
    await faqService.updateFaq(id, {
      isActive: 0,
      updatedBy: req.user?.username ?? 'unknown',
    });

    res.json({ code: 0, data: null, message: 'FAQ已删除' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/faq/import
 * Bulk import FAQs from CSV or JSON file.
 */
router.post('/import', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw new ValidationError('请上传文件');
    }

    const fileContent = req.file.buffer.toString('utf-8');
    const mimetype = req.file.mimetype;
    const filename = req.file.originalname;

    let items: Array<{
      question: string;
      answer: string;
      category: IntentCategory;
      keywords: string[];
    }> = [];

    if (mimetype === 'application/json' || filename.endsWith('.json')) {
      // Parse JSON
      const parsed = JSON.parse(fileContent);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      items = arr.map((item: Record<string, unknown>) => ({
        question: String(item.question ?? ''),
        answer: String(item.answer ?? ''),
        category: (item.category as IntentCategory) || IntentCategory.GENERAL,
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
      }));
    } else {
      // Parse CSV
      const parseResult = Papa.parse<Record<string, string>>(fileContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.trim(),
      });

      items = parseResult.data
        .filter((row: Record<string, string>) => row.question && row.answer)
        .map((row: Record<string, string>) => ({
          question: row.question.trim(),
          answer: row.answer.trim(),
          category: (row.category?.trim() as IntentCategory) || IntentCategory.GENERAL,
          keywords: row.keywords ? row.keywords.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
        }));
    }

    if (items.length === 0) {
      throw new ValidationError('文件中没有有效的FAQ数据');
    }

    const count = await faqService.importFaq(items, req.user?.username ?? 'unknown');

    res.json({
      code: 0,
      data: { imported: count, total: items.length },
      message: `成功导入 ${count}/${items.length} 条FAQ`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/faq/export
 * Export all active FAQ entries as CSV.
 */
router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entries = faqService.exportFaq();

    const escapeCsv = (val: unknown): string => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = ['question', 'answer', 'category', 'keywords', 'created_at', 'updated_at'];
    const csvRows = [headers.join(',')];

    for (const entry of entries) {
      csvRows.push([
        escapeCsv(entry.question),
        escapeCsv(entry.answer),
        escapeCsv(entry.category),
        escapeCsv(entry.keywords.join(',')),
        escapeCsv(entry.createdAt),
        escapeCsv(entry.updatedAt),
      ].join(','));
    }

    const csvContent = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="faq-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csvContent);

    logger.info({ count: entries.length }, 'FAQ entries exported');
  } catch (err) {
    next(err);
  }
});

export default router;
