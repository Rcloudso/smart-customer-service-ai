import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface JwtPayload {
  id: string;
  username: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AuthError('Missing or invalid authorization header'));
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
    };
    logger.debug({ userId: decoded.id, username: decoded.username }, 'Token verified');
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AuthError('Token has expired'));
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new AuthError('Invalid token'));
    }
    return next(new AuthError('Authentication failed'));
  }
}
