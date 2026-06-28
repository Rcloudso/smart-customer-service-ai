import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { config } from '../config';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.headers['x-request-id'] || 'unknown';

  if (err instanceof AppError) {
    logger.warn(
      {
        requestId,
        statusCode: err.statusCode,
        code: err.code,
        name: err.name,
        path: req.path,
      },
      err.message,
    );

    res.status(err.statusCode).json({
      code: err.code,
      data: null,
      message: err.message,
    });
    return;
  }

  // Unexpected errors
  logger.error(
    {
      requestId,
      path: req.path,
      method: req.method,
      err: err.message,
      stack: config.isDev ? err.stack : undefined,
    },
    'Unhandled server error',
  );

  res.status(500).json({
    code: 500,
    data: null,
    message: config.isDev ? `Internal server error: ${err.message}` : 'Internal server error',
  });
}
