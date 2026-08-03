import { NextFunction, Response, Router } from 'express';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { authMiddleware } from '../../middleware/auth';
import { getOperationsService } from '../../services/operations.service';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

router.get('/overview', (_req, res, next) => respond(res, next, () => (
  getOperationsService().overview()
)));

function respond(
  res: Response,
  next: NextFunction,
  work: () => Promise<unknown>,
): void {
  void work()
    .then((data) => res.json({ code: 0, data, message: 'ok' }))
    .catch(next);
}

export default router;
