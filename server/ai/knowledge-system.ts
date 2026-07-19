import { getDatabase } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { DocumentKnowledgeAdapter, FaqKnowledgeAdapter } from './knowledge-adapters';
import { KnowledgeIndexItem, KnowledgeRetriever } from './knowledge-retriever';
import { getLLMClient } from './llm-client';
import { InMemoryVectorStore } from './vector-store';

const database = getDatabase();
export const faqKnowledgeAdapter = new FaqKnowledgeAdapter(new FaqRepo(database));
export const documentKnowledgeAdapter = new DocumentKnowledgeAdapter(new DocumentRepo(database));

export const knowledgeRetriever = new KnowledgeRetriever(
  new InMemoryVectorStore<KnowledgeIndexItem>(),
  async (texts) => (await getLLMClient().embed(texts)).map((result) => result.embedding),
  [faqKnowledgeAdapter, documentKnowledgeAdapter],
);
