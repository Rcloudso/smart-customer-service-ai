import { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors';

export function adminOnlyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    return next(new ForbiddenError('Authentication required'));
  }

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return next(new ForbiddenError('Admin access required'));
  }

  next();
}
