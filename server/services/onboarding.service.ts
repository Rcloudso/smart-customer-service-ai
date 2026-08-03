import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDatabase } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { OnboardingRepo } from '../db/repos/onboarding.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { Document, IntentCategory, MessageRole } from '../types/domain';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../utils/errors';

export const SAMPLE_PACK_VERSION = 'sample-pack-v1';
export const SAMPLE_PACK_ACTOR = 'sample-pack-v1';
export const RECOMMENDED_QUESTIONS = {
  zh: '退货申请需要在几天内提交？',
  en: 'Within how many days must a return request be submitted?',
} as const;

const SAMPLE_FAQS = [
  {
    question: '演示：客服工作时间是什么时候？',
    answer: '演示答案：在线客服每天 09:00–18:00 提供服务。',
    category: IntentCategory.GENERAL,
    keywords: ['演示', '客服', '工作时间'],
  },
  {
    question: 'Demo: What are customer service hours?',
    answer: 'Demo answer: Online support is available daily from 09:00 to 18:00.',
    category: IntentCategory.GENERAL,
    keywords: ['demo', 'support', 'hours'],
  },
  {
    question: '演示：如何查询订单状态？',
    answer: '演示答案：打开“我的订单”，选择订单后查看当前状态。',
    category: IntentCategory.ORDER,
    keywords: ['演示', '订单', '状态'],
  },
  {
    question: 'Demo: How do I check an order status?',
    answer: 'Demo answer: Open My Orders and select the order to see its current status.',
    category: IntentCategory.ORDER,
    keywords: ['demo', 'order', 'status'],
  },
  {
    question: '演示：忘记密码怎么办？',
    answer: '演示答案：在登录页选择“忘记密码”，按提示完成重置。',
    category: IntentCategory.TECHNICAL,
    keywords: ['演示', '密码', '重置'],
  },
  {
    question: 'Demo: What should I do if I forgot my password?',
    answer: 'Demo answer: Choose Forgot password on the sign-in page and follow the reset steps.',
    category: IntentCategory.TECHNICAL,
    keywords: ['demo', 'password', 'reset'],
  },
] as const;

const SAMPLE_DOCUMENT = `# 演示退货政策 / Demo Return Policy

> 这是仅用于首次体验的演示数据，不代表真实商家政策。
> This is demonstration data for onboarding only and is not a real merchant policy.

## 退货申请 / Return requests

退货申请必须在签收之日起 7 天内提交。申请时请提供订单号和退货原因。

A return request must be submitted within 7 days after delivery. Include the order number and return reason.

## 商品状态 / Item condition

商品应保持未使用状态，并保留原包装。演示环境不会执行真实退款。

The item should be unused and retain its original packaging. The demo environment never performs a real refund.
`;

interface OnboardingDependencies {
  updateFaqIndex(entries: ReturnType<FaqRepo['findActiveByIds']>): Promise<void>;
  getDocument(documentId: string): Document;
  uploadDocument(): Promise<Document>;
  retryDocument(documentId: string): Promise<Document>;
}

export class OnboardingService {
  private readonly onboardingRepo: OnboardingRepo;
  private readonly faqRepo: FaqRepo;
  private readonly documentRepo: DocumentRepo;
  private readonly sessionRepo: SessionRepo;
  private readonly messageRepo: MessageRepo;
  private readonly dependencies: OnboardingDependencies;

  constructor(
    private readonly db: Database.Database = getDatabase(),
    dependencies?: Partial<OnboardingDependencies>,
  ) {
    this.onboardingRepo = new OnboardingRepo(db);
    this.faqRepo = new FaqRepo(db);
    this.documentRepo = new DocumentRepo(db);
    this.sessionRepo = new SessionRepo(db);
    this.messageRepo = new MessageRepo(db);
    this.dependencies = {
      updateFaqIndex: (entries) => getSemanticSearch().updateIndexBatch(entries),
      getDocument: (documentId) => getRuntimeDocumentService().get(documentId),
      uploadDocument: () => getRuntimeDocumentService().upload({
        originalName: 'demo-return-policy-bilingual.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(SAMPLE_DOCUMENT, 'utf8'),
        uploadedBy: SAMPLE_PACK_ACTOR,
      }),
      retryDocument: (documentId) => getRuntimeDocumentService().retry(documentId),
      ...dependencies,
    };
  }

  getOverview() {
    const state = this.onboardingRepo.getState();
    const samplePack = this.onboardingRepo.getPack(SAMPLE_PACK_VERSION);
    return {
      ...state,
      shouldAutoRedirect: state.installKind === 'fresh'
        && (state.status === 'not_started' || state.status === 'in_progress'),
      recommendedQuestions: RECOMMENDED_QUESTIONS,
      samplePack,
      readiness: {
        database: 'ready' as const,
        answerMode: config.llm.apiKey ? 'provider_configured' as const : 'deterministic_local' as const,
        externalTelemetry: false,
      },
    };
  }

  start() {
    const state = this.onboardingRepo.getState();
    if (state.status === 'completed') return this.getOverview();
    const runId = state.runId ?? uuidv4();
    this.onboardingRepo.start(runId, new Date().toISOString());
    return this.getOverview();
  }

  assertActiveRun(runId: string): void {
    const state = this.onboardingRepo.getState();
    if (state.status !== 'in_progress' || state.runId !== runId) {
      throw new ValidationError('Invalid or inactive onboarding run');
    }
  }

  async installSamplePack() {
    const state = this.onboardingRepo.getState();
    if (state.status !== 'in_progress' || !state.runId) {
      throw new ConflictError('Start onboarding before loading the sample pack');
    }
    const attemptId = uuidv4();
    const now = new Date().toISOString();
    const claim = this.onboardingRepo.claimPack(SAMPLE_PACK_VERSION, attemptId, now);
    if (claim.installation.status === 'ready') return this.getOverview();
    if (!claim.claimed) throw new ConflictError('Sample pack installation is already in progress');

    try {
      let faqIds = claim.installation.faqIds;
      let faqs = this.faqRepo.findActiveByIds(faqIds);
      if (faqs.length !== SAMPLE_FAQS.length) {
        faqs = this.db.transaction(() => SAMPLE_FAQS.map((faq) => this.faqRepo.create({
          ...faq,
          keywords: [...faq.keywords],
          updatedBy: SAMPLE_PACK_ACTOR,
        })))();
        faqIds = faqs.map((faq) => faq.id);
        this.onboardingRepo.saveFaqIds(SAMPLE_PACK_VERSION, attemptId, faqIds, new Date().toISOString());
      }
      await this.dependencies.updateFaqIndex(faqs);

      let document = await this.resolveSampleDocument(claim.installation.documentId);
      if (document.status === 'failed') {
        document = await this.dependencies.retryDocument(document.id);
      }
      if (document.status !== 'ready') {
        throw new ServiceUnavailableError('Sample document is not ready');
      }
      this.onboardingRepo.saveDocumentId(
        SAMPLE_PACK_VERSION,
        attemptId,
        document.id,
        new Date().toISOString(),
      );
      this.onboardingRepo.markPackReady(
        SAMPLE_PACK_VERSION,
        attemptId,
        new Date().toISOString(),
      );
      this.onboardingRepo.recordSampleLoaded(new Date().toISOString());
      return this.getOverview();
    } catch (error) {
      const failureCode = 'sample_pack_install_failed';
      const failedAt = new Date().toISOString();
      this.onboardingRepo.markPackFailed(SAMPLE_PACK_VERSION, attemptId, failureCode, failedAt);
      this.onboardingRepo.recordFailure(failureCode, failedAt);
      throw error;
    }
  }

  recordGuidedAnswer(params: { sessionId: string; messageId: string }) {
    const state = this.onboardingRepo.getState();
    if (state.status !== 'in_progress' || !state.runId) {
      throw new ConflictError('Onboarding is not in progress');
    }
    const pack = this.onboardingRepo.getPack(SAMPLE_PACK_VERSION);
    if (pack?.status !== 'ready' || !pack.documentId) {
      throw new ConflictError('Sample pack is not ready');
    }
    const session = this.sessionRepo.findById(params.sessionId);
    const message = this.messageRepo.findById(params.messageId);
    if (
      !session
      || session.origin !== 'onboarding'
      || session.onboardingRunId !== state.runId
      || !message
      || message.sessionId !== session.id
      || message.role !== MessageRole.ASSISTANT
    ) {
      throw new NotFoundError('Guided answer was not found for this onboarding run');
    }
    const hasSampleDocument = message.retrievalSnapshot.some(
      (source) => source.knowledgeType === 'document'
        && (source.documentId === pack.documentId || source.knowledgeId === pack.documentId),
    );
    if (
      message.answerMode === 'refusal'
      || message.groundingStatus !== 'sufficient'
      || !hasSampleDocument
    ) {
      throw new ValidationError('Guided answer must be grounded in the sample document');
    }
    this.onboardingRepo.recordFirstAnswer(session.id, message.id, new Date().toISOString());
    return this.getOverview();
  }

  evidenceReviewed(messageId: string) {
    const state = this.onboardingRepo.getState();
    if (!state.firstAnswerMessageId || state.firstAnswerMessageId !== messageId) {
      throw new ValidationError('Review the verified guided answer before completing onboarding');
    }
    this.onboardingRepo.complete(new Date().toISOString());
    return this.getOverview();
  }

  dismiss() {
    this.onboardingRepo.dismiss(new Date().toISOString());
    return this.getOverview();
  }

  private async resolveSampleDocument(documentId: string | null): Promise<Document> {
    if (documentId) return this.dependencies.getDocument(documentId);
    const sha256 = crypto.createHash('sha256').update(Buffer.from(SAMPLE_DOCUMENT, 'utf8')).digest('hex');
    const existing = this.documentRepo.findBySha256(sha256);
    if (existing) return this.dependencies.getDocument(existing.id);
    return this.dependencies.uploadDocument();
  }
}

function getRuntimeDocumentService(): typeof import('./document-runtime')['documentService'] {
  return require('./document-runtime').documentService;
}

function getSemanticSearch(): typeof import('../ai/semantic-search')['semanticSearch'] {
  return require('../ai/semantic-search').semanticSearch;
}

let singleton: OnboardingService | null = null;

export function getOnboardingService(): OnboardingService {
  singleton ??= new OnboardingService();
  return singleton;
}
