import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

export const MODEL_PROVIDERS = ['openai', 'openai-compatible', 'other'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const OPENAI_API_BASE = 'https://api.openai.com/v1';

export function resolveModelApiBase(provider: ModelProvider, customApiBase: string): string {
  return provider === 'openai' ? OPENAI_API_BASE : customApiBase.trim();
}

export interface ResolvedModelEnvironment {
  llmProvider: ModelProvider;
  llmApiBase: string;
  llmModel: string;
  llmApiKey: string;
  embedProvider: ModelProvider;
  embedApiBase: string;
  embedModel: string;
  embedApiKey: string;
}

interface ModelEnvironmentSource {
  LLM_PROVIDER?: string;
  LLM_API_BASE?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  EMBED_PROVIDER?: string;
  EMBED_API_BASE?: string;
  EMBED_MODEL?: string;
  EMBED_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBED_MODEL?: string;
}

function resolveModelProvider(rawProvider: string | undefined, apiBase: string): ModelProvider {
  if ((MODEL_PROVIDERS as readonly string[]).includes(rawProvider ?? '')) {
    return rawProvider as ModelProvider;
  }
  return apiBase && apiBase !== OPENAI_API_BASE ? 'openai-compatible' : 'openai';
}

export function resolveModelEnvironment(
  source: ModelEnvironmentSource,
): ResolvedModelEnvironment {
  const llmApiBase = (source.LLM_API_BASE ?? '').trim();
  const embedApiBase = (source.EMBED_API_BASE ?? '').trim();
  const llmApiKey = source.LLM_API_KEY || source.OPENAI_API_KEY || '';

  return {
    llmProvider: resolveModelProvider(source.LLM_PROVIDER, llmApiBase),
    llmApiBase,
    llmModel: source.LLM_MODEL || source.OPENAI_MODEL || 'gpt-4o-mini',
    llmApiKey,
    embedProvider: resolveModelProvider(source.EMBED_PROVIDER, embedApiBase),
    embedApiBase,
    embedModel: source.EMBED_MODEL || source.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    embedApiKey: source.EMBED_API_KEY || llmApiKey,
  };
}

const configuredEnvPath = process.env.MODEL_CONFIG_ENV_PATH;
const envPath = configuredEnvPath
  ? (path.isAbsolute(configuredEnvPath)
    ? configuredEnvPath
    : path.resolve(process.cwd(), configuredEnvPath))
  : path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LLM_PROVIDER: z.enum(MODEL_PROVIDERS).optional(),
  // New LLM env vars
  LLM_API_BASE: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  // New Embedding env vars
  EMBED_PROVIDER: z.enum(MODEL_PROVIDERS).optional(),
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
  DOCUMENT_UPLOAD_DIR: z.string().default('./data/uploads'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_CHAT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_ADMIN: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
  CONVERSATION_EXPORT_MAX_MESSAGES: z.coerce.number().int().positive().max(5000).default(5000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const modelEnvironment = resolveModelEnvironment(env);

if (env.NODE_ENV === 'production' && env.ADMIN_PASSWORD === 'admin123') {
  console.error('❌ ADMIN_PASSWORD must be changed from the default "admin123" in production.');
  process.exit(1);
}

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  llm: {
    provider: modelEnvironment.llmProvider,
    apiKey: modelEnvironment.llmApiKey,
    apiBase: resolveModelApiBase(modelEnvironment.llmProvider, modelEnvironment.llmApiBase),
    model: modelEnvironment.llmModel,
  },
  embed: {
    provider: modelEnvironment.embedProvider,
    apiKey: modelEnvironment.embedApiKey,
    apiBase: resolveModelApiBase(modelEnvironment.embedProvider, modelEnvironment.embedApiBase),
    model: modelEnvironment.embedModel,
  },
  modelConfigEnvPath: envPath,
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
  documents: {
    uploadDir: path.isAbsolute(env.DOCUMENT_UPLOAD_DIR)
      ? env.DOCUMENT_UPLOAD_DIR
      : path.resolve(process.cwd(), env.DOCUMENT_UPLOAD_DIR),
  },
  cors: {
    origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
  },
  rateLimit: {
    chat: env.RATE_LIMIT_CHAT,
    admin: env.RATE_LIMIT_ADMIN,
    login: env.RATE_LIMIT_LOGIN,
  },
  conversations: {
    inactivityMinutes: env.SESSION_INACTIVITY_MINUTES,
    exportMaxMessages: env.CONVERSATION_EXPORT_MAX_MESSAGES,
  },
};

export type Config = typeof config;
