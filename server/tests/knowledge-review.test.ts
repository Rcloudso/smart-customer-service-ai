import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { KnowledgeReviewRepo } from '../db/repos/knowledge-review.repo';
import { KnowledgeReviewService } from '../services/knowledge-review.service';
import {
  IntentCategory,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  MessageRole,
} from '../types/domain';

function createFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  const sessions = new SessionRepo(db);
  const messages = new MessageRepo(db);
  const reviews = new KnowledgeReviewRepo(db);
  const session = sessions.create('knowledge-review-test-user');
  const userMessage = messages.create({
    sessionId: session.id,
    role: MessageRole.USER,
    content: '一个知识库里没有的问题',
  });
  const assistantMessage = messages.create({
    sessionId: session.id,
    role: MessageRole.ASSISTANT,
    content: '当前只能给出通用回答',
    intent: IntentCategory.GENERAL,
    intentConf: 0.82,
    replyToMessageId: userMessage.id,
    retrievalSnapshot: [{
      knowledgeType: 'faq',
      knowledgeId: 'answer-time-faq',
      title: '回答当时的 FAQ',
      similarity: 0.88,
      source: 'hybrid',
    }],
  });

  return { db, sessions, messages, reviews, session, userMessage, assistantMessage };
}

function testExistingMessageSchemaMigratesAdditively(): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_ident TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, intent TEXT, intent_conf REAL, satisfaction INTEGER,
      escalated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `);
  initSchema(db);
  const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'reply_to_message_id'));
  assert.ok(columns.some((column) => column.name === 'retrieval_snapshot'));
  db.close();
}

async function testChatGapDetectionAndDeduplication(): Promise<void> {
  const fixture = createFixture();
  const service = new KnowledgeReviewService(fixture.db, async () => undefined, () => undefined);

  const first = service.captureChatGap({
    userMessage: fixture.userMessage,
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.82,
    faqMatches: [],
    escalationType: null,
  });
  assert.equal(first?.triggerReason, KnowledgeReviewTriggerReason.NO_MATCH);
  assert.equal(first?.status, KnowledgeReviewStatus.PENDING);

  const duplicate = service.captureChatGap({
    userMessage: fixture.userMessage,
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.82,
    faqMatches: [],
    escalationType: null,
  });
  assert.equal(duplicate?.id, first?.id);
  assert.equal(fixture.reviews.getStats().total, 1);

  fixture.db.prepare('UPDATE knowledge_review_items SET retrieval_snapshot = ? WHERE id = ?')
    .run('[{}]', first?.id);
  assert.deepEqual(
    fixture.reviews.findById(first?.id as string)?.retrievalSnapshot,
    [],
    'malformed historical snapshot elements must fall back safely',
  );

  const explicit = service.captureChatGap({
    userMessage: { ...fixture.userMessage, id: 'explicit-user-message' },
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.2,
    faqMatches: [],
    escalationType: 'explicit',
  });
  assert.equal(explicit, null);

  const confident = service.captureChatGap({
    userMessage: { ...fixture.userMessage, id: 'confident-user-message' },
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.2,
    faqMatches: [{
      id: 'faq-high',
      question: '命中问题',
      answer: '命中答案',
      similarity: 0.9,
      source: 'hybrid',
      keywordScore: 0.9,
    }],
    escalationType: null,
  });
  assert.equal(confident, null, 'knowledge confidence must not depend on intent confidence');

  fixture.db.close();
}

async function testLowScoreSnapshotAndNegativeFeedbackUpsert(): Promise<void> {
  const fixture = createFixture();
  const service = new KnowledgeReviewService(fixture.db, async () => undefined, () => undefined);

  const lowScore = service.captureChatGap({
    userMessage: fixture.userMessage,
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.9,
    faqMatches: Array.from({ length: 4 }, (_, index) => ({
      id: `faq-${index}`,
      question: `候选 ${index}`,
      answer: `答案 ${index}`,
      similarity: 0.54 - index * 0.01,
      source: 'vector' as const,
      vectorScore: 0.54 - index * 0.01,
    })),
    escalationType: null,
  });
  assert.equal(lowScore?.triggerReason, KnowledgeReviewTriggerReason.LOW_RETRIEVAL_SCORE);
  assert.equal(lowScore?.retrievalSnapshot.length, 3);

  const positive = service.recordRating({
    sessionId: fixture.session.id,
    assistantMessageId: fixture.assistantMessage.id,
    rating: 4,
  });
  assert.equal(positive?.triggerReason, KnowledgeReviewTriggerReason.LOW_RETRIEVAL_SCORE);
  assert.equal(positive?.rating, 4);

  const rated = service.recordNegativeFeedback({
    sessionId: fixture.session.id,
    assistantMessageId: fixture.assistantMessage.id,
    rating: 1,
  });
  assert.equal(rated.triggerReason, KnowledgeReviewTriggerReason.NEGATIVE_FEEDBACK);
  assert.equal(rated.rating, 1);
  assert.equal(rated.id, lowScore?.id, 'rating must update the existing turn instead of duplicating it');
  assert.equal(fixture.reviews.getStats().total, 1);

  fixture.db.close();
}

async function testConversionRetryAndStatusConflicts(): Promise<void> {
  const fixture = createFixture();
  let shouldFail = true;
  const indexedFaqIds: string[] = [];
  const statusAtIndexCommit: KnowledgeReviewStatus[] = [];
  let conversionReviewId = '';
  const service = new KnowledgeReviewService(fixture.db, async (faq) => {
    indexedFaqIds.push(faq.id);
    if (shouldFail) throw new Error('index unavailable');
    return [0.1, 0.2];
  }, () => {
    statusAtIndexCommit.push(fixture.reviews.findById(conversionReviewId)?.status as KnowledgeReviewStatus);
  });
  const review = service.captureChatGap({
    userMessage: fixture.userMessage,
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.8,
    faqMatches: [],
    escalationType: null,
  });
  assert.ok(review);
  conversionReviewId = review.id;

  await assert.rejects(
    service.convert(review.id, {
      question: '沉淀后的问题',
      answer: '沉淀后的答案',
      category: IntentCategory.GENERAL,
      keywords: ['沉淀'],
      updatedBy: 'admin',
    }),
    /FAQ索引同步失败/,
  );

  const pending = fixture.reviews.findById(review.id);
  assert.equal(pending?.status, KnowledgeReviewStatus.PENDING);
  assert.ok(pending?.linkedFaqId);
  const faqCountAfterFailure = (fixture.db.prepare('SELECT COUNT(*) AS total FROM faq_entries').get() as { total: number }).total;
  assert.equal(faqCountAfterFailure, 1);
  const inactiveAfterFailure = fixture.db.prepare('SELECT is_active AS isActive FROM faq_entries').get() as { isActive: number };
  assert.equal(inactiveAfterFailure.isActive, 0, 'failed conversion FAQ must not be searchable');
  shouldFail = false;
  const converted = await service.convert(review.id, {
    question: '不会创建第二条',
    answer: '不会创建第二条',
    category: IntentCategory.GENERAL,
    keywords: [],
    updatedBy: 'admin',
  });
  assert.equal(converted.review.status, KnowledgeReviewStatus.CONVERTED);
  assert.equal(converted.faq.id, pending?.linkedFaqId);
  const faqCountAfterRetry = (fixture.db.prepare('SELECT COUNT(*) AS total FROM faq_entries').get() as { total: number }).total;
  assert.equal(faqCountAfterRetry, 1);
  assert.deepEqual(indexedFaqIds, [pending?.linkedFaqId, pending?.linkedFaqId]);
  assert.deepEqual(statusAtIndexCommit, [KnowledgeReviewStatus.PENDING]);

  const delayedRating = service.recordRating({
    sessionId: fixture.session.id,
    assistantMessageId: fixture.assistantMessage.id,
    rating: 2,
  });
  assert.equal(delayedRating?.status, KnowledgeReviewStatus.CONVERTED);
  assert.equal(delayedRating?.rating, 2);

  assert.throws(() => service.dismiss(review.id, 'late dismiss'), /已转换/);

  const secondUser = fixture.messages.create({
    sessionId: fixture.session.id,
    role: MessageRole.USER,
    content: '另一个问题',
  });
  const secondAssistant = fixture.messages.create({
    sessionId: fixture.session.id,
    role: MessageRole.ASSISTANT,
    content: '另一个回答',
    intent: IntentCategory.GENERAL,
    intentConf: 0.5,
  });
  const dismissed = service.captureChatGap({
    userMessage: secondUser,
    assistantMessage: secondAssistant,
    intent: IntentCategory.GENERAL,
    intentConf: 0.5,
    faqMatches: [],
    escalationType: null,
  });
  assert.ok(dismissed);
  assert.equal(service.dismiss(dismissed.id, 'not useful').status, KnowledgeReviewStatus.DISMISSED);
  await assert.rejects(
    service.convert(dismissed.id, {
      question: '禁止转换',
      answer: '禁止转换',
      category: IntentCategory.GENERAL,
      keywords: [],
      updatedBy: 'admin',
    }),
    /已忽略/,
  );

  fixture.db.close();
}

async function testFailedConversionCanBeDismissedWithoutOrphanFaq(): Promise<void> {
  const fixture = createFixture();
  const service = new KnowledgeReviewService(
    fixture.db,
    async () => { throw new Error('index unavailable'); },
    () => undefined,
  );
  const review = service.captureChatGap({
    userMessage: fixture.userMessage,
    assistantMessage: fixture.assistantMessage,
    intent: IntentCategory.GENERAL,
    intentConf: 0.8,
    faqMatches: [],
    escalationType: null,
  });
  assert.ok(review);
  await assert.rejects(service.convert(review.id, {
    question: '失败后可忽略',
    answer: '失败后可忽略',
    category: IntentCategory.GENERAL,
    keywords: [],
    updatedBy: 'admin',
  }), /FAQ索引同步失败/);

  const dismissed = service.dismiss(review.id, '索引暂不可用，不再沉淀');
  assert.equal(dismissed.status, KnowledgeReviewStatus.DISMISSED);
  const faqCount = (fixture.db.prepare('SELECT COUNT(*) AS total FROM faq_entries').get() as { total: number }).total;
  assert.equal(faqCount, 0);
  fixture.db.close();
}

async function testRatingUsesExplicitTurnLinkAndAnswerTimeSnapshot(): Promise<void> {
  const fixture = createFixture();
  const service = new KnowledgeReviewService(fixture.db, async () => undefined, () => undefined);
  const secondUser = fixture.messages.create({
    sessionId: fixture.session.id,
    role: MessageRole.USER,
    content: '并发的第二个问题',
  });
  const firstAssistant = fixture.messages.create({
    sessionId: fixture.session.id,
    role: MessageRole.ASSISTANT,
    content: '第一个问题的回答',
    intent: IntentCategory.GENERAL,
    intentConf: 0.9,
    replyToMessageId: fixture.userMessage.id,
    retrievalSnapshot: [{
      knowledgeType: 'faq',
      knowledgeId: 'high-confidence-faq',
      title: '高置信 FAQ',
      similarity: 0.91,
      source: 'hybrid',
    }],
  });
  fixture.messages.create({
    sessionId: fixture.session.id,
    role: MessageRole.ASSISTANT,
    content: '第二个问题的回答',
    intent: IntentCategory.GENERAL,
    intentConf: 0.8,
    replyToMessageId: secondUser.id,
  });

  const review = service.recordRating({
    sessionId: fixture.session.id,
    assistantMessageId: firstAssistant.id,
    rating: 1,
  });
  assert.equal(review?.question, fixture.userMessage.content);
  assert.equal(review?.retrievalSnapshot[0]?.knowledgeId, 'high-confidence-faq');
  assert.equal(fixture.messages.findById(firstAssistant.id)?.satisfaction, 1);

  fixture.db.close();
}

async function main(): Promise<void> {
  testExistingMessageSchemaMigratesAdditively();
  await testChatGapDetectionAndDeduplication();
  await testLowScoreSnapshotAndNegativeFeedbackUpsert();
  await testConversionRetryAndStatusConflicts();
  await testFailedConversionCanBeDismissedWithoutOrphanFaq();
  await testRatingUsesExplicitTurnLinkAndAnswerTimeSnapshot();
  console.log('Knowledge review checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
