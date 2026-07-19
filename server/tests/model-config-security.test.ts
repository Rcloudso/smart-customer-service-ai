import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.JWT_SECRET = 'test-secret-123';
process.env.LLM_API_KEY = 'llm-secret-from-environment';
process.env.EMBED_API_KEY = 'embed-secret-from-environment';
process.env.LLM_PROVIDER = 'openai';
process.env.LLM_API_BASE = '';
process.env.LLM_MODEL = 'gpt-4o-mini';
process.env.EMBED_PROVIDER = 'openai';
process.env.EMBED_API_BASE = '';
process.env.EMBED_MODEL = 'text-embedding-3-small';

function createTempEnv(contents: string): {
  dirPath: string;
  filePath: string;
  cleanup: () => void;
} {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-env-'));
  const filePath = path.join(dirPath, '.env');
  fs.writeFileSync(filePath, contents, { mode: 0o600 });

  return {
    dirPath,
    filePath,
    cleanup: () => {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.rmdirSync(dirPath);
    },
  };
}

function createRuntimeConfig() {
  return {
    llm: {
      provider: 'openai' as const,
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: '',
    },
    embed: {
      provider: 'openai' as const,
      apiBase: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      apiKey: '',
    },
  };
}

async function testStartupPurgesPersistedApiKeys(): Promise<void> {
  const { initSchema } = await import('../db');
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE model_configs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO model_configs (key, value, updated_at) VALUES (?, ?, ?)',
  );
  insert.run('llmApiKey', 'persisted-llm-secret', new Date().toISOString());
  insert.run('embedApiKey', 'persisted-embed-secret', new Date().toISOString());
  insert.run('llmModel', 'persisted-model', new Date().toISOString());

  initSchema(db);

  const secretCount = db.prepare(
    "SELECT COUNT(*) AS count FROM model_configs WHERE key IN ('llmApiKey', 'embedApiKey')",
  ).get() as { count: number };
  assert.equal(secretCount.count, 0, 'startup must purge API keys persisted by older versions');

  const model = db.prepare(
    "SELECT value FROM model_configs WHERE key = 'llmModel'",
  ).get() as { value: string } | undefined;
  assert.equal(model?.value, 'persisted-model', 'secret cleanup must preserve non-secret overrides');

  db.close();
}

async function testConfigContractExposesOnlyCredentialStatus(): Promise<void> {
  const [{ initSchema }, { ConfigService }] = await Promise.all([
    import('../db'),
    import('../services/config.service'),
  ]);
  const db = new Database(':memory:');
  initSchema(db);
  const tempEnv = createTempEnv('# isolated test env\n');
  const environment = {
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'llm-secret-from-environment',
    EMBED_PROVIDER: 'openai',
    EMBED_API_KEY: 'embed-secret-from-environment',
  };
  const runtimeConfig = createRuntimeConfig();
  const service = new ConfigService({
    envFilePath: tempEnv.filePath,
    environment,
    runtimeConfig,
  });

  service.hydrate();
  const response = service.getAll() as unknown as Record<string, unknown>;

  assert.equal('llmApiKey' in response, false, 'model config must never return the LLM API key');
  assert.equal('embedApiKey' in response, false, 'model config must never return the embedding API key');
  assert.equal(response.llmApiKeyConfigured, true, 'response should expose LLM credential status');
  assert.equal(response.embedApiKeyConfigured, true, 'response should expose embedding credential status');
  assert.equal(runtimeConfig.llm.apiKey, 'llm-secret-from-environment');
  assert.equal(runtimeConfig.embed.apiKey, 'embed-secret-from-environment');

  db.close();
  tempEnv.cleanup();
}

async function testEnvironmentOverridesLegacyDatabaseConfig(): Promise<void> {
  const [{ initSchema }, { ConfigService }] = await Promise.all([
    import('../db'),
    import('../services/config.service'),
  ]);
  const db = new Database(':memory:');
  initSchema(db);

  const insert = db.prepare(
    'INSERT INTO model_configs (key, value, updated_at) VALUES (?, ?, ?)',
  );
  const now = new Date().toISOString();
  insert.run('llmProvider', 'openai', now);
  insert.run('llmApiBase', '', now);
  insert.run('llmModel', 'stale-database-model', now);

  const tempEnv = createTempEnv([
    'LLM_API_BASE=https://compatible.example/v1',
    'LLM_MODEL=environment-model',
    'EMBED_PROVIDER=other',
    'EMBED_API_BASE=http://localhost:11434/v1',
    'EMBED_MODEL=nomic-embed-text',
    '',
  ].join('\n'));
  const environment = {
    LLM_API_BASE: 'https://compatible.example/v1',
    LLM_MODEL: 'environment-model',
    EMBED_PROVIDER: 'other',
    EMBED_API_BASE: 'http://localhost:11434/v1',
    EMBED_MODEL: 'nomic-embed-text',
  };
  const runtimeConfig = createRuntimeConfig();
  const service = new ConfigService({
    envFilePath: tempEnv.filePath,
    environment,
    runtimeConfig,
  });
  service.hydrate();

  assert.equal(
    service.getAll().llmProvider,
    'openai-compatible',
    'a custom environment base URL should infer OpenAI Compatible when provider is absent',
  );
  assert.equal(service.getAll().llmModel, 'environment-model');
  assert.equal(runtimeConfig.llm.apiBase, 'https://compatible.example/v1');
  assert.equal(runtimeConfig.embed.provider, 'other');
  assert.equal(runtimeConfig.embed.apiBase, 'http://localhost:11434/v1');

  db.close();
  tempEnv.cleanup();
}

async function testAdminSaveAtomicallyUpdatesEnvAndRuntime(): Promise<void> {
  const [{ initSchema }, { ConfigService }] = await Promise.all([
    import('../db'),
    import('../services/config.service'),
  ]);
  const db = new Database(':memory:');
  initSchema(db);
  const tempEnv = createTempEnv([
    '# preserve this comment',
    'LLM_API_KEY=secret-that-must-not-change',
    'UNRELATED_SETTING=keep-me',
    'LLM_MODEL=old-model',
    'LLM_MODEL=duplicate-model',
    '',
  ].join('\n'));
  const environment = {
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'old-model',
    LLM_API_KEY: 'secret-that-must-not-change',
    EMBED_PROVIDER: 'openai',
  };
  const runtimeConfig = createRuntimeConfig();
  const service = new ConfigService({
    envFilePath: tempEnv.filePath,
    environment,
    runtimeConfig,
  });
  service.hydrate();

  service.save({
    llmProvider: 'openai-compatible',
    llmApiBase: 'https://compatible.example/v1',
    llmModel: 'new # model',
    embedProvider: 'openai-compatible',
    embedApiBase: 'https://embeddings.example/v1',
    embedModel: 'embedding-model',
  });

  const saved = fs.readFileSync(tempEnv.filePath, 'utf8');
  assert.match(saved, /^# preserve this comment$/m);
  assert.match(saved, /^LLM_API_KEY=secret-that-must-not-change$/m);
  assert.match(saved, /^UNRELATED_SETTING=keep-me$/m);
  assert.equal((saved.match(/^LLM_MODEL=/gm) ?? []).length, 1, 'duplicate managed keys must collapse');
  assert.equal(environment.LLM_MODEL, 'new # model');
  assert.equal(runtimeConfig.llm.provider, 'openai-compatible');
  assert.equal(runtimeConfig.llm.apiBase, 'https://compatible.example/v1');
  assert.equal(runtimeConfig.llm.model, 'new # model');
  assert.equal(runtimeConfig.embed.apiBase, 'https://embeddings.example/v1');

  service.save({ llmProvider: 'openai' }, ['llmApiBase']);
  const resetSaved = fs.readFileSync(tempEnv.filePath, 'utf8');
  assert.doesNotMatch(resetSaved, /^LLM_API_BASE=/m);
  assert.equal('LLM_API_BASE' in environment, false);
  assert.equal(runtimeConfig.llm.apiBase, 'https://api.openai.com/v1');

  db.close();
  tempEnv.cleanup();
}

async function testFailedEnvWriteDoesNotMutateRuntime(): Promise<void> {
  const [{ initSchema }, { ConfigService }] = await Promise.all([
    import('../db'),
    import('../services/config.service'),
  ]);
  const db = new Database(':memory:');
  initSchema(db);
  const tempEnv = createTempEnv('LLM_PROVIDER=openai\nLLM_MODEL=before\n');
  const environment = {
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'before',
  };
  const runtimeConfig = createRuntimeConfig();
  const service = new ConfigService({
    envFilePath: tempEnv.dirPath,
    environment,
    runtimeConfig,
  });
  service.hydrate();

  assert.throws(
    () => service.save({ llmModel: 'after' }),
    'a failed env-file write must be visible to the route error handler',
  );
  assert.equal(environment.LLM_MODEL, 'before');
  assert.equal(runtimeConfig.llm.model, 'before');

  db.close();
  tempEnv.cleanup();
}

async function main(): Promise<void> {
  await testStartupPurgesPersistedApiKeys();
  await testConfigContractExposesOnlyCredentialStatus();
  await testEnvironmentOverridesLegacyDatabaseConfig();
  await testAdminSaveAtomicallyUpdatesEnvAndRuntime();
  await testFailedEnvWriteDoesNotMutateRuntime();
  console.log('Model config security checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
