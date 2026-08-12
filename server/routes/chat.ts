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
import {
  IntentCategory,
  KnowledgeRetrievalSnapshot,
  MessageRole,
  SatisfactionRating,
} from '../types/domain';
import { FaqMatch, LLMMessage, RetrievalResult } from '../types/ai';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  deterministicGroundingReply,
  evaluateGrounding,
  selectDirectFaqCandidates,
} from '../services/grounding-policy';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { getQualityLabService } from '../services/quality-lab.service';
import { RetrievalTraceCollector } from '../services/retrieval-trace-collector';
import { getRetrievalTraceService } from '../services/retrieval-trace.service';
import { config } from '../config';
import { getOnboardingService } from '../services/onboarding.service';
import { orderVerifyIpRateLimiter } from '../middleware/rateLimit';
import { getOrderToolService } from '../services/order-tool.service';
import type { ResolvedOrderGrant } from '../services/order-grant.service';
import {
  ORDER_STATUS_TOOL_NAME,
  ORDER_STATUS_TOOL_VERSION,
} from '../types/order-tool';
import { planOrderToolRoute } from '../tools/order-routing';
import { AuthError } from '../utils/errors';

const router = Router();

const orderVerifySchema = z.object({
  sessionId: z.string().min(1).max(100),
  userIdent: z.string().min(1).max(200),
  orderReference: z.string().trim().min(4).max(80),
  verificationCode: z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/),
}).strict();

const orderLookupSchema = z.object({
  sessionId: z.string().min(1).max(100),
  userIdent: z.string().min(1).max(200),
}).strict();

function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(valueParts.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

router.post(
  '/tools/order/verify',
  orderVerifyIpRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = orderVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors.map((error) => error.message).join('; '));
      }
      const grant = await getOrderToolService().verify(parsed.data);
      const maxAge = Math.max(0, new Date(grant.expiresAt).getTime() - Date.now());
      res.cookie('rw_order_grant', grant.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.nodeEnv === 'production',
        path: '/api/chat',
        maxAge,
      });
      res.json({
        code: 0,
        data: {
          maskedOrderReference: grant.maskedOrderReference,
          expiresAt: grant.expiresAt,
          toolName: grant.toolName,
          toolVersion: grant.toolVersion,
        },
        message: 'ok',
      });
    } catch (error) {
      next(error);
    }
  },
);

function authorizeOrderLookup(req: Request, res: Response, next: NextFunction): void {
  const parsed = orderLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    next(new ValidationError(parsed.error.errors.map((error) => error.message).join('; ')));
    return;
  }
  const token = readCookie(req, 'rw_order_grant') ?? '';
  const grant = getOrderToolService().resolveGrant(token, parsed.data);
  if (!grant) {
    next(new AuthError('订单授权无效或已过期，请重新验证'));
    return;
  }
  res.locals.orderGrant = grant;
  res.locals.idempotencyBinding = grant.id;
  next();
}

function requireLookupIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  if (!req.get('Idempotency-Key')) {
    next(new ValidationError('Idempotency-Key is required for order lookup'));
    return;
  }
  next();
}

router.post(
  '/tools/order/lookup',
  authorizeOrderLookup,
  requireLookupIdempotencyKey,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const grant = res.locals.orderGrant as ResolvedOrderGrant;
      const result = await getOrderToolService().lookup(
        grant,
        req.get('Idempotency-Key')!,
      );
      res.json({ code: 0, data: result, message: 'ok' });
    } catch (error) {
      next(error);
    }
  },
);

// Verification is deliberately registered before this middleware because a
// replayed body cannot safely reproduce the Set-Cookie authorization grant.
router.use(idempotencyMiddleware);

const chatSchema = z.object({
  message: z.string().min(1, '消息不能为空').max(2000, '消息过长'),
  sessionId: z.string().optional(),
  userIdent: z.string().optional(),
  onboardingRunId: z.string().uuid().optional(),
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

function findDirectFaqAnswer(
  message: string,
  faqMatches: FaqMatch[],
  threshold: number,
): FaqMatch | null {
  return selectDirectFaqCandidates(message, faqMatches, threshold)[0] ?? null;
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
    sourceBlockIds: result.sourceBlockIds,
    extractionJobId: result.extractionJobId,
    extractionEngine: result.extractionEngine,
    extractionEngineVersion: result.extractionEngineVersion,
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

async function handlePreRagOrderRoute(input: {
  route: ReturnType<typeof planOrderToolRoute>;
  inputSessionId?: string;
  userIdent: string;
  response: Response;
}): Promise<boolean> {
  const { route, inputSessionId, userIdent, response } = input;
  if (route.kind === 'policy_question' || route.kind === 'not_applicable') return false;

  const session = conversationService.resolveSessionForMessage(inputSessionId, userIdent);
  const userMessage = conversationService.saveMessage({
    sessionId: session.id,
    role: MessageRole.USER,
    content: route.safeMessage,
    intent: route.kind === 'explicit_human' ? IntentCategory.GENERAL : IntentCategory.ORDER,
    intentConf: 1,
  });
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  const send = (data: object): void => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const intent = route.kind === 'explicit_human'
    ? IntentCategory.GENERAL
    : IntentCategory.ORDER;
  send({ type: 'intent', content: intent, confidence: 1 });

  if (route.kind === 'lookup') {
    const toolEnabled = getOrderToolService().isEnabled();
    const content = toolEnabled
      ? '请先验证此订单，验证成功后可安全查询当前状态。 / Verify this order to view its current status securely.'
      : '订单查询工具当前未启用。你可以稍后重试或选择转人工。 / Order lookup is not enabled. Retry later or contact support.';
    const assistant = conversationService.saveMessage({
      sessionId: session.id,
      role: MessageRole.ASSISTANT,
      content,
      intent,
      intentConf: 1,
      replyToMessageId: userMessage.id,
      retrievalSnapshot: [],
    });
    send({ type: 'token', content });
    send({
      type: 'tool',
      content: {
        toolName: ORDER_STATUS_TOOL_NAME,
        toolVersion: ORDER_STATUS_TOOL_VERSION,
        status: toolEnabled ? 'verification_required' : 'failed',
        maskedOrderReference: route.maskedOrderReference,
        safeErrorCode: toolEnabled ? undefined : 'tool_disabled',
        demoAvailable: config.orderTool.provider === 'demo',
        demoSample: config.orderTool.provider === 'demo'
          ? { orderReference: 'RW-DEMO-1002', verificationCode: '135790' }
          : undefined,
      },
    });
    send({
      type: 'done',
      content: {
        sessionId: session.id,
        messageId: assistant.id,
        intent,
        knowledgeSources: [],
        tool: {
          toolName: ORDER_STATUS_TOOL_NAME,
          toolVersion: ORDER_STATUS_TOOL_VERSION,
          status: toolEnabled ? 'verification_required' : 'failed',
          maskedOrderReference: route.maskedOrderReference,
        },
      },
    });
    response.end();
    return true;
  }

  const isExplicit = route.kind === 'explicit_human';
  const groundingReason = isExplicit
    ? 'user_requested_human'
    : 'unsupported_business_action';
  const escalationReason = isExplicit
    ? '用户明确要求转人工客服'
    : '当前请求涉及尚未授权的业务操作，需要人工处理';
  const content = deterministicGroundingReply(groundingReason);
  const assistant = await conversationService.saveMessageAndEscalate({
    sessionId: session.id,
    role: MessageRole.ASSISTANT,
    content,
    intent,
    intentConf: 1,
    replyToMessageId: userMessage.id,
    retrievalSnapshot: [],
    answerMode: 'refusal',
    groundingStatus: isExplicit ? 'escalated' : 'high_risk',
    groundingReason,
  }, escalationReason);
  send({ type: 'token', content });
  send({ type: 'escalate', content: escalationReason });
  send({
    type: 'done',
    content: {
      sessionId: session.id,
      messageId: assistant.id,
      intent,
      knowledgeSources: [],
      answerMode: assistant.answerMode,
      groundingStatus: assistant.groundingStatus,
      groundingReason: assistant.groundingReason,
    },
  });
  response.end();
  return true;
}

/**
 * POST /api/chat
 * Core SSE streaming endpoint for chat messages.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  let trace: RetrievalTraceCollector | null = null;
  let traceLink: {
    sessionId: string;
    userMessageId: string;
    policyId: string;
  } | null = null;
  let tracePersisted = false;
  const finalizeTrace = (assistantMessageId: string | null, errorCode?: string): void => {
    if (!trace || !traceLink || tracePersisted) return;
    if (errorCode) trace.fail(errorCode);
    try {
      getRetrievalTraceService().persist(trace.complete({
        ...traceLink,
        assistantMessageId,
      }));
      tracePersisted = true;
    } catch (error) {
      logger.error({
        traceId: trace.id,
        sessionId: traceLink.sessionId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Retrieval trace persistence failed');
    }
  };
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const {
      message: rawMessage,
      sessionId: inputSessionId,
      userIdent: inputUserIdent,
      onboardingRunId,
    } = parsed.data;
    const isOnboarding = Boolean(onboardingRunId);
    const userIdent = inputUserIdent || req.ip || 'anonymous';
    const orderRoute = planOrderToolRoute(rawMessage);
    if (!isOnboarding && await handlePreRagOrderRoute({
      route: orderRoute,
      inputSessionId,
      userIdent,
      response: res,
    })) return;
    const message = orderRoute.safeMessage;
    const retrievalPolicy = getQualityLabService().getCurrentPolicy();
    trace = new RetrievalTraceCollector({ backend: config.vectorStore.provider });

    // Step 1: Get or create session
    if (onboardingRunId) getOnboardingService().assertActiveRun(onboardingRunId);
    const session = conversationService.resolveSessionForMessage(inputSessionId, userIdent, {
      origin: onboardingRunId ? 'onboarding' : 'customer',
      onboardingRunId: onboardingRunId ?? null,
    });
    const sessionId = session.id;

    // Step 2: Save user message
    const userMessage = conversationService.saveMessage({
      sessionId,
      role: MessageRole.USER,
      content: message,
    });
    traceLink = {
      sessionId,
      userMessageId: userMessage.id,
      policyId: retrievalPolicy.id,
    };

    // Step 3: Build LLM message history from DB messages
    const previousMessages = conversationService.getMessages(sessionId);
    const llmHistory: LLMMessage[] = previousMessages
      .filter((m) => m.role !== MessageRole.SYSTEM)
      .map((m) => ({
        role: m.role === MessageRole.USER ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));

    // Step 4: Process intent
    const intentResult = await intentService.processMessage(
      message,
      llmHistory,
      retrievalPolicy.config,
      trace,
    );
    const groundingStarted = performance.now();
    const grounding = evaluateGrounding({
      message,
      intent: intentResult.intent.intent,
      faqMatches: intentResult.faqMatches,
      retrievalResults: intentResult.retrievalResults,
      explicitEscalation: !isOnboarding && intentResult.escalationType === 'explicit',
      policy: retrievalPolicy.config,
    });
    trace.record('context_budget', {
      status: 'completed',
      latencyMs: 0,
      inputCount: intentResult.retrievalResults.length,
      outputCount: grounding.citations.length,
      candidates: grounding.citations.map((result, index) => ({
        knowledgeType: result.knowledgeType,
        knowledgeId: result.knowledgeId,
        score: result.similarity,
        rank: index + 1,
        source: result.source,
      })),
      budget: { maxEvidence: 3, selectedEvidence: grounding.citations.length },
    });
    trace.record('grounding', {
      status: 'completed',
      latencyMs: performance.now() - groundingStarted,
      inputCount: intentResult.retrievalResults.length,
      outputCount: grounding.citations.length,
      candidates: grounding.citations.map((result, index) => ({
        knowledgeType: result.knowledgeType,
        knowledgeId: result.knowledgeId,
        score: result.similarity,
        rank: index + 1,
        source: result.source,
      })),
      budget: {
        directFaqThreshold: retrievalPolicy.config.directFaqThreshold,
        generationEvidenceThreshold: retrievalPolicy.config.generationEvidenceThreshold,
      },
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
    if (!isOnboarding && intentResult.escalationType === 'explicit' && intentResult.escalationReason) {
      escalationReason = intentResult.escalationReason;
    } else if (!isOnboarding && grounding.shouldEscalate) {
      escalationReason = grounding.groundingStatus === 'conflicting'
        ? '知识库存在冲突答案，需要人工核实'
        : '当前请求涉及尚未授权的业务操作，需要人工处理';
    }

    const directFaq = grounding.answerMode === 'direct_faq'
      ? findDirectFaqAnswer(
        message,
        intentResult.faqMatches,
        retrievalPolicy.config.directFaqThreshold,
      )
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
        retrievalPolicyId: retrievalPolicy.id,
      };
      const assistantMessage = escalationReason
        ? await conversationService.saveMessageAndEscalate(messageParams, escalationReason)
        : conversationService.saveMessage(messageParams);
      finalizeTrace(assistantMessage.id);

      if (!isOnboarding && grounding.groundingStatus !== 'high_risk') {
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
          retrievalPolicyId: retrievalPolicy.id,
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
      fullContent = await llmClient.chatStream(
        fullMessages,
        (token: string) => {
          sseSend({ type: 'token', content: token });
        },
        { temperature: 0.7, maxTokens: 2000 },
      );
    } catch (streamErr) {
      logger.error({ err: streamErr, sessionId }, 'LLM stream failed');
      sseSend({ type: 'error', content: 'AI响应生成失败，请稍后重试' });
      finalizeTrace(null, 'generation_failed');
      res.end();
      return;
    }

    // Step 9: Check for escalation marker in content
    const escalateMatch = fullContent.match(/ESCALATE:\s*(.+?)(?:\n|$)/);
    if (escalateMatch) {
      const reason = escalateMatch[1].trim();
      if (!isOnboarding && !escalationReason) escalationReason = reason;

      // Clean content by removing the ESCALATE marker
      fullContent = fullContent.replace(/ESCALATE:\s*.+?(?:\n|$)/g, '').trim();
    }

    // Also check content for frustration triggers via escalation service
    if (!isOnboarding && !escalationReason) {
      const checkResult = escalationService.checkEscalation(message);
      if (checkResult.shouldEscalate && checkResult.reason) {
        escalationReason = checkResult.reason;
      }
    }

    if (!fullContent.trim()) {
      if (escalationReason) {
        await escalationService.createEscalation(sessionId, escalationReason, {
          intent: intentResult.intent.intent,
          groundingStatus: grounding.groundingStatus,
          messages: conversationService.getMessages(sessionId),
          retrievalSnapshot: toRetrievalSnapshot(grounding.citations),
        });
        sseSend({ type: 'escalate', content: escalationReason });
      }
      logger.error({ sessionId }, 'LLM stream completed without answer content');
      sseSend({ type: 'error', content: 'AI响应生成失败，请稍后重试' });
      finalizeTrace(null, 'empty_generation');
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
      retrievalPolicyId: retrievalPolicy.id,
    };
    const assistantMessage = escalationReason
      ? await conversationService.saveMessageAndEscalate(messageParams, escalationReason)
      : conversationService.saveMessage(messageParams);
    assistantMessageId = assistantMessage.id;
    finalizeTrace(assistantMessage.id);

    if (!isOnboarding) {
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
        retrievalPolicyId: retrievalPolicy.id,
      },
    });

    logger.info({ sessionId, messageId: assistantMessageId, intent: intentResult.intent.intent }, 'Chat interaction completed');
    res.end();
  } catch (err) {
    finalizeTrace(null, 'chat_request_failed');
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
    getOrderToolService().revokeSession(session.id);
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
