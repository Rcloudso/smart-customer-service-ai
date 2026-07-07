import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { conversationService } from '../services/conversation.service';
import { intentService } from '../services/intent.service';
import { escalationService } from '../services/escalation.service';
import { buildSystemPrompt, buildMessages } from '../ai/prompt-manager';
import { getWindow } from '../ai/context-manager';
import { getLLMClient } from '../ai/llm-client';
import { MessageRole } from '../types/domain';
import { FaqMatch, LLMMessage } from '../types/ai';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

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
  sessionId: z.string().min(1, 'sessionId不能为空'),
  rating: z.number().int().min(1).max(5),
});

function findDirectFaqAnswer(faqMatches: FaqMatch[]): FaqMatch | null {
  return faqMatches.find((match) =>
    (match.source === 'keyword' || match.source === 'hybrid') &&
    (match.keywordScore ?? match.similarity) >= 0.65,
  ) ?? null;
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
    let sessionId = inputSessionId;
    if (!sessionId) {
      const session = conversationService.createSession(userIdent);
      sessionId = session.id;
    }

    // Step 2: Save user message
    conversationService.saveMessage({
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

    // Step 5: Get context window
    const contextMessages = await getWindow(llmHistory);

    // Step 6: Build system prompt
    const systemPrompt = buildSystemPrompt({
      intent: intentResult.intent.intent,
      faqResults: intentResult.faqMatches,
      userQuestion: message,
      conversationSummary: null,
      shouldOfferEscalation: intentResult.needsEscalation,
    });

    // Step 7: Build full messages array for LLM
    const fullMessages = buildMessages(systemPrompt, {
      intent: intentResult.intent.intent,
      faqResults: intentResult.faqMatches,
      userQuestion: message,
      conversationSummary: null,
      shouldOfferEscalation: intentResult.needsEscalation,
    }, contextMessages);

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
    if (intentResult.faqMatches.length > 0) {
      sseSend({
        type: 'faq',
        content: intentResult.faqMatches.map((m) => ({
          id: m.id,
          question: m.question,
          answer: m.answer,
          similarity: m.similarity,
          source: m.source,
          vectorScore: m.vectorScore,
          keywordScore: m.keywordScore,
        })),
      });
    }

    const directFaq = intentResult.needsEscalation ? null : findDirectFaqAnswer(intentResult.faqMatches);
    if (directFaq) {
      const fullContent = directFaq.answer;
      sseSend({ type: 'token', content: fullContent });

      const assistantMessage = conversationService.saveMessage({
        sessionId,
        role: MessageRole.ASSISTANT,
        content: fullContent,
        intent: intentResult.intent.intent,
        intentConf: intentResult.intent.confidence,
      });

      sseSend({
        type: 'done',
        content: {
          sessionId,
          messageId: assistantMessage.id,
          intent: intentResult.intent.intent,
        },
      });

      logger.info(
        { sessionId, messageId: assistantMessage.id, faqId: directFaq.id },
        'Chat interaction completed with direct FAQ answer',
      );
      res.end();
      return;
    }

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
    let escalated = 0;
    if (escalateMatch) {
      escalated = 1;
      const reason = escalateMatch[1].trim();
      escalationService.createEscalation(sessionId, reason);

      // Clean content by removing the ESCALATE marker
      fullContent = fullContent.replace(/ESCALATE:\s*.+?(?:\n|$)/g, '').trim();

      sseSend({ type: 'escalate', content: reason });
    }

    // Also check content for frustration triggers via escalation service
    if (!escalated) {
      const checkResult = escalationService.checkEscalation(message);
      if (checkResult.shouldEscalate && checkResult.reason) {
        escalated = 1;
        escalationService.createEscalation(sessionId, checkResult.reason);
        sseSend({ type: 'escalate', content: checkResult.reason });
      }
    }

    // Step 10: Save assistant message
    const assistantMessage = conversationService.saveMessage({
      sessionId,
      role: MessageRole.ASSISTANT,
      content: fullContent,
      intent: intentResult.intent.intent,
      intentConf: intentResult.intent.confidence,
    });
    assistantMessageId = assistantMessage.id;

    // Mark escalated if needed
    if (escalated) {
      const { getDatabase } = await import('../db');
      const db = getDatabase();
      const markStmt = db.prepare('UPDATE messages SET escalated = 1 WHERE id = ?');
      markStmt.run(assistantMessageId);
    }

    // Step 11: Send done event
    sseSend({
      type: 'done',
      content: {
        sessionId,
        messageId: assistantMessageId,
        intent: intentResult.intent.intent,
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

    const { sessionId, rating } = parsed.data;

    // Find the last assistant message in the session
    const messages = conversationService.getMessages(sessionId);
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);

    if (!lastAssistantMsg) {
      // Try to find any message to rate
      const lastMsg = [...messages].reverse().find((m) => m.role === MessageRole.USER);
      if (!lastMsg) {
        res.json({ code: 0, data: null, message: '没有可评分的消息' });
        return;
      }
      // Fall back to updating the user message's satisfaction (unconventional but better than failing)
      const { getDatabase } = await import('../db');
      const db = getDatabase();
      const stmt = db.prepare('UPDATE messages SET satisfaction = ? WHERE session_id = ? AND role = ?');
      stmt.run(rating, sessionId, MessageRole.USER);
    } else {
      const { getDatabase } = await import('../db');
      const db = getDatabase();
      const stmt = db.prepare('UPDATE messages SET satisfaction = ? WHERE id = ?');
      stmt.run(rating, lastAssistantMsg.id);
    }

    logger.info({ sessionId, rating }, 'Satisfaction rating submitted');

    res.json({ code: 0, data: { sessionId, rating }, message: 'ok' });
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
