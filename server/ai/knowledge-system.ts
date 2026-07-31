import { getDatabase } from '../db';
import { config } from '../config';
import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { DocumentKnowledgeAdapter, FaqKnowledgeAdapter } from './knowledge-adapters';
import { KnowledgeIndexItem, KnowledgeRetriever } from './knowledge-retriever';
import { getLLMClient } from './llm-client';
import { InMemoryVectorStore } from './vector-store';
import { createQdrantVectorStore } from './qdrant-vector-store';

const database = getDatabase();
export const faqKnowledgeAdapter = new FaqKnowledgeAdapter(new FaqRepo(database));
export const documentKnowledgeAdapter = new DocumentKnowledgeAdapter(new DocumentRepo(database));
export const primaryVectorStore = config.vectorStore.provider === 'qdrant'
  ? createQdrantVectorStore({
      url: config.vectorStore.qdrantUrl,
      apiKey: config.vectorStore.qdrantApiKey,
      timeoutMs: config.vectorStore.timeoutMs,
      collectionAlias: config.vectorStore.collectionAlias,
    })
  : new InMemoryVectorStore();

export const knowledgeRetriever = new KnowledgeRetriever(
  primaryVectorStore,
  async (texts) => (await getLLMClient().embed(texts)).map((result) => result.embedding),
  [faqKnowledgeAdapter, documentKnowledgeAdapter],
);
