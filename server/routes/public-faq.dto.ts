import type { FaqEntry } from '../types/domain';

export type PublicFaqEntry = Pick<
  FaqEntry,
  'id' | 'question' | 'answer' | 'category' | 'keywords'
>;

export function toPublicFaqEntry(entry: FaqEntry): PublicFaqEntry {
  return {
    id: entry.id,
    question: entry.question,
    answer: entry.answer,
    category: entry.category,
    keywords: entry.keywords,
  };
}
