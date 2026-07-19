import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { InMemoryVectorStore } from '../ai/vector-store';
import {
  KnowledgeAdapter,
  KnowledgeIndexItem,
  KnowledgeRetriever,
} from '../ai/knowledge-retriever';
import { KnowledgeType, RetrievalResult } from '../types/ai';
import { IntentCategory } from '../types/domain';
import mixedKnowledgeFixture from '../../eval/mixed-knowledge-cases.json';
import {
  DocumentKnowledgeAdapter,
  FaqKnowledgeAdapter,
  documentKeywordTerms,
  persistCurrentFaqEmbedding,
} from '../ai/knowledge-adapters';
import {
  DOCUMENT_EMBEDDING_INPUT_VERSION,
  FAQ_EMBEDDING_INPUT_VERSION,
  currentEmbeddingProfile,
} from '../ai/embedding-profile';
import { expandRetrievalQuery } from '../ai/query-expansion';

class FakeAdapter implements KnowledgeAdapter {
  constructor(
    public readonly knowledgeType: KnowledgeType,
    private readonly items: KnowledgeIndexItem[],
    private readonly keywordResults: RetrievalResult[],
  ) {}

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    return this.items;
  }

  searchKeyword(): RetrievalResult[] {
    return this.keywordResults;
  }
}

class FailingLoadAdapter extends FakeAdapter {
  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    throw new Error('embedding provider unavailable');
  }
}

class RecoveringAdapter extends FakeAdapter {
  shouldFail = true;

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    if (this.shouldFail) throw new Error('temporary provider failure');
    return super.loadIndexItems();
  }
}

class MutableAdapter implements KnowledgeAdapter {
  constructor(
    public readonly knowledgeType: KnowledgeType,
    public items: KnowledgeIndexItem[],
  ) {}

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    return this.items;
  }

  searchKeyword(): RetrievalResult[] {
    return [];
  }
}

class ProfiledAdapter extends MutableAdapter {
  profile = 'profile-v1';
  loadCount = 0;

  getEmbeddingProfile(): string {
    return this.profile;
  }

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    this.loadCount += 1;
    return super.loadIndexItems();
  }
}

class FailOnceVectorStore extends InMemoryVectorStore<KnowledgeIndexItem> {
  failOnId: string | null = null;

  upsert(entry: KnowledgeIndexItem, embedding: number[]): void {
    if (entry.id === this.failOnId) {
      this.failOnId = null;
      throw new Error('simulated vector upsert failure');
    }
    super.upsert(entry, embedding);
  }
}

function deterministicTextEmbedding(text: string, dimensions: number = 64): number[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const vector = Array.from({ length: dimensions }, () => 0);
  const units = [...normalized];
  for (let index = 0; index < units.length; index += 1) {
    for (const size of [1, 2, 3]) {
      const token = units.slice(index, index + size).join('');
      if (token.length < size) continue;
      let hash = 2166136261;
      for (const character of token) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
      }
      vector[(hash >>> 0) % dimensions] += 1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function testHybridKnowledgeSearchUsesOneQueryEmbedding(): Promise<void> {
  let embedCalls = 0;
  const faqResult: RetrievalResult = {
    knowledgeType: 'faq', knowledgeId: 'f1', title: '退款', content: 'FAQ answer', similarity: 0,
  };
  const documentResult: RetrievalResult = {
    knowledgeType: 'document', knowledgeId: 'c1', documentId: 'd1', title: '退款政策.md',
    content: '七天内可以退款', similarity: 0, chunkIndex: 0,
  };
  const faq = new FakeAdapter('faq', [{ id: 'faq:f1', result: faqResult, embedding: [0.7, 0.7] }], []);
  const documents = new FakeAdapter(
    'document',
    [{ id: 'document:c1', result: documentResult, embedding: [1, 0] }],
    [{ ...documentResult, similarity: 0.95, source: 'keyword', keywordScore: 0.95 }],
  );
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => {
      embedCalls += 1;
      return [[1, 0]];
    },
    [faq, documents],
  );

  const results = await retriever.search('七天退款', 5);

  assert.equal(embedCalls, 1);
  assert.equal(results[0].knowledgeType, 'document');
  assert.equal(results[0].source, 'hybrid');
  assert.equal(results[0].knowledgeId, 'c1');
  assert.equal(results[0].keywordRank, 1);
  assert.ok((results[0].fusionScore ?? 0) > 0);
  assert.ok(results.some((result) => result.knowledgeType === 'faq'));

  await retriever.refreshSource('faq');
  const afterFaqRefresh = await retriever.search('七天退款', 5);
  assert.ok(afterFaqRefresh.some((result) => result.knowledgeType === 'document'));
}

async function testAdapterFailureKeepsKeywordFallbackAndTypeIsolation(): Promise<void> {
  const keywordDocument: RetrievalResult = {
    knowledgeType: 'document', knowledgeId: 'keyword-chunk', documentId: 'document-1',
    title: 'policy.md', content: '关键词仍可用', similarity: 0.95, source: 'keyword', keywordScore: 0.95,
  };
  const failing = new FailingLoadAdapter('document', [], [keywordDocument]);
  const fallbackRetriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [failing],
  );
  const fallback = await fallbackRetriever.search('关键词', 3, ['document']);
  assert.equal(fallback[0].knowledgeId, 'keyword-chunk');
  assert.equal(fallback[0].source, 'keyword');
  assert.deepEqual(fallbackRetriever.getFailedSources(), ['document']);

  const faqResult: RetrievalResult = {
    knowledgeType: 'faq', knowledgeId: 'faq-low', title: 'FAQ', content: 'answer', similarity: 0,
  };
  const documentItems: KnowledgeIndexItem[] = Array.from({ length: 30 }, (_, index) => ({
    id: `document:high-${index}`,
    result: {
      knowledgeType: 'document', knowledgeId: `high-${index}`, documentId: `document-${index}`,
      title: `doc-${index}`, content: 'document', similarity: 0,
    },
    embedding: [1, 0],
  }));
  const faqAdapter = new FakeAdapter('faq', [{ id: 'faq:faq-low', result: faqResult, embedding: [0, 1] }], []);
  const documentAdapter = new FakeAdapter('document', documentItems, []);
  const isolatedRetriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [faqAdapter, documentAdapter],
  );
  const faqOnly = await isolatedRetriever.search('FAQ only', 1, ['faq']);
  assert.equal(faqOnly[0].knowledgeId, 'faq-low', 'document vectors must not displace FAQ-only candidates');
}

async function testExactFaqCannotBeDisplacedByDocumentCandidates(): Promise<void> {
  const exactFaq: RetrievalResult = {
    knowledgeType: 'faq', knowledgeId: 'exact-faq', title: '如何退款', content: '七天内可退款',
    similarity: 0.95, source: 'keyword', keywordScore: 0.95,
  };
  const documents = Array.from({ length: 8 }, (_, index): KnowledgeIndexItem => ({
    id: `document:high-${index}`,
    result: {
      knowledgeType: 'document', knowledgeId: `high-${index}`, documentId: `doc-${index}`,
      title: `document-${index}`, content: 'document answer', similarity: 0,
    },
    embedding: [1, 0],
  }));
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [
      new FakeAdapter('faq', [], [exactFaq]),
      new FakeAdapter('document', documents, []),
    ],
  );

  const results = await retriever.search('如何退款', 5);
  assert.equal(results.length, 5);
  assert.equal(results[0].knowledgeId, 'exact-faq');
  assert.ok(results.some((result) => result.knowledgeId === 'exact-faq'));
}

async function testMixedSearchKeepsRelevantDocumentCandidate(): Promise<void> {
  const faqItems = Array.from({ length: 5 }, (_, index): KnowledgeIndexItem => ({
    id: `faq:faq-${index}`,
    result: {
      knowledgeType: 'faq',
      knowledgeId: `faq-${index}`,
      title: `售后 FAQ ${index}`,
      content: '售后答案',
      similarity: 0,
    },
    embedding: [0.69 - index * 0.002, Math.sqrt(1 - (0.69 - index * 0.002) ** 2)],
  }));
  const documentResult: RetrievalResult = {
    knowledgeType: 'document',
    knowledgeId: 'compensation-chunk',
    documentId: 'compensation-document',
    title: '公司薪酬制度.pdf',
    content: '公司福利与职员薪资说明',
    similarity: 0,
    chunkIndex: 1,
  };
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [
      new FakeAdapter('faq', faqItems, []),
      new FakeAdapter('document', [{
        id: 'document:compensation-chunk',
        result: documentResult,
        embedding: [0.63, Math.sqrt(1 - 0.63 ** 2)],
      }], []),
    ],
  );

  const results = await retriever.search('公司福利待遇如何', 5);

  assert.equal(results.length, 5);
  assert.ok(
    results.some((result) => result.knowledgeId === 'compensation-chunk'),
    'a relevant document must not be crowded out by FAQ vectors before global ranking',
  );
}

function testDocumentKeywordTermsRemoveQuestionNoise(): void {
  const terms = documentKeywordTerms('你们的主营业务是什么？');
  assert.ok(terms.includes('主营'));
  assert.ok(terms.includes('业务'));
  assert.equal(terms.includes('你们'), false);
  assert.equal(terms.includes('什么'), false);
  assert.ok(terms.length <= 24);
  const gpuTerms = documentKeywordTerms('GPU型号有哪些');
  assert.ok(gpuTerms.includes('gpu'));
  assert.ok(gpuTerms.includes('型号'));
  assert.equal(gpuTerms.includes('gp'), false);
  assert.equal(gpuTerms.includes('pu'), false);
  assert.equal(gpuTerms.includes('哪些'), false);
}

function testGpuQueryExpansionIsDeterministic(): void {
  assert.equal(
    expandRetrievalQuery('GPU型号有哪些'),
    'GPU型号有哪些 显卡 型号 清单 产品',
  );
  assert.equal(
    expandRetrievalQuery('有什么显卡'),
    '有什么显卡 GPU 型号 清单 产品',
  );
  assert.equal(expandRetrievalQuery('如何申请退款？'), '如何申请退款？');
}

async function testGpuCatalogueWinsRealMixedRetrieval(): Promise<void> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const faqRepo = new FaqRepo(db);
  const documentRepo = new DocumentRepo(db);
  for (const faq of mixedKnowledgeFixture.faqs) {
    faqRepo.create({
      ...faq,
      category: IntentCategory.GENERAL,
      embedding: [1, 0, 0],
      embeddingProfile: 'stale-faq-profile',
    });
  }

  const createDocument = (
    id: string,
    fileName: string,
    content: string,
    sectionTitle: string,
  ): void => {
    documentRepo.createPending({
      id,
      fileName,
      storagePath: `${id}.md`,
      format: 'md',
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(content),
      sha256: `${id}-sha`,
      uploadedBy: 'test-admin',
    });
    documentRepo.replaceChunksAndMarkReady(id, [{
      chunkIndex: 0,
      content,
      title: sectionTitle,
      pageStart: null,
      pageEnd: null,
      characterCount: content.length,
      embedding: [1, 0, 0],
      embeddingProfile: 'stale-document-profile',
    }], content.length);
  };

  for (const document of mixedKnowledgeFixture.documents) {
    createDocument(document.id, document.title, document.content, document.sectionTitle);
  }

  const embedTexts = async (texts: string[]): Promise<number[][]> => (
    texts.map((text) => deterministicTextEmbedding(text))
  );

  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    embedTexts,
    [
      new FaqKnowledgeAdapter(faqRepo, embedTexts),
      new DocumentKnowledgeAdapter(documentRepo, embedTexts),
    ],
  );

  try {
    for (const testCase of mixedKnowledgeFixture.cases) {
      const results = await retriever.search(testCase.query, 3);
      assert.equal(
        results[0]?.title,
        testCase.expectedTitle,
        `${testCase.id} must rank the expected mixed-knowledge result first`,
      );
      assert.ok((results[0]?.fusionScore ?? 0) > 0);
    }
    if (process.env.REPORT_MIXED_EVAL === '1') {
      console.log(`Mixed knowledge evaluation: ${mixedKnowledgeFixture.cases.length}/${mixedKnowledgeFixture.cases.length} Top1`);
    }
    assert.equal(
      faqRepo.listAllActive()[0].embeddingProfile,
      currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION),
    );
    assert.ok(documentRepo.listAllActiveKnowledgeChunks().every((chunk) => (
      chunk.embeddingProfile === currentEmbeddingProfile(DOCUMENT_EMBEDDING_INPUT_VERSION)
    )));
  } finally {
    db.close();
  }
}

async function testStaleEmbeddingRefreshIsAtomic(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = new FaqRepo(db);
  const original = repo.create({
    question: '旧向量不能被部分覆盖',
    answer: '保留最后一份完整索引。',
    category: IntentCategory.GENERAL,
    keywords: ['原子'],
    embedding: [1, 0],
    embeddingProfile: 'old-profile',
  });
  const adapter = new FaqKnowledgeAdapter(repo, async () => {
    throw new Error('provider unavailable');
  });

  try {
    await assert.rejects(adapter.loadIndexItems(), /provider unavailable/);
    const preserved = repo.findById(original.id);
    assert.deepEqual(preserved?.embedding, [1, 0]);
    assert.equal(preserved?.embeddingProfile, 'old-profile');
  } finally {
    db.close();
  }
}

async function testStaleFaqRefreshCannotOverwriteConcurrentEdit(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = new FaqRepo(db);
  const original = repo.create({
    question: '旧问题',
    answer: '旧回答',
    category: IntentCategory.GENERAL,
    keywords: ['旧'],
    embedding: [1, 0],
    embeddingProfile: 'old-profile',
  });
  const currentProfile = currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION);
  const adapter = new FaqKnowledgeAdapter(repo, async () => {
    db.prepare(`
      UPDATE faq_entries
      SET question = ?, embedding = ?, embedding_profile = ?, updated_at = ?
      WHERE id = ?
    `).run(
      '并发更新后的问题',
      JSON.stringify([0, 1]),
      currentProfile,
      '2099-01-01T00:00:00.000Z',
      original.id,
    );
    return [[0.5, 0.5]];
  });

  try {
    await assert.rejects(
      adapter.loadIndexItems(),
      /FAQ changed while its embedding was being generated/,
    );
    const preserved = repo.findById(original.id);
    assert.equal(preserved?.question, '并发更新后的问题');
    assert.deepEqual(preserved?.embedding, [0, 1]);
    assert.equal(preserved?.embeddingProfile, currentProfile);
  } finally {
    db.close();
  }
}

async function testSingleFaqRefreshPublishesOnlyLatestConcurrentEdit(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = new FaqRepo(db);
  const original = repo.create({
    question: '并发编辑前的问题',
    answer: '旧回答',
    category: IntentCategory.GENERAL,
    keywords: ['旧'],
    embedding: null,
    embeddingProfile: null,
  });
  const currentProfile = currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION);
  let prepareCount = 0;

  try {
    const resolved = await persistCurrentFaqEmbedding(original, repo, async (entry) => {
      prepareCount += 1;
      if (prepareCount === 1) {
        db.prepare(`
          UPDATE faq_entries
          SET question = ?, embedding = ?, embedding_profile = ?, updated_at = ?
          WHERE id = ?
        `).run(
          '并发编辑后的最新问题',
          JSON.stringify([0, 1]),
          currentProfile,
          '2099-01-01T00:00:00.000Z',
          original.id,
        );
      }
      return {
        embedding: entry.question === original.question ? [1, 0] : [0, 1],
        embeddingProfile: currentProfile,
      };
    });

    assert.equal(prepareCount, 1);
    assert.equal(resolved?.question, '并发编辑后的最新问题');
    assert.deepEqual(resolved?.embedding, [0, 1]);
    assert.equal(resolved?.embeddingProfile, currentProfile);
    assert.equal(repo.findById(original.id)?.question, '并发编辑后的最新问题');
  } finally {
    db.close();
  }
}

async function testRuntimeProfileChangeRefreshesSourceBeforeSearch(): Promise<void> {
  const result: RetrievalResult = {
    knowledgeType: 'faq',
    knowledgeId: 'profiled',
    title: 'Profiled FAQ',
    content: 'answer',
    similarity: 0,
  };
  const adapter = new ProfiledAdapter('faq', [{
    id: 'faq:profiled',
    result,
    embedding: [1, 0],
  }]);
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [adapter],
  );
  await retriever.initialize();
  assert.equal(adapter.loadCount, 1);
  adapter.profile = 'profile-v2';
  await retriever.search('refresh', 1);
  assert.equal(adapter.loadCount, 2);
}

async function testConcurrentInitializationIsSingleFlight(): Promise<void> {
  const result: RetrievalResult = {
    knowledgeType: 'faq',
    knowledgeId: 'single-flight',
    title: 'Single flight',
    content: 'answer',
    similarity: 0,
  };
  const adapter = new ProfiledAdapter('faq', [{
    id: 'faq:single-flight',
    result,
    embedding: [1, 0],
  }]);
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [adapter],
  );

  await Promise.all([
    retriever.initialize(),
    retriever.initialize(),
    retriever.search('single flight', 1),
  ]);

  assert.equal(adapter.loadCount, 1, 'concurrent requests must share one source initialization');
}

async function testVectorPublishFailureRestoresPersistedEmbeddingProfile(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = new FaqRepo(db);
  const original = repo.create({
    question: '索引发布失败如何处理',
    answer: '保留旧向量。',
    category: IntentCategory.GENERAL,
    keywords: ['回滚'],
    embedding: [1, 0],
    embeddingProfile: 'old-profile',
  });
  const store = new FailOnceVectorStore();
  store.failOnId = `faq:${original.id}`;
  const retriever = new KnowledgeRetriever(
    store,
    async () => [[0, 1]],
    [new FaqKnowledgeAdapter(repo, async () => [[0, 1]])],
  );

  try {
    await retriever.initialize();
    const preserved = repo.findById(original.id);
    assert.deepEqual(preserved?.embedding, [1, 0]);
    assert.equal(preserved?.embeddingProfile, 'old-profile');
    assert.deepEqual(retriever.getFailedSources(), ['faq']);
  } finally {
    db.close();
  }
}

function testEmbeddingProfileMigrationIsAdditive(): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE faq_entries (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      embedding TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )
  `);
  initSchema(db);
  const columns = db.prepare('PRAGMA table_info(faq_entries)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'embedding_profile'));
  db.close();
}

async function testSuccessfulManualRefreshClearsDegradedSource(): Promise<void> {
  const result: RetrievalResult = {
    knowledgeType: 'faq', knowledgeId: 'recovered', title: 'Recovered FAQ', content: 'answer', similarity: 0,
  };
  const adapter = new RecoveringAdapter(
    'faq',
    [{ id: 'faq:recovered', result, embedding: [1, 0] }],
    [],
  );
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    async () => [[1, 0]],
    [adapter],
  );

  await retriever.initialize();
  assert.deepEqual(retriever.getFailedSources(), ['faq']);
  adapter.shouldFail = false;
  await retriever.refreshSource('faq');
  assert.deepEqual(retriever.getFailedSources(), []);
  assert.equal(retriever.getIndexedCount('faq'), 1);
  adapter.shouldFail = true;
  await assert.rejects(retriever.refreshSource('faq'), /temporary provider failure/);
  assert.deepEqual(retriever.getFailedSources(), ['faq']);
  assert.equal(retriever.getIndexedCount('faq'), 1, 'failed refresh must preserve the last good index');
}

async function testRefreshValidationAndApplyFailuresPreserveLastGoodIndex(): Promise<void> {
  const oldResult: RetrievalResult = {
    knowledgeType: 'faq', knowledgeId: 'old', title: 'Old FAQ', content: 'old answer', similarity: 0,
  };
  const adapter = new MutableAdapter('faq', [
    { id: 'faq:old', result: oldResult, embedding: [1, 0] },
  ]);
  const store = new FailOnceVectorStore();
  const retriever = new KnowledgeRetriever(store, async () => [[1, 0]], [adapter]);
  await retriever.initialize();

  adapter.items = [{ id: 'document:wrong', result: oldResult, embedding: [1, 0] }];
  await assert.rejects(retriever.refreshSource('faq'), /namespace/);
  assert.deepEqual(retriever.getFailedSources(), ['faq']);
  assert.equal((await retriever.search('old', 1, ['faq']))[0].knowledgeId, 'old');

  adapter.items = [{
    id: 'faq:new',
    result: { ...oldResult, knowledgeId: 'new', title: 'New FAQ' },
    embedding: [1, 0],
  }];
  store.failOnId = 'faq:new';
  await assert.rejects(retriever.refreshSource('faq'), /vector upsert failure/);
  assert.equal((await retriever.search('old', 1, ['faq']))[0].knowledgeId, 'old');
  assert.equal(retriever.getIndexedCount('faq'), 1);
}

Promise.all([
  testHybridKnowledgeSearchUsesOneQueryEmbedding(),
  testAdapterFailureKeepsKeywordFallbackAndTypeIsolation(),
  testExactFaqCannotBeDisplacedByDocumentCandidates(),
  testMixedSearchKeepsRelevantDocumentCandidate(),
  testGpuCatalogueWinsRealMixedRetrieval(),
  testStaleEmbeddingRefreshIsAtomic(),
  testStaleFaqRefreshCannotOverwriteConcurrentEdit(),
  testSingleFaqRefreshPublishesOnlyLatestConcurrentEdit(),
  testRuntimeProfileChangeRefreshesSourceBeforeSearch(),
  testConcurrentInitializationIsSingleFlight(),
  testVectorPublishFailureRestoresPersistedEmbeddingProfile(),
  testSuccessfulManualRefreshClearsDegradedSource(),
  testRefreshValidationAndApplyFailuresPreserveLastGoodIndex(),
])
  .then(() => {
    testDocumentKeywordTermsRemoveQuestionNoise();
    testGpuQueryExpansionIsDeterministic();
    testEmbeddingProfileMigrationIsAdditive();
    console.log('knowledge retriever tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
