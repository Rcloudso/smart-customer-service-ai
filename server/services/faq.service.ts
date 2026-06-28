import { getDatabase } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqEntry, IntentCategory } from '../types/domain';
import { FaqMatch } from '../types/ai';
import { semanticSearch } from '../ai/semantic-search';
import { PaginationResponse } from '../types/api';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export class FaqService {
  private faqRepo: FaqRepo;

  constructor() {
    const db = getDatabase();
    this.faqRepo = new FaqRepo(db);
  }

  async searchFaq(query: string, limit: number = 5): Promise<FaqMatch[]> {
    return semanticSearch.search(query, limit);
  }

  listFaq(params: {
    category?: IntentCategory;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }): PaginationResponse<FaqEntry> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;

    let items: FaqEntry[];
    let total: number;

    if (params.keyword) {
      // Keyword search: push keyword + category + is_active + pagination down to SQL.
      const cat = params.category ?? null;
      const offset = (page - 1) * pageSize;
      const result = this.faqRepo.searchWithFilters({
        keyword: params.keyword,
        category: cat,
        limit: pageSize,
        offset,
      });
      items = result.items;
      total = result.total;
    } else {
      // Category-only or no filter: use repo-level pagination with COUNT.
      const cat = params.category ?? null;
      total = this.faqRepo.countByCategory(cat);
      const offset = (page - 1) * pageSize;
      items = this.faqRepo.list(cat, pageSize, offset);
    }

    return { items, total, page, pageSize };
  }

  getFaqById(id: string): FaqEntry {
    const entry = this.faqRepo.findById(id);
    if (!entry) {
      throw new NotFoundError('FAQ条目不存在');
    }
    return entry;
  }

  async createFaq(params: {
    question: string;
    answer: string;
    category: IntentCategory;
    keywords: string[];
    updatedBy?: string;
  }): Promise<FaqEntry> {
    const entry = this.faqRepo.create({
      question: params.question,
      answer: params.answer,
      category: params.category,
      keywords: params.keywords,
      updatedBy: params.updatedBy,
    });

    // Update semantic index
    await semanticSearch.updateIndex(entry);

    logger.info({ faqId: entry.id, category: entry.category }, 'FAQ entry created');
    return entry;
  }

  async updateFaq(id: string, params: {
    question?: string;
    answer?: string;
    category?: IntentCategory;
    keywords?: string[];
    isActive?: number;
    updatedBy?: string;
  }): Promise<FaqEntry> {
    const existing = this.faqRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('FAQ条目不存在');
    }

    const updated = this.faqRepo.update(id, params);
    if (!updated) {
      throw new Error('更新FAQ失败');
    }

    // Update semantic index
    await semanticSearch.updateIndex(updated);

    logger.info({ faqId: id }, 'FAQ entry updated');
    return updated;
  }

  deleteFaq(id: string): void {
    const deleted = this.faqRepo.delete(id);
    if (!deleted) {
      throw new NotFoundError('FAQ条目不存在');
    }
    // Remove from index by marking inactive
    const entry = this.faqRepo.findById(id);
    if (entry) {
      semanticSearch.updateIndex({ ...entry, isActive: 0 });
    }
    logger.info({ faqId: id }, 'FAQ entry deleted');
  }

  async importFaq(items: Array<{
    question: string;
    answer: string;
    category: IntentCategory;
    keywords: string[];
  }>, updatedBy?: string): Promise<number> {
    let count = 0;
    const createdEntries: FaqEntry[] = [];
    for (const item of items) {
      try {
        const entry = this.faqRepo.create({
          question: item.question,
          answer: item.answer,
          category: item.category,
          keywords: item.keywords,
          updatedBy,
        });
        createdEntries.push(entry);
        count++;
      } catch (err) {
        logger.warn({ err, question: item.question.slice(0, 30) }, 'Failed to import FAQ item');
      }
    }
    await semanticSearch.updateIndexBatch(createdEntries);
    logger.info({ count, total: items.length }, 'FAQ import completed');
    return count;
  }

  exportFaq(): FaqEntry[] {
    return this.faqRepo.listAllActive();
  }
}

export const faqService = new FaqService();
