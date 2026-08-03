import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { authMiddleware } from '../../middleware/auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { getOnboardingService } from '../../services/onboarding.service';
import { ValidationError } from '../../utils/errors';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);
router.use(idempotencyMiddleware);

const uuid = z.string().uuid();
const guidedAnswerSchema = z.object({ sessionId: uuid, messageId: uuid }).strict();
const evidenceSchema = z.object({ messageId: uuid }).strict();

router.get('/', (_req, res, next) => respond(res, next, () => getOnboardingService().getOverview()));
router.post('/start', (_req, res, next) => respond(res, next, () => getOnboardingService().start()));
router.post('/sample-pack', (req, res, next) => respondAsync(res, next, async () => {
  requireIdempotencyKey(req);
  return getOnboardingService().installSamplePack();
}));
router.post('/guided-answer', (req, res, next) => respond(res, next, () => {
  const data = parse(guidedAnswerSchema, req.body);
  return getOnboardingService().recordGuidedAnswer(data);
}));
router.post('/evidence-reviewed', (req, res, next) => respond(res, next, () => {
  const data = parse(evidenceSchema, req.body);
  return getOnboardingService().evidenceReviewed(data.messageId);
}));
router.post('/dismiss', (_req, res, next) => respond(res, next, () => getOnboardingService().dismiss()));

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.errors.map((item) => item.message).join('; '));
  }
  return result.data;
}

function requireIdempotencyKey(req: Request): void {
  if (!req.get('Idempotency-Key')) throw new ValidationError('Idempotency-Key is required');
}

function respond(res: Response, next: NextFunction, work: () => unknown): void {
  try {
    res.json({ code: 0, data: work(), message: 'ok' });
  } catch (error) {
    next(error);
  }
}

async function respondAsync(
  res: Response,
  next: NextFunction,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    res.json({ code: 0, data: await work(), message: 'ok' });
  } catch (error) {
    next(error);
  }
}

export default router;
