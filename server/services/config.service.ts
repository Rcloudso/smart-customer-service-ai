import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { config } from '../config';

// ── Env defaults snapshot ─────────────────────────
// Captured at module load time so syncRuntimeConfig() resets use true env values.
const ENV_DEFAULTS: Record<string, string> = {
  llmApiBase: config.llm.apiBase,
  llmModel: config.llm.model,
  llmApiKey: config.llm.apiKey,
  embedProvider: config.embed.provider,
  embedApiBase: config.embed.apiBase,
  embedModel: config.embed.model,
  embedApiKey: config.embed.apiKey,
};

const HAS_EXPLICIT_EMBED_API_KEY = !!process.env.EMBED_API_KEY;

// ── DTOs ───────────────────────────────────────────

export interface ModelConfigDTO {
  llmApiBase: string;
  llmModel: string;
  llmApiKey: string;
  embedProvider: string;
  embedApiBase: string;
  embedModel: string;
  embedApiKey: string;
}

export interface ModelConfigResponseDTO extends ModelConfigDTO {
  llmApiKeyOverridden: boolean;
  embedApiKeyOverridden: boolean;
}

// ── Config Keys ────────────────────────────────────

const CONFIG_KEYS = [
  'llmApiBase',
  'llmModel',
  'llmApiKey',
  'embedProvider',
  'embedApiBase',
  'embedModel',
  'embedApiKey',
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Service to read/write model configuration stored in the DB,
 * with env vars as defaults.
 */
export class ConfigService {
  private db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  /**
   * Return all 7 config keys with effective values and overridden flags.
   * API keys are masked in the response for security.
   */
  getAll(): ModelConfigResponseDTO {
    const dto: ModelConfigDTO = {
      llmApiBase: this.getEffective('llmApiBase'),
      llmModel: this.getEffective('llmModel'),
      llmApiKey: this.getEffective('llmApiKey'),
      embedProvider: this.getEffective('embedProvider'),
      embedApiBase: this.getEffective('embedApiBase'),
      embedModel: this.getEffective('embedModel'),
      embedApiKey: this.getEffective('embedApiKey'),
    };

    const llmApiKeyOverridden = this.isOverridden('llmApiKey');
    const embedApiKeyOverridden = this.isOverridden('embedApiKey');

    return {
      ...dto,
      llmApiKey: this.maskApiKey(dto.llmApiKey),
      embedApiKey: this.maskApiKey(dto.embedApiKey),
      llmApiKeyOverridden,
      embedApiKeyOverridden,
    };
  }

  /**
   * Reset (delete) specific config keys from DB so they fall back to env defaults.
   */
  reset(keys: string[]): void {
    const stmt = this.db.prepare('DELETE FROM model_configs WHERE key = ?');
    const transaction = this.db.transaction((items: string[]) => {
      for (const key of items) {
        stmt.run(key);
      }
    });
    transaction(keys);
    this.syncRuntimeConfig();
  }

  /**
   * Update model config in DB. Only non-empty values are written.
   * Empty/undefined values are skipped (caller should pre-filter).
   */
  update(updates: Partial<ModelConfigDTO>): void {
    const stmt = this.db.prepare(
      `INSERT INTO model_configs (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );

    const now = new Date().toISOString();
    const transaction = this.db.transaction((items: Array<{ key: string; value: string }>) => {
      for (const item of items) {
        stmt.run(item.key, item.value, now);
      }
    });

    const items: Array<{ key: string; value: string }> = [];
    for (const key of CONFIG_KEYS) {
      const val = updates[key];
      if (val !== undefined && val !== '') {
        items.push({ key, value: val });
      }
    }

    if (items.length > 0) {
      transaction(items);
    }

    // Sync runtime config so llm-client picks up changes on next ensureFresh()
    this.syncRuntimeConfig();
  }

  /**
   * Get the effective value for a config key:
   * DB value (if non-empty) → env default.
   */
  getEffective(key: string): string {
    const stmt = this.db.prepare('SELECT value FROM model_configs WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    if (row && row.value !== '') {
      return row.value;
    }
    return this.getEnvDefault(key);
  }

  /**
   * Whether the given key has been overridden in the DB (non-empty value stored).
   */
  private isOverridden(key: string): boolean {
    const stmt = this.db.prepare('SELECT value FROM model_configs WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return !!(row && row.value !== '');
  }

  /**
   * Map a config key to its env default from the snapshot captured at module load.
   * Uses ENV_DEFAULTS instead of live config.* so that syncRuntimeConfig()
   * mutations don't pollute the fallback values.
   */
  private getEnvDefault(key: string): string {
    return ENV_DEFAULTS[key] ?? '';
  }

  /**
   * Mask an API key for display:
   * - length ≤ 8 → full mask '********'
   * - length > 8  → first 4 + '***' + last 4
   * - empty       → '' (no mask needed)
   */
  private maskApiKey(value: string): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '***' + value.slice(-4);
  }

  /**
   * Hydrate runtime config from DB overrides on startup.
   * Iterates all 7 config keys: if a key is overridden in DB,
   * writes its effective value back into config.*.
   *
   * Must be called after DB init but before any LLM/embedding usage,
   * so that persisted overrides from a previous session are restored.
   */
  hydrate(): void {
    this.syncRuntimeConfig();
  }

  /**
   * Sync DB overrides back into the runtime config object so that
   * llm-client picks up changes on the next ensureFresh() call.
   * After resetKeys processing, getEffective() falls back to ENV_DEFAULTS.
   */
  private syncRuntimeConfig(): void {
    (config.llm as Record<string, string>).apiBase = this.getEffective('llmApiBase');
    (config.llm as Record<string, string>).apiKey = this.getEffective('llmApiKey');
    (config.llm as Record<string, string>).model = this.getEffective('llmModel');
    (config.embed as Record<string, string>).provider = this.getEffective('embedProvider');
    (config.embed as Record<string, string>).apiBase = this.getEffective('embedApiBase');
    // embedApiKey: only use the DB-overridden value if it was explicitly set in DB.
    // Otherwise set to '' so that llm-client.ts line 42 fallback
    // (config.embed.apiKey || config.llm.apiKey) can pick up the latest LLM key.
    if (this.isOverridden('embedApiKey')) {
      (config.embed as Record<string, string>).apiKey = this.getEffective('embedApiKey');
    } else if (HAS_EXPLICIT_EMBED_API_KEY) {
      (config.embed as Record<string, string>).apiKey = this.getEnvDefault('embedApiKey');
    } else {
      (config.embed as Record<string, string>).apiKey = '';
    }
    (config.embed as Record<string, string>).model = this.getEffective('embedModel');
  }
}

/** Singleton instance, initialized lazily with the database. */
let serviceInstance: ConfigService | null = null;

function getConfigService(): ConfigService {
  if (!serviceInstance) {
    serviceInstance = new ConfigService(getDatabase());
  }
  return serviceInstance;
}

/**
 * Singleton accessor — transparently delegates to the lazily-initialized instance.
 * Usage: `configService.getAll()`, `configService.update(...)`, etc.
 */
export const configService: Pick<ConfigService, 'getAll' | 'update' | 'reset' | 'getEffective' | 'hydrate'> = {
  getAll(): ReturnType<ConfigService['getAll']> {
    return getConfigService().getAll();
  },
  update(updates: Parameters<ConfigService['update']>[0]): ReturnType<ConfigService['update']> {
    return getConfigService().update(updates);
  },
  reset(keys: string[]): ReturnType<ConfigService['reset']> {
    return getConfigService().reset(keys);
  },
  getEffective(key: string): ReturnType<ConfigService['getEffective']> {
    return getConfigService().getEffective(key);
  },
  hydrate(): void {
    return getConfigService().hydrate();
  },
};
