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

testHybridKnowledgeSearchUsesOneQueryEmbedding()
  .then(() => console.log('knowledge retriever tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
