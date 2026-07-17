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
  assert.match(source, /keywords LIKE \? ESCAPE '\\\\'/, 'FAQ keyword fallback should search stored keyword text');
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
  assert.match(semanticSource, /EMBEDDING_BATCH_SIZE/, 'FAQ embedding updates should use bounded API batches');
  assert.match(semanticSource, /slice\(i, i \+ EMBEDDING_BATCH_SIZE\)/, 'FAQ embedding updates should chunk large rebuilds/imports');
}

function testVectorStoreContractExists(): void {
  const vectorStorePath = path.resolve(process.cwd(), 'server/ai/vector-store.ts');
  assert.ok(fs.existsSync(vectorStorePath), 'semantic search should use an explicit vector store module');

  const source = fs.readFileSync(vectorStorePath, 'utf8');
  assert.match(source, /export interface VectorStore/, 'vector store should expose a swappable interface');
  assert.match(source, /upsert\(/, 'vector store should support upsert');
  assert.match(source, /delete\(/, 'vector store should support delete');
  assert.match(source, /search\(/, 'vector store should support vector search');
  assert.match(source, /stats\(/, 'vector store should expose index stats');
  assert.match(source, /clear\(/, 'vector store should support full rebuilds');
  assert.match(source, /export class InMemoryVectorStore/, 'default vector store should be in-memory');
}

function testFaqEmbeddingTextIncludesAnswerAndKeywords(): void {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/knowledge-adapters.ts'),
    'utf8',
  );

  assert.match(source, /buildFaqEmbeddingText/, 'semantic search should build a normalized FAQ embedding text');
  assert.match(source, /entry\.question/, 'FAQ embedding text should include question content');
  assert.match(source, /entry\.answer/, 'FAQ embedding text should include answer content');
  assert.match(source, /entry\.keywords\.join/, 'FAQ embedding text should include keyword content');
}

function testHybridSearchMergesVectorAndKeywordMatches(): void {
  const retrieverSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/knowledge-retriever.ts'),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/knowledge-adapters.ts'),
    'utf8',
  );
  const source = `${retrieverSource}\n${adapterSource}`;

  assert.match(source, /keywordScore/, 'hybrid FAQ matches should expose keyword scores');
  assert.match(source, /vectorScore/, 'hybrid FAQ matches should expose vector scores');
  assert.match(source, /source:\s*'hybrid'/, 'matches found by both paths should be marked hybrid');
  assert.match(source, /Map<string,\s*RetrievalResult>/, 'hybrid search should merge matches by knowledge id');
  assert.match(source, /KEYWORD_EXACT_MATCH_SCORE/, 'exact keyword matches should have a strong score');
  assert.match(source, /Math\.max\(existing\.vectorScore/, 'hybrid ranking should keep the best available score');
  assert.doesNotMatch(
    source,
    /if \(this\.index\.size > 0\)\s*\{\s*return await this\.semanticSearch\(query, topK\);?\s*\}/,
    'search should not skip keyword fallback whenever vector entries exist',
  );
}

function testFaqMatchMetadataCrossesApiTypes(): void {
  const serverApiSource = fs.readFileSync(path.resolve(process.cwd(), 'server/types/api.ts'), 'utf8');
  const chatApiSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/api/chat.ts'), 'utf8');
  const chatHookSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/hooks/useChat.ts'), 'utf8');

  for (const source of [serverApiSource, chatApiSource, chatHookSource]) {
    assert.match(source, /source\?: 'vector' \| 'keyword' \| 'hybrid'/, 'FAQ match source should cross API/client types');
    assert.match(source, /vectorScore\?: number/, 'FAQ vector score should cross API/client types');
    assert.match(source, /keywordScore\?: number/, 'FAQ keyword score should cross API/client types');
  }
}

function testFaqIndexStatusRoutesRequireAdmin(): void {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/admin/faq.ts'), 'utf8');
  const authPos = source.indexOf('router.use(authMiddleware)');
  const adminPos = source.indexOf('router.use(adminOnlyMiddleware)');
  const statusPos = source.indexOf("router.get('/index/status'");
  const rebuildPos = source.indexOf("router.post('/index/rebuild'");

  assert.notEqual(statusPos, -1, 'admin FAQ API should expose index status');
  assert.notEqual(rebuildPos, -1, 'admin FAQ API should expose index rebuild');
  assert.ok(authPos !== -1 && authPos < statusPos, 'index status route must be behind auth middleware');
  assert.ok(adminPos !== -1 && adminPos < statusPos, 'index status route must be admin-only');
  assert.ok(authPos < rebuildPos && adminPos < rebuildPos, 'index rebuild route must be admin-only');
}

function testFaqServiceExposesIndexOperations(): void {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/services/faq.service.ts'), 'utf8');

  assert.match(source, /getIndexStatus\(/, 'FAQ service should expose index status');
  assert.match(source, /rebuildIndex\(/, 'FAQ service should expose index rebuild');
  assert.match(source, /semanticSearch\.getStatus/, 'FAQ service should delegate status to semantic search');
  assert.match(source, /semanticSearch\.rebuildIndex/, 'FAQ service should delegate rebuild to semantic search');
}

function testKnowledgeConversionPreparesIndexBeforeActivation(): void {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/ai/semantic-search.ts'), 'utf8');
  assert.match(
    source,
    /prepareIndex\(/,
    'semantic search should prepare embeddings before knowledge-review activation',
  );
  assert.match(
    source,
    /commitPreparedIndex\(/,
    'semantic search should commit a successfully prepared FAQ to the in-memory index',
  );
}

function testEmbeddingRefreshDoesNotTouchFaqBusinessTimestamp(): void {
  const repoSource = fs.readFileSync(path.resolve(process.cwd(), 'server/db/repos/faq.repo.ts'), 'utf8');
  const semanticSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/semantic-search.ts'),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/ai/knowledge-adapters.ts'),
    'utf8',
  );

  assert.match(repoSource, /updateEmbeddingStmt/, 'FAQ repo should have an embedding-only update statement');
  assert.match(
    repoSource,
    /UPDATE faq_entries SET embedding = \?, embedding_profile = \? WHERE id = \?/,
    'embedding refresh should not rewrite FAQ updated_at metadata',
  );
  assert.match(
    adapterSource,
    /updateEmbedding\(/,
    'semantic index refresh should persist embeddings without touching business fields',
  );
  assert.match(
    semanticSource,
    /persistCurrentFaqEmbedding\(/,
    'semantic index refresh should publish only the latest persisted FAQ version',
  );
}

function testFaqManagementExposesIndexControls(): void {
  const apiSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/api/admin.ts'), 'utf8');
  const typeSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/types/index.ts'), 'utf8');
  const pageSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/FaqManagementPage.tsx'),
    'utf8',
  );

  assert.match(typeSource, /FaqIndexStatus/, 'client types should include FAQ index status');
  assert.match(apiSource, /getFaqIndexStatus/, 'admin API client should fetch FAQ index status');
  assert.match(apiSource, /rebuildFaqIndex/, 'admin API client should rebuild the FAQ index');
  assert.match(pageSource, /indexStatus/, 'FAQ management page should render index status');
  assert.match(pageSource, /handleRebuildIndex/, 'FAQ management page should provide a rebuild action');
  assert.match(pageSource, /faq\.indexStatus/, 'FAQ index status copy should be translated');
}

function testFaqIndexStatusFetchAvoidsTranslationLoop(): void {
  const pageSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/FaqManagementPage.tsx'),
    'utf8',
  );

  assert.match(
    pageSource,
    /const \{ language, t \} = useTranslation\(\)/,
    'FAQ page should use language as the stable dependency for translated async callbacks',
  );
  assert.match(
    pageSource,
    /fetchIndexStatus[\s\S]+}, \[language\]\);/,
    'FAQ index status fetch should not depend on the unstable per-render t function',
  );
}

function testOpenSourceReadinessArtifactsExist(): void {
  const dockerfilePath = path.resolve(process.cwd(), 'Dockerfile');
  const composePath = path.resolve(process.cwd(), 'docker-compose.yml');
  const dockerignorePath = path.resolve(process.cwd(), '.dockerignore');
  const ciPath = path.resolve(process.cwd(), '.github/workflows/ci.yml');
  const readmeSource = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
  const readmeCnSource = fs.readFileSync(path.resolve(process.cwd(), 'README_CN.md'), 'utf8');

  assert.ok(fs.existsSync(dockerfilePath), 'open-source project should include a Dockerfile');
  assert.ok(fs.existsSync(composePath), 'open-source project should include docker-compose.yml');
  assert.ok(fs.existsSync(dockerignorePath), 'open-source project should include .dockerignore');
  assert.ok(fs.existsSync(ciPath), 'open-source project should include GitHub Actions CI');

  const ciSource = fs.readFileSync(ciPath, 'utf8');
  assert.match(ciSource, /npm ci/, 'CI should install dependencies reproducibly');
  assert.match(ciSource, /EMBED_PROVIDER=other npm test/, 'CI should run regression tests without real embedding calls');
  assert.match(ciSource, /npx playwright install --with-deps chromium/, 'CI should install Playwright Chromium for browser tests');
  assert.match(ciSource, /PLAYWRIGHT_CHANNEL=chromium npm run test:e2e/, 'CI should run Playwright E2E tests');
  assert.match(ciSource, /EMBED_PROVIDER=other npm run build/, 'CI should build the app');
  assert.match(
    fs.readFileSync(composePath, 'utf8'),
    /npm run db:seed/,
    'Docker Compose should seed the default local admin before starting the demo',
  );
  assert.match(readmeSource, /Hybrid (multi-source )?retrieval/, 'README should document hybrid retrieval');
  assert.match(readmeSource, /Docker/, 'README should document Docker usage');
  assert.match(readmeCnSource, /混合检索/, 'Chinese README should document hybrid retrieval');
  assert.match(readmeCnSource, /Docker/, 'Chinese README should document Docker usage');
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
  assert.match(preferencesSource, /classList\.toggle\('dark'/, 'theme should apply TDesign dark class');
  assert.match(preferencesSource, /setAttribute\('theme-mode'/, 'theme should apply TDesign theme-mode attribute');
  assert.match(preferencesSource, /document\.documentElement\.lang/, 'language should apply to the html lang attribute');
}

function testLoginRateLimitIsConfigurableForAutomation(): void {
  const configSource = fs.readFileSync(path.resolve(process.cwd(), 'server/config.ts'), 'utf8');
  const rateLimitSource = fs.readFileSync(path.resolve(process.cwd(), 'server/middleware/rateLimit.ts'), 'utf8');
  const playwrightSource = fs.readFileSync(path.resolve(process.cwd(), 'playwright.config.ts'), 'utf8');

  assert.match(configSource, /RATE_LIMIT_LOGIN/, 'login rate limit should be configurable');
  assert.match(rateLimitSource, /max: config\.rateLimit\.login/, 'login limiter should read from config');
  assert.match(playwrightSource, /RATE_LIMIT_LOGIN: '500'/, 'E2E should raise login rate limit to avoid test cross-talk');
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

function testTDesignGlobalLocaleIsConfigured(): void {
  const appSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/App.tsx'), 'utf8');

  assert.match(appSource, /ConfigProvider/, 'app should wrap routes in TDesign ConfigProvider');
  assert.match(appSource, /tdesign-react\/es\/locale\/zh_CN/, 'app should import the Chinese TDesign locale');
  assert.match(appSource, /tdesign-react\/es\/locale\/en_US/, 'app should import the English TDesign locale');
  assert.match(appSource, /globalConfig=\{globalConfig\}/, 'ConfigProvider should receive the active TDesign locale');
}

function testUiPolishSharedLayoutClassesExist(): void {
  const cssSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/index.css'), 'utf8');

  for (const className of [
    '.app-admin-layout',
    '.app-admin-sidebar',
    '.app-admin-header',
    '.app-content',
    '.app-page-container',
    '.app-page-header',
    '.app-toolbar-card',
    '.app-toolbar-actions',
    '.app-index-status',
    '.app-table-card',
    '.app-chat-layout',
    '.app-chat-sidebar',
    '.app-chat-shell',
    '.app-chat-empty',
    '.app-chat-input-dock',
    '.app-login-shell',
    '.app-login-card',
  ]) {
    assert.match(cssSource, new RegExp(className.replace('.', '\\.')), `${className} should exist in global UI CSS`);
  }

  assert.match(cssSource, /@media \(max-width: 768px\)/, 'UI polish should include narrow-screen rules');
  assert.match(cssSource, /app-admin-layout\s*\{[\s\S]*flex-direction: column/, 'narrow admin layout should stack vertically');
  assert.match(cssSource, /app-admin-sidebar\s*\{[\s\S]*width: 100% !important/, 'narrow admin navigation should not keep desktop sidebar width');
  assert.match(cssSource, /app-table-card \.t-card__body\s*\{[\s\S]*overflow-x: auto/, 'tables should scroll horizontally on narrow screens');
  assert.match(cssSource, /--app-radius/, 'UI polish should define shared radius tokens');
  assert.match(cssSource, /--app-focus-ring/, 'UI polish should define a shared focus ring token');
}

function testAdminPagesUseSharedLayoutClasses(): void {
  const sources = [
    'client/src/pages/admin/DashboardPage.tsx',
    'client/src/pages/admin/ConversationsPage.tsx',
    'client/src/pages/admin/FaqManagementPage.tsx',
    'client/src/pages/admin/ModelConfigPage.tsx',
  ].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));

  for (const source of sources) {
    assert.match(source, /app-page-container/, 'admin pages should use the shared page container');
    assert.match(source, /app-page-header/, 'admin pages should use the shared page header');
  }

  assert.match(
    fs.readFileSync(path.resolve(process.cwd(), 'client/src/pages/admin/AdminLayout.tsx'), 'utf8'),
    /app-admin-layout/,
    'admin layout should use shared shell classes',
  );

  const conversationsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/ConversationsPage.tsx'),
    'utf8',
  );
  const faqSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/admin/FaqManagementPage.tsx'),
    'utf8',
  );
  assert.doesNotMatch(conversationsSource, /<Space direction="horizontal"[^>]*app-toolbar-row/, 'conversation toolbar should use native flex layout');
  assert.doesNotMatch(faqSource, /<Space direction="horizontal"[^>]*app-toolbar-row/, 'FAQ toolbar should use native flex layout');
  assert.match(faqSource, /app-index-status/, 'FAQ index status should use a stable responsive class');
}

function testChatAndLoginUseSharedUiPolishClasses(): void {
  const chatSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/pages/ChatPage.tsx'), 'utf8');
  const bubbleSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/components/chat/ChatBubble.tsx'), 'utf8');
  const inputSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/components/chat/ChatInput.tsx'), 'utf8');
  const loginSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/pages/LoginPage.tsx'), 'utf8');

  assert.match(chatSource, /app-chat-shell/, 'chat page should use the shared chat shell');
  assert.match(chatSource, /app-chat-sidebar/, 'chat page should use a left-side history sidebar');
  assert.match(chatSource, /app-chat-empty/, 'chat page should use the shared chat empty state');
  assert.doesNotMatch(chatSource, /💬/, 'chat empty state should use an icon component instead of emoji decoration');
  assert.match(bubbleSource, /app-chat-bubble/, 'chat bubbles should use shared bubble classes');
  assert.match(inputSource, /app-chat-input-dock/, 'chat input should use the shared input dock');
  assert.match(loginSource, /app-login-shell/, 'login page should use the shared login shell');
  assert.match(loginSource, /app-login-card/, 'login page should use the shared login card');
}

function testFrontendCopyUsesEditableDictionary(): void {
  const dictionaryPath = path.resolve(process.cwd(), 'client/src/i18n/dictionary.json');
  const i18nSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/i18n.ts'), 'utf8');
  const dictionary = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8')) as Record<string, Record<string, string>>;

  assert.ok(fs.existsSync(dictionaryPath), 'frontend copy should live in an editable dictionary file');
  assert.match(i18nSource, /dictionary\.json/, 'i18n module should read from the dictionary file');
  assert.doesNotMatch(i18nSource, /const TRANSLATIONS/, 'i18n module should not keep fixed copy in a TypeScript object');

  for (const key of [
    'chat.title',
    'chat.history',
    'chat.historyMessageCount',
    'chat.faqQuestionPrefix',
    'chat.requestFailed',
    'faq.created',
    'faq.debugTitle',
    'config.saved',
  ]) {
    assert.ok(dictionary[key], `dictionary should contain ${key}`);
    assert.equal(typeof dictionary[key].zh, 'string', `${key} should have Chinese copy`);
    assert.equal(typeof dictionary[key].en, 'string', `${key} should have English copy`);
  }
}

function testLocalFallbackAndDirectFaqAnswerExist(): void {
  const llmSource = fs.readFileSync(path.resolve(process.cwd(), 'server/ai/llm-client.ts'), 'utf8');
  const chatRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');

  assert.match(llmSource, /class LocalFallbackClientImpl/, 'LLM client should provide a local fallback implementation');
  assert.match(llmSource, /hashEmbedding/, 'local fallback should provide deterministic embeddings');
  assert.match(llmSource, /resolveClientMode/, 'LLM client should choose local mode when no API key is configured');
  assert.match(llmSource, /config\.llm\.apiKey \? 'openai' : 'local'/, 'missing LLM key should select local fallback mode');

  assert.match(chatRouteSource, /findDirectFaqAnswer/, 'chat route should detect high-confidence FAQ matches');
  assert.match(chatRouteSource, /source: m\.source/, 'FAQ SSE payload should preserve match source metadata');
  assert.match(chatRouteSource, /vectorScore: m\.vectorScore/, 'FAQ SSE payload should preserve vector score metadata');
  assert.match(chatRouteSource, /keywordScore: m\.keywordScore/, 'FAQ SSE payload should preserve keyword score metadata');
  assert.match(chatRouteSource, /Chat interaction completed with direct FAQ answer/, 'chat route should short-circuit exact FAQ answers');
}

function testChatHistoryApiIsScopedToAnonymousUser(): void {
  const chatRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
  const conversationSource = fs.readFileSync(path.resolve(process.cwd(), 'server/services/conversation.service.ts'), 'utf8');
  const sessionRepoSource = fs.readFileSync(path.resolve(process.cwd(), 'server/db/repos/session.repo.ts'), 'utf8');

  assert.match(chatRouteSource, /router\.get\('\/sessions'/, 'chat route should expose a public history list endpoint');
  assert.match(chatRouteSource, /router\.get\('\/sessions\/:sessionId'/, 'chat route should expose a public history detail endpoint');
  assert.match(chatRouteSource, /userIdent: z\.string\(\)\.min/, 'history endpoints should require an anonymous user identifier');
  assert.match(conversationSource, /getUserConversationDetail/, 'conversation service should expose user-scoped history detail');
  assert.match(conversationSource, /session\.userIdent !== userIdent/, 'history detail should reject sessions owned by other anonymous users');
  assert.match(sessionRepoSource, /listByUserIdent/, 'session repo should list sessions by anonymous user id');
  assert.match(sessionRepoSource, /touch\(id: string\)/, 'sessions should update their timestamp when new messages arrive');
}

function testChatPageExposesHistoryUi(): void {
  const chatPageSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/pages/ChatPage.tsx'), 'utf8');
  const chatApiSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/api/chat.ts'), 'utf8');
  const cssSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/index.css'), 'utf8');

  assert.match(chatApiSource, /localStorage\.getItem\('anonymous_user_id'\)/, 'anonymous id should persist across refreshes for history');
  assert.match(chatApiSource, /getChatHistory/, 'chat API client should fetch chat history');
  assert.match(chatApiSource, /getChatHistoryDetail/, 'chat API client should fetch chat history details');
  assert.doesNotMatch(chatPageSource, /Drawer/, 'chat page should not keep history behind a drawer on desktop');
  assert.match(chatPageSource, /app-chat-sidebar/, 'chat page should render history in a left sidebar');
  assert.match(chatPageSource, /chat\.historyTitle/, 'chat page should use translated history copy');
  assert.match(chatPageSource, /loadHistory\(detail\)/, 'chat page should load a selected historical session into the chat store');
  assert.match(cssSource, /\.app-chat-history-list/, 'chat history UI should have stable styling classes');
  assert.match(cssSource, /\.app-chat-history-item--active/, 'chat history should visually mark the active session');
  assert.match(cssSource, /app-chat-layout\s*\{[\s\S]*flex-direction: column/, 'narrow chat layout should stack sidebar above chat');
}

function testBilingualReadmeExists(): void {
  const readmeSource = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');

  assert.match(readmeSource, /# Smart Customer Service AI/, 'README should include an English title');
  assert.match(readmeSource, /## English/, 'README should include an English section');
  assert.match(readmeSource, /## 中文/, 'README should include a Chinese section');
  assert.match(readmeSource, /中英文切换/, 'README should document Chinese-language features');
  assert.match(readmeSource, /Language switching/, 'README should document English-language features');
}

function testEndToEndAutomationArtifactsExist(): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  const playwrightConfigPath = path.resolve(process.cwd(), 'playwright.config.ts');
  const setupPath = path.resolve(process.cwd(), 'tests/e2e/setup-e2e-db.ts');
  const apiSpecPath = path.resolve(process.cwd(), 'tests/e2e/api.spec.ts');
  const webSpecPath = path.resolve(process.cwd(), 'tests/e2e/web.spec.ts');

  assert.ok(packageJson.devDependencies?.['@playwright/test'], 'Playwright test runner should be a dev dependency');
  assert.equal(packageJson.scripts?.['test:e2e'], 'playwright test', 'package.json should expose E2E test script');
  assert.ok(packageJson.scripts?.['test:e2e:dev-server']?.includes('setup-e2e-db.ts'), 'E2E server should reset and seed its test DB');
  assert.ok(fs.existsSync(playwrightConfigPath), 'Playwright config should exist');
  assert.ok(fs.existsSync(setupPath), 'E2E DB setup should exist');
  assert.ok(fs.existsSync(apiSpecPath), 'API E2E spec should exist');
  assert.ok(fs.existsSync(webSpecPath), 'Web E2E spec should exist');

  const configSource = fs.readFileSync(playwrightConfigPath, 'utf8');
  const apiSpecSource = fs.readFileSync(apiSpecPath, 'utf8');
  const webSpecSource = fs.readFileSync(webSpecPath, 'utf8');

  assert.match(configSource, /E2E_API_PORT/, 'E2E should use isolated API port configuration');
  assert.match(configSource, /E2E_WEB_PORT/, 'E2E should use isolated web port configuration');
  assert.match(configSource, /DB_PATH: '.\/data\/e2e-test\.db'/, 'E2E should use an isolated SQLite database');
  assert.match(apiSpecSource, /missing\/wrong credentials/, 'API E2E should cover auth exception cases');
  assert.match(apiSpecSource, /wildcard escaping/, 'API E2E should cover LIKE wildcard escaping');
  assert.match(apiSpecSource, /invalid limits/, 'API E2E should cover query limit boundaries');
  assert.match(apiSpecSource, /enforces history ownership/, 'API E2E should cover user-scoped history protection');
  assert.match(webSpecSource, /left-side history/, 'Web E2E should cover the left-side history workflow');
  assert.match(webSpecSource, /language and theme toggles/, 'Web E2E should cover preference switching');
  assert.match(webSpecSource, /login rejects wrong password/, 'Web E2E should cover visible login failure');
  assert.match(webSpecSource, /rebuild action/, 'Web E2E should cover the FAQ index rebuild entry point');
  assert.match(apiSpecSource, /debug search requires valid input/, 'API E2E should cover FAQ debug search');
  assert.match(webSpecSource, /faq-debug-panel/, 'Web E2E should cover the FAQ debug panel');
}

function testRetrievalEvaluationAndDebuggingArtifactsExist(): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const evalCasesPath = path.resolve(process.cwd(), 'eval/faq-cases.json');
  const evalScriptPath = path.resolve(process.cwd(), 'server/eval/faq-eval.ts');
  const documentEvalCasesPath = path.resolve(process.cwd(), 'eval/document-cases.json');
  const documentEvalScriptPath = path.resolve(process.cwd(), 'server/eval/document-eval.ts');
  const semanticSource = fs.readFileSync(path.resolve(process.cwd(), 'server/ai/semantic-search.ts'), 'utf8');
  const faqRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/admin/faq.ts'), 'utf8');
  const faqPageSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/pages/admin/FaqManagementPage.tsx'), 'utf8');

  assert.equal(packageJson.scripts?.['eval:faq'], 'tsx server/eval/faq-eval.ts', 'package.json should expose FAQ retrieval evaluation');
  assert.ok(fs.existsSync(evalCasesPath), 'FAQ retrieval evaluation cases should exist');
  assert.ok(fs.existsSync(evalScriptPath), 'FAQ retrieval evaluation script should exist');
  assert.equal(packageJson.scripts?.['eval:document'], 'tsx server/eval/document-eval.ts', 'package.json should expose document retrieval evaluation');
  assert.ok(fs.existsSync(documentEvalCasesPath), 'document retrieval evaluation cases should exist');
  assert.ok(fs.existsSync(documentEvalScriptPath), 'document retrieval evaluation script should exist');

  const evalCases = JSON.parse(fs.readFileSync(evalCasesPath, 'utf8')) as Array<Record<string, unknown>>;
  assert.ok(evalCases.length >= 10, 'FAQ retrieval evaluation should include a useful baseline case set');
  assert.match(fs.readFileSync(evalScriptPath, 'utf8'), /Top1 accuracy/, 'FAQ evaluation should report Top1 accuracy');
  assert.match(fs.readFileSync(evalScriptPath, 'utf8'), /Source distribution/, 'FAQ evaluation should report source distribution');
  const documentEval = JSON.parse(fs.readFileSync(documentEvalCasesPath, 'utf8')) as { cases: unknown[] };
  assert.ok(documentEval.cases.length >= 12, 'document retrieval evaluation should include at least twelve cases');
  assert.match(fs.readFileSync(documentEvalScriptPath, 'utf8'), /semantic-v1/, 'document evaluation should report semantic-v1 metrics');
  assert.match(fs.readFileSync(documentEvalScriptPath, 'utf8'), /structure-baseline/, 'document evaluation should compare the structure-only baseline');

  assert.match(semanticSource, /debugSearch\(/, 'semantic search should expose debug search');
  assert.match(semanticSource, /rankingReason/, 'debug search should explain ranking reasons');
  assert.match(faqRouteSource, /\/search\/debug/, 'admin FAQ routes should expose debug search');
  assert.match(faqRouteSource, /debugSearchSchema/, 'debug search should validate admin input');
  assert.match(faqPageSource, /faq-debug-panel/, 'FAQ management should render a debug panel');
  assert.match(faqPageSource, /debugFaqSearch/, 'FAQ management should call the debug API');
}

function testKnowledgeReviewApiAndChatCompatibility(): void {
  const chatSource = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
  const intentSource = fs.readFileSync(path.resolve(process.cwd(), 'server/services/intent.service.ts'), 'utf8');
  const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'server/routes/admin/knowledge-reviews.ts'),
    'utf8',
  );
  const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');

  assert.match(chatSource, /messageId: z\.string\(\)\.min\(1[^\n]*optional\(\)/, 'rating should accept messageId');
  assert.match(chatSource, /sessionId: z\.string\(\)\.min\(1[^\n]*optional\(\)/, 'legacy session-only rating should remain accepted');
  assert.match(chatSource, /knowledgeReviewService\.recordRating/, 'ratings should update or upsert the matching review');
  assert.match(chatSource, /knowledgeReviewService\.captureChatGap/, 'completed chat answers should evaluate knowledge gaps');
  assert.match(chatSource, /captureKnowledgeGapSafely/, 'knowledge review persistence failures must not leave SSE responses open');
  assert.match(intentSource, /escalationType/, 'intent processing should expose structured escalation type');
  assert.doesNotMatch(chatSource, /reason.*===.*用户明确要求转人工/, 'chat must not infer escalation type from localized reason text');

  const authPos = routeSource.indexOf('router.use(authMiddleware)');
  const adminPos = routeSource.indexOf('router.use(adminOnlyMiddleware)');
  const statsPos = routeSource.indexOf("router.get('/stats'");
  const convertPos = routeSource.indexOf("router.post('/:id/convert'");
  assert.ok(authPos !== -1 && authPos < statsPos, 'knowledge review routes must require auth');
  assert.ok(adminPos !== -1 && adminPos < statsPos, 'knowledge review routes must be admin-only');
  assert.ok(statsPos !== -1 && statsPos < convertPos, 'static stats route must precede parameter routes');
  assert.match(indexSource, /\/api\/admin\/knowledge-reviews/, 'server should mount knowledge review admin routes');
}

async function main(): Promise<void> {
  await testStartupHydratesBeforeSemanticSearch();
  await testExplicitEmbedApiKeySurvivesHydrate();
  testProductionRejectsDefaultAdminPassword();
  testConversationListDoesNotUseMessageNPlusOne();
  testFaqSearchEscapesLikeWildcards();
  testFaqImportUsesBatchEmbedding();
  testVectorStoreContractExists();
  testFaqEmbeddingTextIncludesAnswerAndKeywords();
  testHybridSearchMergesVectorAndKeywordMatches();
  testFaqMatchMetadataCrossesApiTypes();
  testFaqIndexStatusRoutesRequireAdmin();
  testFaqServiceExposesIndexOperations();
  testKnowledgeConversionPreparesIndexBeforeActivation();
  testEmbeddingRefreshDoesNotTouchFaqBusinessTimestamp();
  testFaqManagementExposesIndexControls();
  testFaqIndexStatusFetchAvoidsTranslationLoop();
  testOpenSourceReadinessArtifactsExist();
  testFaqEditHydratesFormAfterDialogMount();
  testPreferencesSupportLanguageAndTheme();
  testLoginRateLimitIsConfigurableForAutomation();
  testUiExposesPreferenceControls();
  testTDesignGlobalLocaleIsConfigured();
  testUiPolishSharedLayoutClassesExist();
  testAdminPagesUseSharedLayoutClasses();
  testChatAndLoginUseSharedUiPolishClasses();
  testFrontendCopyUsesEditableDictionary();
  testLocalFallbackAndDirectFaqAnswerExist();
  testChatHistoryApiIsScopedToAnonymousUser();
  testChatPageExposesHistoryUi();
  testBilingualReadmeExists();
  testEndToEndAutomationArtifactsExist();
  testRetrievalEvaluationAndDebuggingArtifactsExist();
  testKnowledgeReviewApiAndChatCompatibility();
  console.log('Regression checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
