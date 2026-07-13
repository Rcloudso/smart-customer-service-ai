import { classify } from '../ai/intent-classifier';
import { knowledgeRetriever } from '../ai/knowledge-system';
import { IntentResult, FaqMatch, LLMMessage, RetrievalResult } from '../types/ai';
import { IntentCategory } from '../types/domain';
import { logger } from '../utils/logger';

const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const LOW_CONFIDENCE_THRESHOLD = 0.4;

export interface IntentProcessingResult {
  intent: IntentResult;
  faqMatches: FaqMatch[];
  retrievalResults: RetrievalResult[];
  needsEscalation: boolean;
  escalationReason: string | null;
  escalationType: 'explicit' | 'low_confidence' | null;
}

export class IntentService {
  async processMessage(
    message: string,
    history: LLMMessage[] = [],
  ): Promise<IntentProcessingResult> {
    // Step 1: Classify intent
    const intent = await classify(message, history);

    // Step 2: Search FAQ based on intent
    let faqMatches: FaqMatch[] = [];
    let retrievalResults: RetrievalResult[] = [];
    let needsEscalation = false;
    let escalationReason: string | null = null;
    let escalationType: IntentProcessingResult['escalationType'] = null;

    if (intent.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      // High confidence: search FAQ by category + semantics
      retrievalResults = await knowledgeRetriever.search(message, 5);
    } else if (intent.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      // Medium confidence: semantic search only
      retrievalResults = await knowledgeRetriever.search(message, 3);
    } else {
      // Low confidence: flag for escalation
      retrievalResults = await knowledgeRetriever.search(message, 3);
      if (retrievalResults.length === 0 || retrievalResults[0].similarity < 0.5) {
        needsEscalation = true;
        escalationReason = '意图置信度低且无匹配FAQ，建议转人工';
        escalationType = 'low_confidence';
      }
    }

    faqMatches = retrievalResults
      .filter((result) => result.knowledgeType === 'faq')
      .map((result) => ({
        id: result.knowledgeId,
        question: result.title,
        answer: result.content,
        similarity: result.similarity,
        source: result.source,
        vectorScore: result.vectorScore,
        keywordScore: result.keywordScore,
      }));

    // Step 3: Check for explicit escalation request
    const escalationKeywords = ['转人工', '人工客服', '找人工', '找客服', '人工服务'];
    const hasEscalationKeyword = escalationKeywords.some((kw) => message.includes(kw));
    if (hasEscalationKeyword) {
      needsEscalation = true;
      escalationReason = '用户明确要求转人工客服';
      escalationType = 'explicit';
    }

    logger.debug(
      {
        intent: intent.intent,
        confidence: intent.confidence,
        faqCount: faqMatches.length,
        needsEscalation,
      },
      'Intent processing completed',
    );

    return {
      intent,
      faqMatches,
      retrievalResults,
      needsEscalation,
      escalationReason,
      escalationType,
    };
  }
}

export const intentService = new IntentService();
