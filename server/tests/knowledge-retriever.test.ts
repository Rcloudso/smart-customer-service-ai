import assert from 'node:assert/strict';
import { InMemoryVectorStore } from '../ai/vector-store';
import {
  KnowledgeAdapter,
  KnowledgeIndexItem,
  KnowledgeRetriever,
} from '../ai/knowledge-retriever';
import { KnowledgeType, RetrievalResult } from '../types/ai';

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
  testSuccessfulManualRefreshClearsDegradedSource(),
  testRefreshValidationAndApplyFailuresPreserveLastGoodIndex(),
])
  .then(() => console.log('knowledge retriever tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
