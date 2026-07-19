import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { chatRateLimiter, adminRateLimiter, loginRateLimiter } from './middleware/rateLimit';

// Route imports — loaded lazily after DB init
let authRoutes: express.Router;
let chatRoutes: express.Router;
let faqRoutes: express.Router;
let adminConversationRoutes: express.Router;
let adminFaqRoutes: express.Router;
let adminStatsRoutes: express.Router;
let adminConfigRoutes: express.Router;
let adminKnowledgeReviewRoutes: express.Router;
let adminDocumentRoutes: express.Router;

function createApp(): express.Application {
  const app = express();

  // ---- Foundation middleware ----
  app.use(cors({
    origin: config.cors.origins,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));

  // ---- Rate limiting ----
  app.use('/api/chat', chatRateLimiter);
  app.use('/api/admin', adminRateLimiter);
  app.use('/api/auth/login', loginRateLimiter);

  // ---- API routes (registered after DB init) ----
  app.use('/api/auth', (_req, _res, next) => {
    if (!authRoutes) {
      authRoutes = require('./routes/auth').default;
    }
    return authRoutes(_req, _res, next);
  });

  app.use('/api/chat', (_req, _res, next) => {
    if (!chatRoutes) {
      chatRoutes = require('./routes/chat').default;
    }
    return chatRoutes(_req, _res, next);
  });

  app.use('/api/faq', (_req, _res, next) => {
    if (!faqRoutes) {
      faqRoutes = require('./routes/faq').default;
    }
    return faqRoutes(_req, _res, next);
  });

  app.use('/api/admin/conversations', (_req, _res, next) => {
    if (!adminConversationRoutes) {
      adminConversationRoutes = require('./routes/admin/conversations').default;
    }
    return adminConversationRoutes(_req, _res, next);
  });

  app.use('/api/admin/faq', (_req, _res, next) => {
    if (!adminFaqRoutes) {
      adminFaqRoutes = require('./routes/admin/faq').default;
    }
    return adminFaqRoutes(_req, _res, next);
  });

  app.use('/api/admin/stats', (_req, _res, next) => {
    if (!adminStatsRoutes) {
      adminStatsRoutes = require('./routes/admin/stats').default;
    }
    return adminStatsRoutes(_req, _res, next);
  });

  app.use('/api/admin/config', (_req, _res, next) => {
    if (!adminConfigRoutes) {
      adminConfigRoutes = require('./routes/admin/config').default;
    }
    return adminConfigRoutes(_req, _res, next);
  });

  app.use('/api/admin/knowledge-reviews', (_req, _res, next) => {
    if (!adminKnowledgeReviewRoutes) {
      adminKnowledgeReviewRoutes = require('./routes/admin/knowledge-reviews').default;
    }
    return adminKnowledgeReviewRoutes(_req, _res, next);
  });

  app.use('/api/admin/documents', (_req, _res, next) => {
    if (!adminDocumentRoutes) {
      adminDocumentRoutes = require('./routes/admin/documents').default;
    }
    return adminDocumentRoutes(_req, _res, next);
  });

  // ---- Health check ----
  app.get('/api/health', (_req, res) => {
    res.json({ code: 0, data: { status: 'ok', uptime: process.uptime() }, message: 'ok' });
  });

  // ---- Error handler (must be last) ----
  app.use(errorHandler);

  return app;
}

// ---- Initialize and start ----
async function start(): Promise<void> {
  try {
    // Initialize database
    const { getDatabase } = await import('./db');
    getDatabase();
    logger.info('Database initialized');

    // Hydrate runtime config from environment-owned model settings.
    const { configService } = await import('./services/config.service');
    configService.hydrate();
    logger.info('Runtime config hydrated from environment');

    // Initialize semantic search index
    const { semanticSearch } = await import('./ai/semantic-search');
    await semanticSearch.initialize();
    logger.info('Semantic search index initialized');

    const app = createApp();

    app.listen(config.port, () => {
      logger.info({ port: config.port, env: config.nodeEnv }, '🚀 Server started');
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { createApp };
