import { getLLMClient } from './llm-client';
import { config } from '../config';
import { IntentResult, LLMMessage } from '../types/ai';
import { IntentCategory } from '../types/domain';
import { logger } from '../utils/logger';

// Keywords for fallback classification
const INTENT_KEYWORDS: Record<IntentCategory, string[]> = {
  [IntentCategory.REFUND]: [
    '退款', '退货', '退钱', '退换', '返还', '赔付', '赔偿', '退款申请', '退款进度', '退款状态',
    '退货退款', '退款到账', '退款时间', '退款原因', '退款金额',
  ],
  [IntentCategory.ORDER]: [
    '订单', '下单', '购买', '发货', '物流', '快递', '配送', '签收', '收货', '订单号',
    '订单状态', '订单查询', '订单详情', '修改订单', '取消订单', '已付款', '未付款',
  ],
  [IntentCategory.TECHNICAL]: [
    '登录', '密码', '账号', '登入', '注册', '验证码', '闪退', '卡顿', 'bug', '错误',
    '白屏', '异常', '故障', '支付失败', '系统', 'APP', '网站', '页面', '无法', '打不开',
    '网络', '连接', '缓存', '浏览器',
  ],
  [IntentCategory.GENERAL]: [
    '客服', '人工', '工作时间', '电话', '联系', '帮助', '优惠', '活动', '折扣', '促销',
    '会员', '积分', '发票', '关于', '问题', '怎么', '如何',
  ],
};

const INTENT_CLASSIFICATION_PROMPT = `你是一个智能客服系统的意图分类器。请分析用户消息，判断其意图类别。

类别定义：
- refund：退款、退货、退换货、赔付相关
- order：订单查询、订单状态、物流配送、下单购买相关
- technical：登录注册、支付失败、页面异常、APP故障等技术问题
- general：一般咨询、联系客服、优惠活动、其他不属前三类的问题

请严格按以下JSON格式输出：
{"intent": "refund|order|technical|general", "confidence": 0.0-1.0, "reasoning": "简短分类理由"}`;

const INTENT_RESPONSE_SCHEMA = {
  name: 'intent_classification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: Object.values(IntentCategory),
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      reasoning: {
        type: 'string',
      },
    },
    required: ['intent', 'confidence', 'reasoning'],
    additionalProperties: false,
  },
};

export async function classify(message: string, history: LLMMessage[] = []): Promise<IntentResult> {
  if (!config.llm.apiKey) {
    return keywordFallback(message);
  }

  try {
    const llmClient = getLLMClient();

    // Note: history already includes the current user message (saved by chat.ts before
    // calling this), so we slice(-5) to get the last 4 history entries plus current.
    const messages: LLMMessage[] = [
      { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
      ...history.slice(-5),
    ];

    const formats = ['json_schema', 'json_object', 'text'] as const;
    const failures: Array<{ format: string; message: string }> = [];
    for (const responseFormat of formats) {
      try {
        const response = await llmClient.chat(messages, {
          temperature: 0.1,
          maxTokens: 200,
          responseFormat,
          responseSchema: responseFormat === 'json_schema' ? INTENT_RESPONSE_SCHEMA : undefined,
          maxRetries: 1,
        });
        const result = parseIntentResponse(response);
        logger.debug(
          {
            intent: result.intent,
            confidence: result.confidence,
            responseFormat,
          },
          'Intent classified by LLM',
        );
        return result;
      } catch (err) {
        const failure = {
          format: responseFormat,
          message: err instanceof Error ? err.message : String(err),
        };
        failures.push(failure);
        logger.warn(failure, 'LLM intent response format failed, trying compatibility fallback');
      }
    }

    throw new Error(`All structured intent formats failed: ${failures.map((item) => item.format).join(', ')}`);
  } catch (err) {
    logger.warn(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      'LLM intent classification failed, using keyword fallback',
    );
    return keywordFallback(message);
  }
}

function parseIntentResponse(response: string): IntentResult {
  const fencedJson = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fencedJson?.trim() || response.trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    const objectStart = source.indexOf('{');
    const objectEnd = source.lastIndexOf('}');
    if (objectStart < 0 || objectEnd <= objectStart) {
      throw new Error('Intent response did not contain a JSON object');
    }
    parsed = JSON.parse(source.slice(objectStart, objectEnd + 1));
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Intent response must be a JSON object');
  }
  const candidate = parsed as Record<string, unknown>;
  const validIntents = Object.values(IntentCategory);
  if (!validIntents.includes(candidate.intent as IntentCategory)) {
    throw new Error('Intent response contains an unsupported intent');
  }
  if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence)) {
    throw new Error('Intent response confidence must be a finite number');
  }

  const intent = candidate.intent as IntentCategory;
  const confidence = Math.min(1, Math.max(0, candidate.confidence));

  return {
    intent,
    confidence,
    reasoning: typeof candidate.reasoning === 'string' && candidate.reasoning.trim()
      ? candidate.reasoning
      : 'Classified by LLM',
  };
}

function keywordFallback(message: string): IntentResult {
  const lowerMessage = message.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lowerMessage.includes(keyword)) {
        score += 1;
      }
    }
    scores[intent] = score;
  }

  const bestIntent = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  if (bestIntent && bestIntent[1] > 0) {
    const confidence = Math.min(0.8, bestIntent[1] / 5);
    logger.debug({ intent: bestIntent[0], confidence }, 'Intent classified by keywords');
    return {
      intent: bestIntent[0] as IntentCategory,
      confidence,
      reasoning: `Keyword match: found ${bestIntent[1]} matching keywords`,
    };
  }

  return {
    intent: IntentCategory.GENERAL,
    confidence: 0.3,
    reasoning: 'No keywords matched, defaulting to general',
  };
}
