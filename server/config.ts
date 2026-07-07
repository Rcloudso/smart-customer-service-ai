import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Try relative path first (dev: __dirname = server/), then cwd (production fallback)
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // reads .env from process.cwd()
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LLM_PROVIDER: z.enum(['openai']).default('openai'),
  // New LLM env vars
  LLM_API_BASE: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  // New Embedding env vars
  EMBED_PROVIDER: z.enum(['openai', 'other']).default('openai'),
  EMBED_API_BASE: z.string().default(''),
  EMBED_MODEL: z.string().default(''),
  EMBED_API_KEY: z.string().default(''),
  // Legacy fallback
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),
  OPENAI_EMBED_MODEL: z.string().default(''),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters'),
  ADMIN_USERNAME: z.string().default('admin'),
  /** @dev-only: change in production — default password is weak and publicly known */
  ADMIN_PASSWORD: z.string().default('admin123'),
  DB_PATH: z.string().default('./data/customer-service.db'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_CHAT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_ADMIN: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === 'production' && env.ADMIN_PASSWORD === 'admin123') {
  console.error('❌ ADMIN_PASSWORD must be changed from the default "admin123" in production.');
  process.exit(1);
}

/**
 * Resolve LLM apiKey: LLM_API_KEY ?? OPENAI_API_KEY.
 * No startup validation — config may be overridden at runtime from DB.
 */
function resolveLlmApiKey(): string {
  return env.LLM_API_KEY || env.OPENAI_API_KEY || '';
}

/**
 * Resolve LLM model: LLM_MODEL ?? OPENAI_MODEL ?? 'gpt-4o-mini'.
 */
function resolveLlmModel(): string {
  return env.LLM_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini';
}

/**
 * Resolve Embed model: EMBED_MODEL ?? OPENAI_EMBED_MODEL ?? 'text-embedding-3-small'.
 */
function resolveEmbedModel(): string {
  return env.EMBED_MODEL || env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
}

/**
 * Resolve Embed apiKey: EMBED_API_KEY or fallback to LLM apiKey.
 */
function resolveEmbedApiKey(): string {
  if (env.EMBED_API_KEY) return env.EMBED_API_KEY;
  return resolveLlmApiKey();
}

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  llm: {
    provider: env.LLM_PROVIDER,
    apiKey: resolveLlmApiKey(),
    apiBase: env.LLM_API_BASE,
    model: resolveLlmModel(),
  },
  embed: {
    provider: env.EMBED_PROVIDER,
    apiKey: resolveEmbedApiKey(),
    apiBase: env.EMBED_API_BASE,
    model: resolveEmbedModel(),
  },
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: '24h' as const,
  },
  admin: {
    username: env.ADMIN_USERNAME,
    password: env.ADMIN_PASSWORD,
  },
  db: {
    // Use cwd-based resolution: relative DB_PATH resolves against process.cwd(),
    // absolute paths are used as-is. This avoids __dirname pointing to dist/ in production.
    path: path.isAbsolute(env.DB_PATH) ? env.DB_PATH : path.resolve(process.cwd(), env.DB_PATH),
  },
  cors: {
    origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
  },
  rateLimit: {
    chat: env.RATE_LIMIT_CHAT,
    admin: env.RATE_LIMIT_ADMIN,
    login: env.RATE_LIMIT_LOGIN,
  },
};

export type Config = typeof config;
