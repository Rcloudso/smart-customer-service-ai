import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { authMiddleware } from '../../middleware/auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { getRetrievalIndexJobService } from '../../services/retrieval-index-job.service';
import { ValidationError } from '../../utils/errors';
import { getRetrievalTraceService } from '../../services/retrieval-trace.service';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);
router.use(idempotencyMiddleware);

const service = getRetrievalIndexJobService();
const traces = getRetrievalTraceService();
const uuid = z.string().uuid();
const pagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

router.get('/status', (_req, res, next) => handle(res, next, () => service.status()));
router.get('/index-jobs', (req, res, next) => handle(res, next, () => {
  const data = parse(pagination, req.query);
  return service.listJobs(data.page, data.pageSize);
}));
router.post('/index-jobs', (req, res, next) => handle(res, next, () => {
  requireIdempotencyKey(req);
  parse(z.object({}).strict(), req.body ?? {});
  return service.createJob({ createdBy: actor(req) });
}, 202));
router.get('/index-jobs/:id/activation-check', (req, res, next) => handle(
  res,
  next,
  () => service.activationCheck(parse(uuid, req.params.id)),
));
router.post('/index-jobs/:id/activate', (req, res, next) => handle(res, next, () => {
  requireIdempotencyKey(req);
  const data = parse(z.object({
    expectedCurrentCollection: z.string().min(1).max(200).nullable(),
    confirmed: z.literal(true),
    confirmLatencyWarning: z.boolean().default(false),
  }).strict(), req.body);
  return service.activate({
    id: parse(uuid, req.params.id),
    expectedCurrentCollection: data.expectedCurrentCollection,
    confirmLatencyWarning: data.confirmLatencyWarning ?? false,
  });
}));
router.post('/index-jobs/:id/rollback', (req, res, next) => handle(res, next, () => {
  requireIdempotencyKey(req);
  const data = parse(z.object({
    expectedCurrentCollection: z.string().min(1).max(200),
    confirmed: z.literal(true),
  }).strict(), req.body);
  return service.rollback({ id: parse(uuid, req.params.id), ...data });
}));
router.get('/index-jobs/:id', (req, res, next) => handle(
  res,
  next,
  () => service.getJob(parse(uuid, req.params.id)),
));
router.get('/traces', (req, res, next) => handle(res, next, () => {
  const data = parse(pagination.extend({
    status: z.enum(['completed', 'degraded', 'failed']).optional(),
    backend: z.enum(['memory', 'qdrant']).optional(),
    sessionId: z.string().uuid().optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
  }), req.query);
  return traces.listTraces({
    ...data,
    page: data.page ?? 1,
    pageSize: data.pageSize ?? 20,
  });
}));
router.get('/traces/:traceId', (req, res, next) => handle(
  res,
  next,
  () => traces.getTraceDetail(parse(uuid, req.params.traceId)),
));

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.errors.map((item) => item.message).join('; '));
  }
  return result.data;
}

function actor(req: Request): string {
  return req.user?.username ?? 'unknown';
}

function requireIdempotencyKey(req: Request): void {
  if (!req.get('Idempotency-Key')) throw new ValidationError('Idempotency-Key is required');
}

function handle(
  res: Response,
  next: NextFunction,
  work: () => unknown | Promise<unknown>,
  status: number = 200,
): void {
  Promise.resolve()
    .then(work)
    .then((data) => res.status(status).json({ code: 0, data, message: 'ok' }))
    .catch(next);
}

export default router;
