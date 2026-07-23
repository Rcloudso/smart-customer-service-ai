import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { authMiddleware } from '../../middleware/auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { getQualityLabService } from '../../services/quality-lab.service';
import { getQualityRunService } from '../../services/quality-run.service';
import { ValidationError } from '../../utils/errors';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);
router.use(idempotencyMiddleware);

const uuid = z.string().uuid();
const resourceId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const expectedSourceSchema = z.object({
  knowledgeType: z.enum(['faq', 'document']),
  knowledgeId: z.string().trim().min(1).max(200),
}).strict();
const caseSchema = z.object({
  id: uuid.optional(),
  query: z.string().trim().min(1).max(2000),
  expectedAnswerMode: z.enum(['direct_faq', 'grounded_generation', 'refusal']),
  expectedGroundingStatus: z.enum([
    'sufficient', 'insufficient', 'conflicting', 'high_risk', 'escalated',
  ]),
  expectedSources: z.array(expectedSourceSchema).max(20),
  language: z.enum(['zh', 'en']),
  tags: z.array(z.string().trim().min(1).max(50)).max(10),
}).strict();
const policySchema = z.object({
  directFaqThreshold: z.number().min(0).max(1),
  generationEvidenceThreshold: z.number().min(0).max(1),
  sourceDiversityRatio: z.number().min(0).max(1),
  rerankerMode: z.enum(['none', 'local_overlap_v1']),
}).strict().refine(
  (value) => value.generationEvidenceThreshold <= value.directFaqThreshold,
  { message: 'generationEvidenceThreshold cannot exceed directFaqThreshold' },
);
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
const qualityLab = getQualityLabService();
const qualityRuns = getQualityRunService();

router.get('/datasets', (_req, res, next) => handle(res, next, () => qualityLab.listDatasets()));
router.post('/datasets', (req, res, next) => handle(res, next, () => {
  const data = parse(z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
  }).strict(), req.body);
  return qualityLab.createDataset({ ...data, createdBy: actor(req) });
}, 201));
router.get('/datasets/versions/:versionId/cases', (req, res, next) => handle(
  res, next, () => qualityLab.listCases(parse(resourceId, req.params.versionId)),
));
router.put('/datasets/versions/:versionId/cases', (req, res, next) => handle(
  res, next, () => qualityLab.saveCase(
    parse(resourceId, req.params.versionId),
    parse(caseSchema, req.body),
  ),
));
router.post('/datasets/versions/:versionId/import', (req, res, next) => handle(
  res, next, () => {
    const data = parse(z.object({ cases: z.array(caseSchema.omit({ id: true })).min(1).max(500) }).strict(), req.body);
    return qualityLab.importCases(parse(resourceId, req.params.versionId), data.cases);
  },
));
router.post('/datasets/versions/:versionId/publish', (req, res, next) => handle(
  res, next, () => qualityLab.publishVersion(parse(resourceId, req.params.versionId), actor(req)),
));
router.post('/datasets/versions/:versionId/derive', (req, res, next) => handle(
  res, next, () => qualityLab.deriveVersion(parse(resourceId, req.params.versionId), actor(req)),
));

router.get('/runs', (req, res, next) => handle(res, next, () => {
  const data = parse(paginationSchema, req.query);
  return qualityRuns.listRuns(data.page, data.pageSize);
}));
router.post('/runs', (req, res, next) => handle(res, next, () => {
  const data = parse(z.object({
    datasetVersionIds: z.array(resourceId).min(1).max(20),
    policies: z.array(policySchema).max(64),
  }).strict(), req.body);
  return qualityRuns.createRun({ ...data, createdBy: actor(req) });
}, 202));
router.get('/runs/:runId', (req, res, next) => handle(
  res, next, () => qualityRuns.getRun(parse(uuid, req.params.runId)),
));
router.post('/runs/:runId/cancel', (req, res, next) => handle(
  res, next, () => qualityRuns.cancelRun(parse(uuid, req.params.runId)),
));

router.get('/policies', (_req, res, next) => handle(res, next, () => ({
  current: qualityLab.getCurrentPolicy(),
  history: qualityLab.listPolicies(),
  events: qualityLab.listPolicyEvents(),
})));
router.get('/policies/promotion-check', (req, res, next) => handle(res, next, () => {
  const data = parse(z.object({ runId: uuid, candidateKey: z.string().min(1).max(300) }), req.query);
  return qualityRuns.checkPromotion(data.runId, data.candidateKey);
}));
router.post('/policies/activate', (req, res, next) => handle(res, next, () => {
  requireIdempotencyKey(req);
  const data = parse(z.object({
    runId: uuid,
    candidateKey: z.string().min(1).max(300),
    expectedCurrentPolicyId: z.string().min(1).max(200),
    confirmed: z.literal(true),
  }).strict(), req.body);
  return qualityRuns.activateCandidate({ ...data, actor: actor(req) });
}));
router.post('/policies/rollback', (req, res, next) => handle(res, next, () => {
  requireIdempotencyKey(req);
  const data = parse(z.object({
    targetPolicyId: z.string().min(1).max(200),
    expectedCurrentPolicyId: z.string().min(1).max(200),
    confirmed: z.literal(true),
  }).strict(), req.body);
  return qualityLab.rollbackPolicy({ ...data, actor: actor(req) });
}));

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
  if (!req.get('Idempotency-Key')) {
    throw new ValidationError('Idempotency-Key is required');
  }
}

function handle(
  res: Response,
  next: NextFunction,
  work: () => unknown,
  status: number = 200,
): void {
  try {
    res.status(status).json({ code: 0, data: work(), message: 'ok' });
  } catch (error) {
    next(error);
  }
}

export default router;
