import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function createConcurrencyLimiter(
  maxConcurrent: number,
  message = 'Service is busy. Please try again later.',
): RequestHandler {
  let activeRequests = 0;

  return (_req: Request, res: Response, next: NextFunction): void => {
    if (activeRequests >= maxConcurrent) {
      res.status(503).json({ code: 503, data: null, message });
      return;
    }

    activeRequests += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeRequests -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
