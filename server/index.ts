import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { chatRateLimiter, adminRateLimiter, loginRateLimiter } from './middleware/rateLimit';
import type { Server } from 'node:http';

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
let ready = false;

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
  app.get('/api/ready', (_req, res) => {
    if (!ready) {
      res.status(503).json({
        code: 503,
        data: { status: 'not_ready' },
        message: 'Service is not ready',
      });
      return;
    }
    res.json({ code: 0, data: { status: 'ready' }, message: 'ok' });
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

    const server = app.listen(config.port, () => {
      ready = true;
      logger.info({ port: config.port, env: config.nodeEnv }, '🚀 Server started');
    });
    registerGracefulShutdown(server);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

function registerGracefulShutdown(server: Server): void {
  let shuttingDown = false;
  let finalizing = false;
  const finalize = (code: number): void => {
    if (finalizing) return;
    finalizing = true;
    void closeDatabaseAndExit(code);
  };
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info({ signal }, 'Server shutdown started');

    const forceTimer = setTimeout(() => {
      logger.error({ signal }, 'Server shutdown timed out; closing active connections');
      server.closeAllConnections();
      finalize(1);
    }, 10_000);
    forceTimer.unref();

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) logger.error({ err: error, signal }, 'HTTP server shutdown failed');
      finalize(error ? 1 : 0);
    });
    server.closeIdleConnections();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function closeDatabaseAndExit(code: number): Promise<void> {
  try {
    const { closeDatabase } = await import('./db');
    closeDatabase();
  } catch (error) {
    logger.error({ err: error }, 'Database shutdown failed');
    process.exit(1);
  }
  process.exit(code);
}

start();

export { createApp };
