import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { configService, ModelConfigDTO } from '../../services/config.service';
import { MODEL_PROVIDERS } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();

// All routes require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const modelConfigKeySchema = z.enum([
  'llmProvider',
  'llmApiBase',
  'llmModel',
  'embedProvider',
  'embedApiBase',
  'embedModel',
]);
const modelProviderSchema = z.enum(MODEL_PROVIDERS);

/** Zod schema for PUT /model body — credentials are environment-injected only. */
const updateModelConfigSchema = z.object({
  llmProvider: modelProviderSchema.optional(),
  llmApiBase: z.string().optional(),
  llmModel: z.string().optional(),
  embedProvider: modelProviderSchema.optional(),
  embedApiBase: z.string().optional(),
  embedModel: z.string().optional(),
  resetKeys: z.array(modelConfigKeySchema).optional(),
}).strict();

/**
 * GET /api/admin/config/model
 * Return current effective non-secret model config with credential status.
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
 * Update non-secret model config in the environment file.
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

    const { resetKeys = [], ...raw } = parsed.data;
    const validUpdates: Partial<ModelConfigDTO> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== '') {
        (validUpdates as Record<string, string>)[key] = value as string;
      }
    }

    configService.save(validUpdates, resetKeys);
    logger.info(
      { updates: Object.keys(validUpdates), resets: resetKeys },
      'Model environment config updated',
    );

    res.json({ code: 0, data: null, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
