import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { conversationService } from '../services/conversation.service';
import { intentService } from '../services/intent.service';
import { escalationService } from '../services/escalation.service';
import { knowledgeReviewService } from '../services/knowledge-review.service';
import { buildSystemPrompt, buildMessages } from '../ai/prompt-manager';
import { getWindow } from '../ai/context-manager';
import { getLLMClient } from '../ai/llm-client';
import { KnowledgeRetrievalSnapshot, MessageRole, SatisfactionRating } from '../types/domain';
import { FaqMatch, LLMMessage, RetrievalResult } from '../types/ai';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  deterministicGroundingReply,
  evaluateGrounding,
  selectDirectFaqCandidates,
} from '../services/grounding-policy';
import { idempotencyMiddleware } from '../middleware/idempotency';

const router = Router();
router.use(idempotencyMiddleware);

const chatSchema = z.object({
  message: z.string().min(1, '消息不能为空').max(2000, '消息过长'),
  sessionId: z.string().optional(),
  userIdent: z.string().optional(),
});

const historyQuerySchema = z.object({
  userIdent: z.string().min(1, 'userIdent不能为空'),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(50).optional(),
});

const satisfactionSchema = z.object({
  messageId: z.string().min(1, 'messageId不能为空').optional(),
  sessionId: z.string().min(1, 'sessionId不能为空').optional(),
  userIdent: z.string().min(1, 'userIdent不能为空'),
  rating: z.number().int().min(1).max(5),
}).refine((value) => Boolean(value.messageId || value.sessionId), {
  message: 'messageId或sessionId不能为空',
});

const closeSessionSchema = z.object({
  userIdent: z.string().min(1, 'userIdent不能为空'),
});

function findDirectFaqAnswer(message: string, faqMatches: FaqMatch[]): FaqMatch | null {
  return selectDirectFaqCandidates(message, faqMatches)[0] ?? null;
}

function faqMatchesForClient(
  faqMatches: FaqMatch[],
  retrievalResults: RetrievalResult[],
): FaqMatch[] {
  if (retrievalResults[0]?.knowledgeType !== 'document') return faqMatches;
  return faqMatches.filter((match) => match.source === 'keyword' || match.source === 'hybrid');
}

function toRetrievalSnapshot(results: RetrievalResult[]): KnowledgeRetrievalSnapshot[] {
  return results.slice(0, 3).map((result) => ({
    knowledgeType: result.knowledgeType,
    knowledgeId: result.knowledgeId,
    documentId: result.documentId,
    title: result.title,
    source: result.source,
    similarity: result.similarity,
    keywordScore: result.keywordScore,
    vectorScore: result.vectorScore,
    fusionScore: result.fusionScore,
    keywordRank: result.keywordRank,
    vectorRank: result.vectorRank,
    chunkIndex: result.chunkIndex,
    pageStart: result.pageStart,
    pageEnd: result.pageEnd,
  }));
}

function captureKnowledgeGapSafely(
  params: Parameters<typeof knowledgeReviewService.captureChatGap>[0],
): void {
  try {
    knowledgeReviewService.captureChatGap(params);
  } catch (error) {
    logger.error(
      {
        err: error,
        sessionId: params.userMessage.sessionId,
        userMessageId: params.userMessage.id,
        assistantMessageId: params.assistantMessage.id,
      },
      'Knowledge review capture failed after assistant message was saved',
    );
  }
}

/**
 * POST /api/chat
 * Core SSE streaming endpoint for chat messages.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { message, sessionId: inputSessionId, userIdent: inputUserIdent } = parsed.data;
    const userIdent = inputUserIdent || req.ip || 'anonymous';

    // Step 1: Get or create session
    const session = conversationService.resolveSessionForMessage(inputSessionId, userIdent);
    const sessionId = session.id;

    // Step 2: Save user message
    const userMessage = conversationService.saveMessage({
      sessionId,
      role: MessageRole.USER,
      content: message,
    });

    // Step 3: Build LLM message history from DB messages
    const previousMessages = conversationService.getMessages(sessionId);
    const llmHistory: LLMMessage[] = previousMessages
      .filter((m) => m.role !== MessageRole.SYSTEM)
      .map((m) => ({
        role: m.role === MessageRole.USER ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));

    // Step 4: Process intent
    const intentResult = await intentService.processMessage(message, llmHistory);
    const grounding = evaluateGrounding({
      message,
      intent: intentResult.intent.intent,
      faqMatches: intentResult.faqMatches,
      retrievalResults: intentResult.retrievalResults,
      explicitEscalation: intentResult.escalationType === 'explicit',
    });

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial metadata
    const sseSend = (data: object): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send intent
    sseSend({
      type: 'intent',
      content: intentResult.intent.intent,
      confidence: intentResult.intent.confidence,
    });

    // Send FAQ matches
    const clientFaqMatches = faqMatchesForClient(
      intentResult.faqMatches,
      intentResult.retrievalResults,
    );
    if (clientFaqMatches.length > 0) {
      sseSend({
        type: 'faq',
        content: clientFaqMatches.map((m) => ({
          id: m.id,
          question: m.question,
          answer: m.answer,
          similarity: m.similarity,
          source: m.source,
          vectorScore: m.vectorScore,
          keywordScore: m.keywordScore,
          fusionScore: m.fusionScore,
          vectorRank: m.vectorRank,
          keywordRank: m.keywordRank,
        })),
      });
    }

    let escalationReason: string | null = null;
    if (intentResult.escalationType === 'explicit' && intentResult.escalationReason) {
      escalationReason = intentResult.escalationReason;
    } else if (grounding.shouldEscalate) {
      escalationReason = grounding.groundingStatus === 'conflicting'
        ? '知识库存在冲突答案，需要人工核实'
        : '当前请求涉及尚未授权的业务操作，需要人工处理';
    }

    const directFaq = grounding.answerMode === 'direct_faq'
      ? findDirectFaqAnswer(message, intentResult.faqMatches)
      : null;
    if (!grounding.shouldGenerate) {
      const fullContent = directFaq?.answer ?? deterministicGroundingReply(grounding.groundingReason);
      const citations = toRetrievalSnapshot(grounding.citations);
      sseSend({ type: 'token', content: fullContent });

      const messageParams = {
        sessionId,
        role: MessageRole.ASSISTANT,
        content: fullContent,
        intent: intentResult.intent.intent,
        intentConf: intentResult.intent.confidence,
        replyToMessageId: userMessage.id,
        retrievalSnapshot: citations,
        answerMode: grounding.answerMode,
        groundingStatus: grounding.groundingStatus,
        groundingReason: grounding.groundingReason,
      };
      const assistantMessage = escalationReason
        ? conversationService.saveMessageAndEscalate(messageParams, escalationReason)
        : conversationService.saveMessage(messageParams);

      if (grounding.groundingStatus !== 'high_risk') {
        captureKnowledgeGapSafely({
          userMessage,
          assistantMessage,
          intent: intentResult.intent.intent,
          intentConf: intentResult.intent.confidence,
          faqMatches: intentResult.faqMatches,
          retrievalResults: intentResult.retrievalResults,
          escalationType: intentResult.escalationType,
        });
      }

      if (escalationReason) sseSend({ type: 'escalate', content: escalationReason });

      sseSend({
        type: 'done',
        content: {
          sessionId,
          messageId: assistantMessage.id,
          intent: intentResult.intent.intent,
          knowledgeSources: assistantMessage.retrievalSnapshot,
          answerMode: assistantMessage.answerMode,
          groundingStatus: assistantMessage.groundingStatus,
          groundingReason: assistantMessage.groundingReason,
        },
      });

      logger.info(
        {
          sessionId,
          messageId: assistantMessage.id,
          answerMode: grounding.answerMode,
          groundingStatus: grounding.groundingStatus,
        },
        'Chat interaction completed without generation',
      );
      res.end();
      return;
    }

    // Step 5: Build the bounded context and prompt only when generation is allowed.
    const contextMessages = await getWindow(llmHistory);
    const systemPrompt = buildSystemPrompt({
      intent: intentResult.intent.intent,
      knowledgeResults: grounding.citations,
      userQuestion: message,
      conversationSummary: null,
      shouldOfferEscalation: intentResult.needsEscalation,
    });
    const fullMessages = buildMessages(systemPrompt, {
      intent: intentResult.intent.intent,
      knowledgeResults: grounding.citations,
      userQuestion: message,
      conversationSummary: null,
      shouldOfferEscalation: intentResult.needsEscalation,
    }, contextMessages);

    // Step 8: Stream LLM response
    let fullContent = '';
    let assistantMessageId = uuidv4();

    try {
      const llmClient = getLLMClient();
      await llmClient.chatStream(
        fullMessages,
        (token: string) => {
          fullContent += token;
          sseSend({ type: 'token', content: token });
        },
        { temperature: 0.7, maxTokens: 2000 },
      );
    } catch (streamErr) {
      logger.error({ err: streamErr, sessionId }, 'LLM stream failed');
      sseSend({ type: 'error', content: 'AI响应生成失败，请稍后重试' });
      res.end();
      return;
    }

    // Step 9: Check for escalation marker in content
    const escalateMatch = fullContent.match(/ESCALATE:\s*(.+?)(?:\n|$)/);
    if (escalateMatch) {
      const reason = escalateMatch[1].trim();
      if (!escalationReason) escalationReason = reason;

      // Clean content by removing the ESCALATE marker
      fullContent = fullContent.replace(/ESCALATE:\s*.+?(?:\n|$)/g, '').trim();
    }

    // Also check content for frustration triggers via escalation service
    if (!escalationReason) {
      const checkResult = escalationService.checkEscalation(message);
      if (checkResult.shouldEscalate && checkResult.reason) {
        escalationReason = checkResult.reason;
      }
    }

    if (!fullContent.trim()) {
      if (escalationReason) {
        escalationService.createEscalation(sessionId, escalationReason);
        sseSend({ type: 'escalate', content: escalationReason });
      }
      logger.error({ sessionId }, 'LLM stream completed without answer content');
      sseSend({ type: 'error', content: 'AI响应生成失败，请稍后重试' });
      res.end();
      return;
    }

    // Step 10: Save assistant message
    const messageParams = {
      sessionId,
      role: MessageRole.ASSISTANT,
      content: fullContent,
      intent: intentResult.intent.intent,
      intentConf: intentResult.intent.confidence,
      replyToMessageId: userMessage.id,
      retrievalSnapshot: toRetrievalSnapshot(grounding.citations),
      answerMode: grounding.answerMode,
      groundingStatus: grounding.groundingStatus,
      groundingReason: grounding.groundingReason,
    };
    const assistantMessage = escalationReason
      ? conversationService.saveMessageAndEscalate(messageParams, escalationReason)
      : conversationService.saveMessage(messageParams);
    assistantMessageId = assistantMessage.id;

    captureKnowledgeGapSafely({
      userMessage,
      assistantMessage,
      intent: intentResult.intent.intent,
      intentConf: intentResult.intent.confidence,
      faqMatches: intentResult.faqMatches,
      retrievalResults: intentResult.retrievalResults,
      escalationType: intentResult.escalationType,
    });

    if (escalationReason) sseSend({ type: 'escalate', content: escalationReason });

    // Step 11: Send done event
    sseSend({
      type: 'done',
      content: {
        sessionId,
        messageId: assistantMessageId,
        intent: intentResult.intent.intent,
        knowledgeSources: assistantMessage.retrievalSnapshot,
        answerMode: assistantMessage.answerMode,
        groundingStatus: assistantMessage.groundingStatus,
        groundingReason: assistantMessage.groundingReason,
      },
    });

    logger.info({ sessionId, messageId: assistantMessageId, intent: intentResult.intent.intent }, 'Chat interaction completed');
    res.end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/chat/satisfaction
 * Submit a satisfaction rating for a completed chat session.
 */
router.post('/satisfaction', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = satisfactionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { messageId, sessionId, userIdent, rating } = parsed.data;
    let assistantMessage = messageId ? conversationService.getMessage(messageId) : null;

    if (messageId && (!assistantMessage || assistantMessage.role !== MessageRole.ASSISTANT)) {
      throw new ValidationError('messageId 必须指向助手消息');
    }

    if (!assistantMessage && sessionId) {
      assistantMessage = [...conversationService.getMessages(sessionId)]
        .reverse()
        .find((message) => message.role === MessageRole.ASSISTANT) ?? null;
    }

    if (!assistantMessage) {
      res.json({ code: 0, data: null, message: '没有可评分的消息' });
      return;
    }

    if (sessionId && assistantMessage.sessionId !== sessionId) {
      throw new ValidationError('messageId 与 sessionId 不匹配');
    }

    const resolvedSessionId = assistantMessage.sessionId;
    conversationService.assertSessionOwnership(resolvedSessionId, userIdent);
    knowledgeReviewService.recordRating({
      sessionId: resolvedSessionId,
      assistantMessageId: assistantMessage.id,
      rating: rating as SatisfactionRating,
    });

    logger.info({ sessionId: resolvedSessionId, messageId: assistantMessage.id, rating }, 'Satisfaction rating submitted');

    res.json({
      code: 0,
      data: { sessionId: resolvedSessionId, messageId: assistantMessage.id, rating },
      message: 'ok',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/chat/sessions
 * List chat history for the current anonymous browser user.
 */
router.get('/sessions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const result = conversationService.getUserConversations(parsed.data);
    res.json({ code: 0, data: result, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/chat/sessions/:sessionId/close
 * Close the current anonymous user's session before starting a new chat.
 */
router.post('/sessions/:sessionId/close', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = closeSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const session = conversationService.closeUserSession(
      req.params.sessionId,
      parsed.data.userIdent,
    );
    res.json({ code: 0, data: session, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/chat/sessions/:sessionId
 * Load one historical conversation owned by the current anonymous browser user.
 */
router.get('/sessions/:sessionId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const detail = conversationService.getUserConversationDetail(parsed.data.userIdent, req.params.sessionId);
    res.json({ code: 0, data: detail, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
