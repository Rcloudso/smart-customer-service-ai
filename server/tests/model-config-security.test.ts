import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.JWT_SECRET = 'test-secret-123';
process.env.LLM_API_KEY = 'llm-secret-from-environment';
process.env.EMBED_API_KEY = 'embed-secret-from-environment';

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
  const [{ initSchema }, { ConfigService }, { config }] = await Promise.all([
    import('../db'),
    import('../services/config.service'),
    import('../config'),
  ]);
  const db = new Database(':memory:');
  initSchema(db);
  const service = new ConfigService(db);

  service.hydrate();
  const response = service.getAll() as unknown as Record<string, unknown>;

  assert.equal('llmApiKey' in response, false, 'model config must never return the LLM API key');
  assert.equal('embedApiKey' in response, false, 'model config must never return the embedding API key');
  assert.equal(response.llmApiKeyConfigured, true, 'response should expose LLM credential status');
  assert.equal(response.embedApiKeyConfigured, true, 'response should expose embedding credential status');
  assert.equal(config.llm.apiKey, 'llm-secret-from-environment');
  assert.equal(config.embed.apiKey, 'embed-secret-from-environment');

  db.close();
}

async function main(): Promise<void> {
  await testStartupPurgesPersistedApiKeys();
  await testConfigContractExposesOnlyCredentialStatus();
  console.log('Model config security checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
