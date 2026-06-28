import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { configService, ModelConfigDTO } from '../../services/config.service';
import { logger } from '../../utils/logger';

const router = Router();

// All routes require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/** Zod schema for PUT /model body — all fields optional string, plus resetKeys array. */
const updateModelConfigSchema = z.object({
  llmApiBase: z.string().optional(),
  llmModel: z.string().optional(),
  llmApiKey: z.string().optional(),
  embedProvider: z.string().optional(),
  embedApiBase: z.string().optional(),
  embedModel: z.string().optional(),
  embedApiKey: z.string().optional(),
  resetKeys: z.array(z.string()).optional(),
});

/**
 * GET /api/admin/config/model
 * Return current effective model config with masked API keys.
 */
router.get('/model', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = configService.getAll();
    res.json({ code: 0, data, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/config/model
 * Update model config. Only non-empty fields are persisted.
 */
router.put('/model', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateModelConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 1,
        data: null,
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    // Filter out empty strings — these mean "keep current / use env default"
    const raw = parsed.data as Record<string, string | string[] | undefined>;
    const validUpdates: Partial<ModelConfigDTO> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'resetKeys') continue; // handled separately
      if (value !== undefined && value !== '') {
        (validUpdates as Record<string, string>)[key] = value as string;
      }
    }

    // Handle resetKeys — delete the key from DB so env default takes effect
    const resetKeys = (parsed.data as Record<string, string[] | undefined>).resetKeys;
    if (resetKeys && resetKeys.length > 0) {
      configService.reset(resetKeys);
    }

    configService.update(validUpdates);
    logger.info({ updates: Object.keys(validUpdates) }, 'Model config updated');

    res.json({ code: 0, data: null, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
