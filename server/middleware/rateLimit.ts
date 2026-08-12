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
});

export const faqSearchRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.faqSearch,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    data: null,
    message: 'Too many FAQ search requests. Please try again later.',
  },
});

export const orderVerifyIpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.orderVerifyIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    data: null,
    message: '订单验证尝试过多，请稍后重试',
  },
});
