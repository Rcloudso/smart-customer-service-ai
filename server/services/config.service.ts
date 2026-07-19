import {
  config,
  ModelProvider,
  resolveModelApiBase,
  resolveModelEnvironment,
} from '../config';
import { updateEnvFileAtomically } from './model-env-file';

export interface ModelConfigDTO {
  llmProvider: ModelProvider;
  llmApiBase: string;
  llmModel: string;
  embedProvider: ModelProvider;
  embedApiBase: string;
  embedModel: string;
}

export interface ModelConfigResponseDTO extends ModelConfigDTO {
  llmApiKeyConfigured: boolean;
  embedApiKeyConfigured: boolean;
}

const CONFIG_KEYS = [
  'llmProvider',
  'llmApiBase',
  'llmModel',
  'embedProvider',
  'embedApiBase',
  'embedModel',
] as const;

export type ModelConfigKey = (typeof CONFIG_KEYS)[number];

const ENV_KEY_BY_CONFIG_KEY: Record<ModelConfigKey, string> = {
  llmProvider: 'LLM_PROVIDER',
  llmApiBase: 'LLM_API_BASE',
  llmModel: 'LLM_MODEL',
  embedProvider: 'EMBED_PROVIDER',
  embedApiBase: 'EMBED_API_BASE',
  embedModel: 'EMBED_MODEL',
};

interface RuntimeModelConfig {
  llm: {
    provider: ModelProvider;
    apiBase: string;
    model: string;
    apiKey: string;
  };
  embed: {
    provider: ModelProvider;
    apiBase: string;
    model: string;
    apiKey: string;
  };
}

export interface ConfigServiceOptions {
  envFilePath?: string;
  environment?: Record<string, string | undefined>;
  runtimeConfig?: RuntimeModelConfig;
}

/**
 * Model configuration is environment-owned. Legacy SQLite rows are accepted
 * for database compatibility but intentionally never participate in reads.
 */
export class ConfigService {
  private readonly envFilePath: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly runtimeConfig: RuntimeModelConfig;

  constructor(options: ConfigServiceOptions = {}) {
    this.envFilePath = options.envFilePath ?? config.modelConfigEnvPath;
    this.environment = options.environment ?? process.env;
    this.runtimeConfig = options.runtimeConfig ?? config;
  }

  /** Return editable non-secret config plus environment credential status. */
  getAll(): ModelConfigResponseDTO {
    const resolved = resolveModelEnvironment(this.environment);
    return {
      llmProvider: resolved.llmProvider,
      llmApiBase: resolved.llmApiBase,
      llmModel: resolved.llmModel,
      embedProvider: resolved.embedProvider,
      embedApiBase: resolved.embedApiBase,
      embedModel: resolved.embedModel,
      llmApiKeyConfigured: Boolean(resolved.llmApiKey),
      embedApiKeyConfigured: Boolean(resolved.embedApiKey),
    };
  }

  /**
   * Persist non-secret admin changes to the configured .env file, then update
   * this process. The runtime is mutated only after the atomic rename succeeds.
   */
  save(
    updates: Partial<ModelConfigDTO>,
    resetKeys: ModelConfigKey[] = [],
  ): void {
    const resetSet = new Set<ModelConfigKey>(resetKeys);
    const envUpdates: Record<string, string> = {};

    for (const key of CONFIG_KEYS) {
      const value = updates[key];
      if (value === undefined) continue;
      if (value === '') {
        resetSet.add(key);
        continue;
      }
      resetSet.delete(key);
      envUpdates[ENV_KEY_BY_CONFIG_KEY[key]] = value;
    }

    const envRemovals = [...resetSet].map((key) => ENV_KEY_BY_CONFIG_KEY[key]);
    if (Object.keys(envUpdates).length > 0 || envRemovals.length > 0) {
      updateEnvFileAtomically(this.envFilePath, envUpdates, envRemovals);
    }

    for (const envKey of envRemovals) {
      delete this.environment[envKey];
    }
    for (const [envKey, value] of Object.entries(envUpdates)) {
      this.environment[envKey] = value;
    }

    this.syncRuntimeConfig();
  }

  /** Apply the current environment to the live clients during startup. */
  hydrate(): void {
    this.syncRuntimeConfig();
  }

  private syncRuntimeConfig(): void {
    const resolved = resolveModelEnvironment(this.environment);

    this.runtimeConfig.llm.provider = resolved.llmProvider;
    this.runtimeConfig.llm.apiBase = resolveModelApiBase(
      resolved.llmProvider,
      resolved.llmApiBase,
    );
    this.runtimeConfig.llm.model = resolved.llmModel;
    this.runtimeConfig.llm.apiKey = resolved.llmApiKey;

    this.runtimeConfig.embed.provider = resolved.embedProvider;
    this.runtimeConfig.embed.apiBase = resolveModelApiBase(
      resolved.embedProvider,
      resolved.embedApiBase,
    );
    this.runtimeConfig.embed.model = resolved.embedModel;
    this.runtimeConfig.embed.apiKey = resolved.embedApiKey;
  }
}

let serviceInstance: ConfigService | null = null;

function getConfigService(): ConfigService {
  if (!serviceInstance) {
    serviceInstance = new ConfigService();
  }
  return serviceInstance;
}

export const configService: Pick<ConfigService, 'getAll' | 'save' | 'hydrate'> = {
  getAll(): ReturnType<ConfigService['getAll']> {
    return getConfigService().getAll();
  },
  save(
    updates: Parameters<ConfigService['save']>[0],
    resetKeys?: Parameters<ConfigService['save']>[1],
  ): ReturnType<ConfigService['save']> {
    return getConfigService().save(updates, resetKeys);
  },
  hydrate(): void {
    return getConfigService().hydrate();
  },
};
