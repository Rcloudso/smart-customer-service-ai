import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

export const MODEL_PROVIDERS = ['openai', 'openai-compatible', 'other'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const OPENAI_API_BASE = 'https://api.openai.com/v1';
export const VECTOR_STORE_PROVIDERS = ['memory', 'qdrant'] as const;
export type VectorStoreProvider = (typeof VECTOR_STORE_PROVIDERS)[number];
export const ORDER_TOOL_PROVIDERS = ['disabled', 'demo'] as const;
export type OrderToolProvider = (typeof ORDER_TOOL_PROVIDERS)[number];

interface OrderToolEnvironmentSource {
  ORDER_TOOL_PROVIDER?: string;
  ORDER_TOOL_TIMEOUT_MS?: string | number;
  ORDER_TOOL_GRANT_TTL_SECONDS?: string | number;
}

export interface ResolvedOrderToolEnvironment {
  provider: OrderToolProvider;
  timeoutMs: number;
  grantTtlMs: number;
}

export function resolveOrderToolEnvironment(
  source: OrderToolEnvironmentSource,
  nodeEnv: 'development' | 'production' | 'test',
): ResolvedOrderToolEnvironment {
  const defaultProvider = nodeEnv === 'production' ? 'disabled' : 'demo';
  const provider = source.ORDER_TOOL_PROVIDER ?? defaultProvider;
  if (!(ORDER_TOOL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error('ORDER_TOOL_PROVIDER must be disabled or demo');
  }
  const timeoutMs = z.coerce.number().int().min(500).max(10_000)
    .parse(source.ORDER_TOOL_TIMEOUT_MS ?? 3_000);
  const grantTtlSeconds = z.coerce.number().int().min(60).max(3_600)
    .parse(source.ORDER_TOOL_GRANT_TTL_SECONDS ?? 600);
  return {
    provider: provider as OrderToolProvider,
    timeoutMs,
    grantTtlMs: grantTtlSeconds * 1_000,
  };
}

export function resolveModelApiBase(provider: ModelProvider, customApiBase: string): string {
  const apiBase = provider === 'openai' ? OPENAI_API_BASE : customApiBase.trim();
  if (!apiBase) return apiBase;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiBase);
  } catch {
    throw new Error('Model API base must be a valid http or https URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Model API base must use http or https');
  }
  return apiBase;
}

function normalizeModelApiBase(provider: ModelProvider, customApiBase: string): string {
  return resolveModelApiBase(provider, customApiBase).replace(/\/+$/, '');
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

interface VectorStoreEnvironmentSource {
  VECTOR_STORE_PROVIDER?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION_PREFIX?: string;
  QDRANT_COLLECTION_ALIAS?: string;
  QDRANT_TIMEOUT_MS?: string | number;
  RETRIEVAL_TRACE_RETENTION_DAYS?: string | number;
}

export interface ResolvedVectorStoreEnvironment {
  provider: VectorStoreProvider;
  qdrantUrl: string;
  qdrantApiKey: string;
  collectionPrefix: string;
  collectionAlias: string;
  timeoutMs: number;
  traceRetentionDays: number;
}

export function resolveVectorStoreEnvironment(
  source: VectorStoreEnvironmentSource,
): ResolvedVectorStoreEnvironment {
  const provider = source.VECTOR_STORE_PROVIDER ?? 'memory';
  if (!(VECTOR_STORE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error('VECTOR_STORE_PROVIDER must be memory or qdrant');
  }
  const qdrantUrl = (source.QDRANT_URL ?? '').trim().replace(/\/+$/, '');
  if (provider === 'qdrant' && !qdrantUrl) {
    throw new Error('QDRANT_URL is required when VECTOR_STORE_PROVIDER=qdrant');
  }
  if (qdrantUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(qdrantUrl);
    } catch {
      throw new Error('QDRANT_URL must be a valid http or https URL');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('QDRANT_URL must use http or https');
    }
  }
  const timeoutMs = z.coerce.number().int().min(500).max(60_000)
    .parse(source.QDRANT_TIMEOUT_MS ?? 5_000);
  const traceRetentionDays = z.coerce.number().int().min(1).max(90)
    .parse(source.RETRIEVAL_TRACE_RETENTION_DAYS ?? 30);
  return {
    provider: provider as VectorStoreProvider,
    qdrantUrl,
    qdrantApiKey: (source.QDRANT_API_KEY ?? '').trim(),
    collectionPrefix: (source.QDRANT_COLLECTION_PREFIX ?? 'resolveweave_knowledge').trim(),
    collectionAlias: (source.QDRANT_COLLECTION_ALIAS ?? 'resolveweave_knowledge_active').trim(),
    timeoutMs,
    traceRetentionDays,
  };
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
  const llmProvider = resolveModelProvider(source.LLM_PROVIDER, llmApiBase);
  const embedProvider = resolveModelProvider(source.EMBED_PROVIDER, embedApiBase);
  const effectiveLlmApiBase = normalizeModelApiBase(llmProvider, llmApiBase);
  const effectiveEmbedApiBase = normalizeModelApiBase(embedProvider, embedApiBase);
  const llmApiKey = source.LLM_API_KEY || source.OPENAI_API_KEY || '';
  const mayShareLlmCredential = effectiveLlmApiBase === effectiveEmbedApiBase;

  return {
    llmProvider,
    llmApiBase,
    llmModel: source.LLM_MODEL || source.OPENAI_MODEL || 'gpt-4o-mini',
    llmApiKey,
    embedProvider,
    embedApiBase,
    embedModel: source.EMBED_MODEL || source.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    embedApiKey: source.EMBED_API_KEY || (mayShareLlmCredential ? llmApiKey : ''),
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
  LLM_STREAM_MAX_BYTES: z.coerce.number().int().min(4096).max(4 * 1024 * 1024).default(256 * 1024),
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
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 characters').default('admin123'),
  DB_PATH: z.string().default('./data/customer-service.db'),
  DOCUMENT_UPLOAD_DIR: z.string().default('./data/uploads'),
  OCR_SERVICE_URL: z.string().default(''),
  OCR_SERVICE_TOKEN: z.string().default(''),
  OCR_ENGINE_VERSION: z.string().min(1).max(80).default('3.0.3'),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30 * 60 * 1000).default(120000),
  OCR_BACKGROUND_ENABLED: z.enum(['true', 'false']).default('true'),
  OCR_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  OCR_SHADOW_SERVICE_URL: z.string().default(''),
  OCR_SHADOW_SERVICE_TOKEN: z.string().default(''),
  OCR_SHADOW_ENGINE_VERSION: z.string().min(1).max(80).default('2.0.0'),
  VECTOR_STORE_PROVIDER: z.enum(VECTOR_STORE_PROVIDERS).default('memory'),
  QDRANT_URL: z.string().default(''),
  QDRANT_API_KEY: z.string().default(''),
  QDRANT_COLLECTION_PREFIX: z.string().min(1).max(80).default('resolveweave_knowledge'),
  QDRANT_COLLECTION_ALIAS: z.string().min(1).max(80).default('resolveweave_knowledge_active'),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  RETRIEVAL_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_CHAT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_ADMIN: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_FAQ_SEARCH: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ORDER_VERIFY_IP: z.coerce.number().int().positive().default(5),
  ORDER_TOOL_PROVIDER: z.enum(ORDER_TOOL_PROVIDERS).optional(),
  ORDER_TOOL_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(3_000),
  ORDER_TOOL_GRANT_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  FAQ_SEARCH_MAX_CONCURRENCY: z.coerce.number().int().positive().max(100).default(4),
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
const vectorStoreEnvironment = resolveVectorStoreEnvironment(env);
const orderToolEnvironment = resolveOrderToolEnvironment(env, env.NODE_ENV);

if (env.NODE_ENV === 'production' && env.ADMIN_PASSWORD === 'admin123') {
  console.error('❌ ADMIN_PASSWORD must be changed from the default "admin123" in production.');
  process.exit(1);
}

if (env.OCR_SERVICE_URL.trim() && !env.OCR_SERVICE_TOKEN.trim()) {
  console.error('❌ OCR_SERVICE_TOKEN is required when OCR_SERVICE_URL is configured.');
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
    streamMaxBytes: env.LLM_STREAM_MAX_BYTES,
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
  ocr: {
    serviceUrl: env.OCR_SERVICE_URL.trim(),
    serviceToken: env.OCR_SERVICE_TOKEN.trim(),
    engineVersion: env.OCR_ENGINE_VERSION.trim(),
    timeoutMs: env.OCR_TIMEOUT_MS,
    backgroundEnabled: env.OCR_BACKGROUND_ENABLED === 'true',
    pollIntervalMs: env.OCR_POLL_INTERVAL_MS,
    shadowServiceUrl: env.OCR_SHADOW_SERVICE_URL.trim(),
    shadowServiceToken: env.OCR_SHADOW_SERVICE_TOKEN.trim(),
    shadowEngineVersion: env.OCR_SHADOW_ENGINE_VERSION.trim(),
  },
  vectorStore: vectorStoreEnvironment,
  cors: {
    origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
  },
  rateLimit: {
    chat: env.RATE_LIMIT_CHAT,
    admin: env.RATE_LIMIT_ADMIN,
    login: env.RATE_LIMIT_LOGIN,
    faqSearch: env.RATE_LIMIT_FAQ_SEARCH,
    orderVerifyIp: env.RATE_LIMIT_ORDER_VERIFY_IP,
  },
  orderTool: orderToolEnvironment,
  faqSearch: {
    maxConcurrency: env.FAQ_SEARCH_MAX_CONCURRENCY,
  },
  conversations: {
    inactivityMinutes: env.SESSION_INACTIVITY_MINUTES,
    exportMaxMessages: env.CONVERSATION_EXPORT_MAX_MESSAGES,
  },
};

export type Config = typeof config;
