import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function testStartupHydratesBeforeSemanticSearch(): Promise<void> {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');
  const hydratePos = source.indexOf('configService.hydrate()');
  const semanticInitPos = source.indexOf('semanticSearch.initialize()');

  assert.notEqual(hydratePos, -1, 'server startup should hydrate persisted model config');
  assert.notEqual(semanticInitPos, -1, 'server startup should initialize semantic search');
  assert.ok(
    hydratePos < semanticInitPos,
    'runtime model config must hydrate before semantic search creates embedding clients',
  );
}

async function testExplicitEmbedApiKeySurvivesHydrate(): Promise<void> {
  process.env.JWT_SECRET = 'test-secret-123';
  process.env.LLM_API_KEY = 'llm-env-key';
  process.env.EMBED_API_KEY = 'embed-env-key';
  process.env.EMBED_PROVIDER = 'openai';
  process.env.LLM_MODEL = 'llm-env-model';
  process.env.EMBED_MODEL = 'embed-env-model';

  const [{ ConfigService }, { config }] = await Promise.all([
    import('../services/config.service'),
    import('../config'),
  ]);

  const db = {
    prepare() {
      return {
        get() {
          return undefined;
        },
      };
    },
  };

  const service = new ConfigService(db as never);
  service.hydrate();

  assert.equal(config.embed.apiKey, 'embed-env-key');
}

function testProductionRejectsDefaultAdminPassword(): void {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./server/config.ts')"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'admin123',
        JWT_SECRET: 'test-secret-123',
        EMBED_PROVIDER: 'openai',
      },
    },
  );

  assert.notEqual(result.status, 0, 'production must reject the default admin password');
  assert.match(
    result.stderr + result.stdout,
    /ADMIN_PASSWORD/i,
    'default-password failure should tell the user which env var to change',
  );
}

function testConversationListDoesNotUseMessageNPlusOne(): void {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'server/routes/admin/conversations.ts'),
    'utf8',
  );

  assert.equal(
    source.includes('conversationService.getMessages'),
    false,
    'admin conversation list should push filtering and message counts to SQL',
  );
}

function testFaqSearchEscapesLikeWildcards(): void {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/db/repos/faq.repo.ts'), 'utf8');

  assert.match(source, /escapeLikePattern/, 'FAQ keyword search should escape LIKE wildcards');
  assert.match(source, /ESCAPE '\\\\'/, 'FAQ keyword search SQL should declare the escape character');
}

function testFaqImportUsesBatchEmbedding(): void {
  const serviceSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/services/faq.service.ts'),
    'utf8',
  );
  const semanticSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/semantic-search.ts'),
    'utf8',
  );

  assert.match(serviceSource, /updateIndexBatch/, 'FAQ import should update embeddings in a batch');
  assert.match(semanticSource, /updateIndexBatch/, 'semantic search should expose a batch index update');
}

function testFaqEditHydratesFormAfterDialogMount(): void {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/FaqManagementPage.tsx'),
    'utf8',
  );
  const handleEditStart = source.indexOf('const handleEdit =');
  const handleDeleteStart = source.indexOf('const handleDelete =');
  const handleEditSource = source.slice(handleEditStart, handleDeleteStart);

  assert.notEqual(handleEditStart, -1, 'FAQ edit handler should exist');
  assert.notEqual(handleDeleteStart, -1, 'FAQ delete handler should exist after edit handler');
  assert.equal(
    handleEditSource.includes('form.setFieldsValue'),
    false,
    'FAQ edit should not set form fields before the destroyOnClose dialog remounts',
  );
  assert.match(
    source,
    /initialData=\{dialogFormValues\}/,
    'FAQ dialog form should mount with the selected FAQ values as initial data',
  );
  assert.match(
    source,
    /key=\{`faq-dialog-\$\{dialogMode\}-\$\{editingId \?\? 'new'\}`\}/,
    'FAQ dialog form should remount when switching between create and edit data',
  );
}

function testPreferencesSupportLanguageAndTheme(): void {
  const preferencesPath = path.resolve(process.cwd(), 'client/src/hooks/usePreferences.ts');
  const preferencesSource = fs.readFileSync(preferencesPath, 'utf8');

  assert.match(preferencesSource, /language: Language/, 'preferences should track language');
  assert.match(preferencesSource, /theme: ThemeMode/, 'preferences should track theme mode');
  assert.match(preferencesSource, /STORAGE_KEY = 'app_preferences'/, 'preferences should use a stable localStorage key');
  assert.match(preferencesSource, /localStorage\.setItem\(STORAGE_KEY/, 'preferences should persist to localStorage');
  assert.match(preferencesSource, /document\.documentElement\.dataset\.theme/, 'theme should apply through document data-theme');
  assert.match(preferencesSource, /document\.documentElement\.lang/, 'language should apply to the html lang attribute');
}

function testUiExposesPreferenceControls(): void {
  const adminLayoutSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/AdminLayout.tsx'),
    'utf8',
  );
  const chatPageSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/ChatPage.tsx'),
    'utf8',
  );

  assert.match(adminLayoutSource, /PreferenceControls/, 'admin layout should expose language and theme controls');
  assert.match(chatPageSource, /PreferenceControls/, 'chat page should expose language and theme controls');
  assert.match(adminLayoutSource, /useTranslation/, 'admin layout should use translated copy');
  assert.match(chatPageSource, /useTranslation/, 'chat page should use translated copy');
}

function testBilingualReadmeExists(): void {
  const readmeSource = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');

  assert.match(readmeSource, /# Smart Customer Service AI/, 'README should include an English title');
  assert.match(readmeSource, /## English/, 'README should include an English section');
  assert.match(readmeSource, /## 中文/, 'README should include a Chinese section');
  assert.match(readmeSource, /中英文切换/, 'README should document Chinese-language features');
  assert.match(readmeSource, /Language switching/, 'README should document English-language features');
}

async function main(): Promise<void> {
  await testStartupHydratesBeforeSemanticSearch();
  await testExplicitEmbedApiKeySurvivesHydrate();
  testProductionRejectsDefaultAdminPassword();
  testConversationListDoesNotUseMessageNPlusOne();
  testFaqSearchEscapesLikeWildcards();
  testFaqImportUsesBatchEmbedding();
  testFaqEditHydratesFormAfterDialogMount();
  testPreferencesSupportLanguageAndTheme();
  testUiExposesPreferenceControls();
  testBilingualReadmeExists();
  console.log('Regression checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
