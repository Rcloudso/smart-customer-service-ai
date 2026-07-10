import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { semanticSearch } from '../ai/semantic-search';
import { FaqRepo } from '../db/repos/faq.repo';
import { KnowledgeReviewRepo } from '../db/repos/knowledge-review.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { FaqMatch } from '../types/ai';
import {
  FaqEntry,
  IntentCategory,
  KnowledgeRetrievalSnapshot,
  KnowledgeReviewItem,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  Message,
  MessageRole,
  SatisfactionRating,
} from '../types/domain';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../utils/errors';

const KNOWLEDGE_GAP_THRESHOLD = 0.55;

type IndexPreparation = (faq: FaqEntry) => Promise<number[] | null | undefined>;
type IndexCommit = (faq: FaqEntry) => void;

export class KnowledgeReviewService {
  private readonly reviewRepo: KnowledgeReviewRepo;
  private readonly messageRepo: MessageRepo;
  private readonly faqRepo: FaqRepo;

  constructor(
    private readonly db: Database.Database = getDatabase(),
    private readonly prepareFaqIndex: IndexPreparation = (faq) => semanticSearch.prepareIndex(faq),
    private readonly commitFaqIndex: IndexCommit = (faq) => semanticSearch.commitPreparedIndex(faq),
  ) {
    this.reviewRepo = new KnowledgeReviewRepo(db);
    this.messageRepo = new MessageRepo(db);
    this.faqRepo = new FaqRepo(db);
  }

  captureChatGap(params: {
    userMessage: Message;
    assistantMessage: Message;
    intent: IntentCategory;
    intentConf: number;
    faqMatches: FaqMatch[];
    escalationType: 'explicit' | 'low_confidence' | null;
  }): KnowledgeReviewItem | null {
    if (params.escalationType === 'explicit') return null;

    const triggerReason = params.faqMatches.length === 0
      ? KnowledgeReviewTriggerReason.NO_MATCH
      : params.faqMatches[0].similarity < KNOWLEDGE_GAP_THRESHOLD
        ? KnowledgeReviewTriggerReason.LOW_RETRIEVAL_SCORE
        : null;
    if (!triggerReason) return null;

    const retrievalSnapshot: KnowledgeRetrievalSnapshot[] = params.faqMatches.slice(0, 3).map((match) => ({
      knowledgeType: 'faq',
      knowledgeId: match.id,
      title: match.question,
      source: match.source,
      similarity: match.similarity,
      keywordScore: match.keywordScore,
      vectorScore: match.vectorScore,
    }));

    return this.reviewRepo.create({
      sessionId: params.userMessage.sessionId,
      userMessageId: params.userMessage.id,
      assistantMessageId: params.assistantMessage.id,
      question: params.userMessage.content,
      answer: params.assistantMessage.content,
      intent: params.intent,
      intentConf: params.intentConf,
      retrievalSnapshot,
      triggerReason,
    });
  }

  recordNegativeFeedback(params: {
    sessionId: string;
    assistantMessageId: string;
    rating: SatisfactionRating;
  }): KnowledgeReviewItem {
    const review = this.recordRating(params);
    if (!review) throw new ValidationError('负反馈未能创建知识审核记录');
    return review;
  }

  recordRating(params: {
    sessionId: string;
    assistantMessageId: string;
    rating: SatisfactionRating;
  }): KnowledgeReviewItem | null {
    const assistant = this.messageRepo.findById(params.assistantMessageId);
    if (!assistant || assistant.role !== MessageRole.ASSISTANT) {
      throw new NotFoundError('可评分的助手消息不存在');
    }
    if (assistant.sessionId !== params.sessionId) {
      throw new ValidationError('messageId 与 sessionId 不匹配');
    }
    const userMessage = this.messageRepo.findPreviousUserMessage(assistant.id);
    if (!userMessage) throw new NotFoundError('找不到对应的用户消息');

    return this.db.transaction(() => {
      this.messageRepo.updateSatisfaction(assistant.id, params.rating);
      const existing = this.reviewRepo.findByUserMessageId(userMessage.id);
      if (existing) {
        return existing.status === KnowledgeReviewStatus.PENDING && params.rating <= 2
          ? this.reviewRepo.updatePendingFeedback(existing.id, params.rating)
          : this.reviewRepo.updateRating(existing.id, params.rating);
      }

      if (params.rating > 2) return null;

      return this.reviewRepo.create({
        sessionId: params.sessionId,
        userMessageId: userMessage.id,
        assistantMessageId: assistant.id,
        question: userMessage.content,
        answer: assistant.content,
        intent: assistant.intent,
        intentConf: assistant.intentConf,
        retrievalSnapshot: assistant.retrievalSnapshot,
        triggerReason: KnowledgeReviewTriggerReason.NEGATIVE_FEEDBACK,
        rating: params.rating,
      });
    })();
  }

  list(params: {
    status?: KnowledgeReviewStatus;
    triggerReason?: KnowledgeReviewTriggerReason;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 20, 100);
    const result = this.reviewRepo.list({
      status: params.status,
      triggerReason: params.triggerReason,
      keyword: params.keyword,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { ...result, page, pageSize };
  }

  getStats() {
    return this.reviewRepo.getStats();
  }

  async convert(id: string, params: {
    question: string;
    answer: string;
    category: IntentCategory;
    keywords: string[];
    updatedBy: string;
  }): Promise<{ review: KnowledgeReviewItem; faq: FaqEntry }> {
    const initial = this.reviewRepo.findById(id);
    if (!initial) throw new NotFoundError('知识审核记录不存在');
    if (initial.status === KnowledgeReviewStatus.DISMISSED) {
      throw new ConflictError('已忽略的知识审核记录不能转换');
    }
    if (initial.status === KnowledgeReviewStatus.CONVERTED && initial.linkedFaqId) {
      const faq = this.faqRepo.findById(initial.linkedFaqId);
      if (!faq) throw new NotFoundError('已关联的 FAQ 不存在');
      return { review: initial, faq };
    }

    const linked = this.db.transaction(() => {
      const current = this.reviewRepo.findById(id) as KnowledgeReviewItem;
      if (current.linkedFaqId) {
        const existingFaq = this.faqRepo.findById(current.linkedFaqId);
        if (!existingFaq) throw new NotFoundError('已关联的 FAQ 不存在');
        return { review: current, faq: existingFaq };
      }
      const faq = this.faqRepo.create({ ...params, isActive: 0 });
      const review = this.reviewRepo.setLinkedFaq(id, faq.id);
      return { review, faq };
    })();

    let embedding: number[] | null | undefined;
    try {
      embedding = await this.prepareFaqIndex(linked.faq);
    } catch {
      throw new ServiceUnavailableError('FAQ索引同步失败，请稍后重试');
    }

    const preparedFaq: FaqEntry = {
      ...linked.faq,
      embedding: embedding ?? null,
      isActive: 1,
    };
    try {
      this.commitFaqIndex(preparedFaq);
    } catch {
      throw new ServiceUnavailableError('FAQ索引同步失败，请稍后重试');
    }

    try {
      return this.db.transaction(() => {
        const current = this.reviewRepo.findById(id);
        if (!current) throw new NotFoundError('知识审核记录不存在');
        if (current.status === KnowledgeReviewStatus.DISMISSED) {
          throw new ConflictError('已忽略的知识审核记录不能转换');
        }
        const faq = this.faqRepo.update(linked.faq.id, {
          embedding: preparedFaq.embedding,
          isActive: 1,
        });
        if (!faq) throw new NotFoundError('已关联的 FAQ 不存在');
        const review = this.reviewRepo.markConverted(id);
        if (review.status !== KnowledgeReviewStatus.CONVERTED) {
          throw new ConflictError('知识审核状态已变化，请刷新后重试');
        }
        return { review, faq };
      })();
    } catch (error) {
      this.commitFaqIndex({ ...preparedFaq, isActive: 0 });
      throw error;
    }
  }

  dismiss(id: string, reason?: string): KnowledgeReviewItem {
    const review = this.reviewRepo.findById(id);
    if (!review) throw new NotFoundError('知识审核记录不存在');
    if (review.status === KnowledgeReviewStatus.CONVERTED) {
      throw new ConflictError('已转换的知识审核记录不能忽略');
    }
    if (review.status === KnowledgeReviewStatus.DISMISSED) return review;
    return this.db.transaction(() => {
      const current = this.reviewRepo.findById(id) as KnowledgeReviewItem;
      if (current.linkedFaqId) {
        const faq = this.faqRepo.findById(current.linkedFaqId);
        if (faq?.isActive) {
          throw new ConflictError('FAQ 已激活，请刷新审核状态');
        }
        this.reviewRepo.clearLinkedFaq(id);
        if (faq) this.faqRepo.delete(faq.id);
      }
      return this.reviewRepo.dismiss(id, reason?.trim() || null);
    })();
  }
}

export const knowledgeReviewService = new KnowledgeReviewService();
