import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { config } from '../config';

// ── Env defaults snapshot ─────────────────────────
// Captured at module load time so syncRuntimeConfig() resets use true env values.
const ENV_DEFAULTS: Record<string, string> = {
  llmApiBase: config.llm.apiBase,
  llmModel: config.llm.model,
  embedProvider: config.embed.provider,
  embedApiBase: config.embed.apiBase,
  embedModel: config.embed.model,
};

const ENV_SECRETS = {
  llmApiKey: config.llm.apiKey,
  embedApiKey: config.embed.apiKey,
};

// ── DTOs ───────────────────────────────────────────

export interface ModelConfigDTO {
  llmApiBase: string;
  llmModel: string;
  embedProvider: string;
  embedApiBase: string;
  embedModel: string;
}

export interface ModelConfigResponseDTO extends ModelConfigDTO {
  llmApiKeyConfigured: boolean;
  embedApiKeyConfigured: boolean;
}

// ── Config Keys ────────────────────────────────────

const CONFIG_KEYS = [
  'llmApiBase',
  'llmModel',
  'embedProvider',
  'embedApiBase',
  'embedModel',
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

  /** Return editable non-secret config plus environment credential status. */
  getAll(): ModelConfigResponseDTO {
    return {
      llmApiBase: this.getEffective('llmApiBase'),
      llmModel: this.getEffective('llmModel'),
      embedProvider: this.getEffective('embedProvider'),
      embedApiBase: this.getEffective('embedApiBase'),
      embedModel: this.getEffective('embedModel'),
      llmApiKeyConfigured: Boolean(ENV_SECRETS.llmApiKey),
      embedApiKeyConfigured: Boolean(ENV_SECRETS.embedApiKey),
    };
  }

  /**
   * Reset (delete) specific config keys from DB so they fall back to env defaults.
   */
  reset(keys: ConfigKey[]): void {
    const stmt = this.db.prepare('DELETE FROM model_configs WHERE key = ?');
    const transaction = this.db.transaction((items: string[]) => {
      for (const key of items) {
        if ((CONFIG_KEYS as readonly string[]).includes(key)) stmt.run(key);
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
  private getEffective(key: ConfigKey): string {
    const stmt = this.db.prepare('SELECT value FROM model_configs WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    if (row && row.value !== '') {
      return row.value;
    }
    return this.getEnvDefault(key);
  }

  /**
   * Map a config key to its env default from the snapshot captured at module load.
   * Uses ENV_DEFAULTS instead of live config.* so that syncRuntimeConfig()
   * mutations don't pollute the fallback values.
   */
  private getEnvDefault(key: ConfigKey): string {
    return ENV_DEFAULTS[key] ?? '';
  }

  /**
   * Hydrate runtime config from DB overrides on startup.
   * Restores non-secret DB overrides while credentials remain environment-only.
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
    (config.llm as Record<string, string>).apiKey = ENV_SECRETS.llmApiKey;
    (config.llm as Record<string, string>).model = this.getEffective('llmModel');
    (config.embed as Record<string, string>).provider = this.getEffective('embedProvider');
    (config.embed as Record<string, string>).apiBase = this.getEffective('embedApiBase');
    (config.embed as Record<string, string>).apiKey = ENV_SECRETS.embedApiKey;
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
export const configService: Pick<ConfigService, 'getAll' | 'update' | 'reset' | 'hydrate'> = {
  getAll(): ReturnType<ConfigService['getAll']> {
    return getConfigService().getAll();
  },
  update(updates: Parameters<ConfigService['update']>[0]): ReturnType<ConfigService['update']> {
    return getConfigService().update(updates);
  },
  reset(keys: Parameters<ConfigService['reset']>[0]): ReturnType<ConfigService['reset']> {
    return getConfigService().reset(keys);
  },
  hydrate(): void {
    return getConfigService().hydrate();
  },
};
