import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.chat,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    data: null,
    message: 'Too many chat requests. Please try again later.',
  },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
  },
});

export const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.admin,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    data: null,
    message: 'Too many admin requests. Please try again later.',
  },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
  },
});

/** Strict rate limiter for login endpoint — 5 req/min per IP. */
export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.login,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    data: null,
    message: 'Too many login attempts. Please try again later.',
  },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
  },
});
