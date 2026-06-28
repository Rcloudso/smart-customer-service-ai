import { getLLMClient } from './llm-client';
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

export async function classify(message: string, history: LLMMessage[] = []): Promise<IntentResult> {
  try {
    const llmClient = getLLMClient();

    // Note: history already includes the current user message (saved by chat.ts before
    // calling this), so we slice(-5) to get the last 4 history entries plus current.
    const messages: LLMMessage[] = [
      { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
      ...history.slice(-5),
    ];

    const response = await llmClient.chat(messages, {
      temperature: 0.1,
      maxTokens: 200,
      responseFormat: 'json_object',
    });

    const parsed = JSON.parse(response) as {
      intent: string;
      confidence: number;
      reasoning: string;
    };

    // Validate intent category
    const validIntents = Object.values(IntentCategory);
    const intent = validIntents.includes(parsed.intent as IntentCategory)
      ? (parsed.intent as IntentCategory)
      : IntentCategory.GENERAL;

    const confidence = Math.min(1, Math.max(0, parsed.confidence));

    logger.debug({ intent, confidence, message: message.slice(0, 50) }, 'Intent classified by LLM');

    return {
      intent,
      confidence,
      reasoning: parsed.reasoning || 'Classified by LLM',
    };
  } catch (err) {
    logger.warn({ err, message: message.slice(0, 50) }, 'LLM intent classification failed, using keyword fallback');
    return keywordFallback(message);
  }
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
