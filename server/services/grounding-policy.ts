import { FaqMatch, RetrievalResult } from '../types/ai';
import { AnswerMode, GroundingStatus, IntentCategory } from '../types/domain';

export const DIRECT_FAQ_KEYWORD_THRESHOLD = 0.8;

export interface GroundingDecision {
  answerMode: AnswerMode;
  groundingStatus: GroundingStatus;
  groundingReason: string;
  shouldGenerate: boolean;
  shouldEscalate: boolean;
  citations: RetrievalResult[];
}

export function evaluateGrounding(params: {
  message: string;
  intent: IntentCategory;
  faqMatches: FaqMatch[];
  retrievalResults: RetrievalResult[];
  explicitEscalation: boolean;
}): GroundingDecision {
  if (params.explicitEscalation) {
    return {
      answerMode: 'refusal',
      groundingStatus: 'escalated',
      groundingReason: 'user_requested_human',
      shouldGenerate: false,
      shouldEscalate: true,
      citations: [],
    };
  }

  if (requestsUnsupportedBusinessAction(params.message)) {
    return {
      answerMode: 'refusal',
      groundingStatus: 'high_risk',
      groundingReason: 'unsupported_business_action',
      shouldGenerate: false,
      shouldEscalate: true,
      citations: params.retrievalResults.slice(0, 3),
    };
  }

  if (params.retrievalResults.length === 0) {
    return {
      answerMode: 'refusal',
      groundingStatus: 'insufficient',
      groundingReason: 'no_evidence',
      shouldGenerate: false,
      shouldEscalate: false,
      citations: [],
    };
  }

  const eligibleDirectFaqs = params.faqMatches.filter(isDirectFaqCandidate);
  const conflictingFaqIds = findConflictingFaqIds(eligibleDirectFaqs);
  if (conflictingFaqIds.size > 0) {
    return {
      answerMode: 'refusal',
      groundingStatus: 'conflicting',
      groundingReason: 'conflicting_direct_faq',
      shouldGenerate: false,
      shouldEscalate: true,
      citations: params.retrievalResults.filter((result) => (
        result.knowledgeType === 'faq' && conflictingFaqIds.has(result.knowledgeId)
      )).slice(0, 3),
    };
  }

  const directFaq = selectDirectFaqCandidates(params.message, eligibleDirectFaqs)[0];
  if (directFaq) {
    return {
      answerMode: 'direct_faq',
      groundingStatus: 'sufficient',
      groundingReason: 'direct_faq_match',
      shouldGenerate: false,
      shouldEscalate: false,
      citations: params.retrievalResults.filter((result) => (
        result.knowledgeType === 'faq' && result.knowledgeId === directFaq.id
      )).slice(0, 1),
    };
  }

  const topResult = params.retrievalResults[0];
  const topEvidenceScore = Math.max(
    topResult.keywordScore ?? 0,
    topResult.vectorScore ?? 0,
    topResult.similarity,
  );
  if (topEvidenceScore < 0.55) {
    return {
      answerMode: 'refusal',
      groundingStatus: 'insufficient',
      groundingReason: 'weak_evidence',
      shouldGenerate: false,
      shouldEscalate: false,
      citations: params.retrievalResults.slice(0, 3),
    };
  }

  return {
    answerMode: 'grounded_generation',
    groundingStatus: 'sufficient',
    groundingReason: 'retrieval_supported',
    shouldGenerate: true,
    shouldEscalate: false,
    citations: params.retrievalResults.slice(0, 3),
  };
}

export function deterministicGroundingReply(reason: string): string {
  switch (reason) {
    case 'user_requested_human':
      return '已为你记录转人工请求，请稍候由人工客服继续处理。';
    case 'unsupported_business_action':
      return '为了保护你的账户和交易安全，我不能直接执行该操作，已为你转接人工客服处理。';
    case 'conflicting_direct_faq':
      return '知识库中存在相互冲突的答案，我暂时无法给出可靠结论，已为你转接人工客服核实。';
    case 'weak_evidence':
      return '现有知识与这个问题的匹配度不足，我暂时无法给出可靠答案。你可以补充更多信息，或联系人工客服。';
    default:
      return '当前知识库没有足够依据回答这个问题。你可以补充更多信息，或联系人工客服。';
  }
}

function findConflictingFaqIds(matches: FaqMatch[]): Set<string> {
  const groups = new Map<string, FaqMatch[]>();
  for (const match of matches) {
    const questionKey = normalizeQuestion(match.question);
    const group = groups.get(questionKey) ?? [];
    group.push(match);
    groups.set(questionKey, group);
  }

  for (const group of groups.values()) {
    const answers = new Set(group.map((match) => normalizeComparableText(match.answer)));
    if (group.length > 1 && answers.size > 1) {
      return new Set(group.map((match) => match.id));
    }
  }
  return new Set();
}

function normalizeQuestion(value: string): string {
  return normalizeComparableText(value);
}

function requestsUnsupportedBusinessAction(message: string): boolean {
  const normalized = message.normalize('NFKC').trim().toLowerCase();
  const clauses = normalized
    .split(/[，,。.!！?？;；]+|(?:但是|但|不过|然后|只要|而是)|(?:再|并且|并|以及)(?=(?:帮我|替我|给我|请|麻烦|我要|我想|能不能|可以帮我))|\b(?:but|and\s+then|then|instead)\b/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap(splitChineseActionConnector)
    .flatMap(splitEnglishActionConnector);
  return clauses.some((clause) => (
    requestsChineseBusinessAction(clause) || requestsEnglishBusinessAction(clause)
  ));
}

export function isDirectFaqCandidate(match: FaqMatch): boolean {
  return (match.source === 'keyword' || match.source === 'hybrid')
    && (match.keywordScore ?? match.similarity) >= DIRECT_FAQ_KEYWORD_THRESHOLD;
}

export function selectDirectFaqCandidates(message: string, matches: FaqMatch[]): FaqMatch[] {
  const scored = matches.filter(isDirectFaqCandidate);
  const normalizedMessage = normalizeQuestion(message);
  const exactQuestionMatches = scored.filter(
    (match) => normalizeQuestion(match.question) === normalizedMessage,
  );
  if (exactQuestionMatches.length > 0) return exactQuestionMatches;
  return scored.length === 1 ? scored : [];
}

function normalizeComparableText(value: string): string {
  const compact = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{Z}]+/gu, '')
    .replace(/\d{1,3}(?:,\d{3})+/g, (number) => number.replace(/,/g, ''));
  const characters = Array.from(compact);
  return characters.filter((character, index) => {
    if (!/\p{P}/u.test(character)) return true;
    if (character === '%') return true;
    const previousIsNumber = /\p{N}/u.test(characters[index - 1] ?? '');
    const nextIsNumber = /\p{N}/u.test(characters[index + 1] ?? '');
    const nextIsLeadingDecimal = characters[index + 1] === '.'
      && /\p{N}/u.test(characters[index + 2] ?? '');
    const isNumericSign = /[-−]/u.test(character) && (nextIsNumber || nextIsLeadingDecimal);
    const isDecimalPoint = character === '.' && nextIsNumber;
    return (previousIsNumber && nextIsNumber) || isNumericSign || isDecimalPoint;
  }).join('');
}

function requestsChineseBusinessAction(clause: string): boolean {
  if (isChineseNegatedExecution(clause)) return false;

  if (isChineseInformationalRequest(clause)) return false;

  const requestPrefix = /(?:帮我|替我|给我|麻烦(?:帮我)?|^请(?!问)(?:直接|帮我|替我|给我)?|我要|我想(?:要)?|能不能帮我|可以帮我)/;
  const mutation = /(?:(?:申请|办理|发起|直接)?(?:退款|退货|退钱)|(?:取消|删除)(?:我的?)?订单|(?:我的?)?订单(?:\s*(?:号|编号)?\s*[a-z0-9-]*\d[a-z0-9-]*)?.{0,8}(?:取消|删除)|(?:修改|更改|把).{0,10}(?:收货)?地址|(?:收货)?地址.{0,8}改成)/;
  const privateRead = /(?:(?:查询|查看|看(?:下|一下)?|查(?:下|一下)?|获取|追踪|跟踪).{0,12}(?:我的?)?(?:订单|物流|账户|余额)|(?:我的?)?(?:订单|物流|账户|余额).{0,12}(?:查询|查看|看(?:下|一下)?|查(?:下|一下)?|获取|追踪|跟踪))/;
  if (requestPrefix.test(clause) && (mutation.test(clause) || privateRead.test(clause))) {
    return true;
  }

  const policyQuestion = /(?:如何|怎样|怎么(?:申请|办理|操作|查询|查看|追踪|跟踪|取消|修改|更改)?|多久(?:更新|到账|处理)?|流程|政策|规则|条件|步骤|指南|说明|是什么|可以提现吗|是否支持|能否|可以吗)/;
  if (policyQuestion.test(clause)) return false;

  const directImperativeMutation = /^(?:再)?(?:(?:取消|删除).{0,12}订单|(?:修改|更改).{0,12}(?:收货)?地址|直接(?:退款|退货|退钱))(?:$|吧|一下|[a-z0-9])/i;
  if (directImperativeMutation.test(clause)) return true;

  return /(?:(?:我的?订单|订单\s*(?:号|编号)?\s*[a-z0-9-]*\d[a-z0-9-]*).{0,10}(?:还没到|到哪(?:里|了)?|状态|进度)|(?:查(?:下|一下)?|看(?:下|一下)?|查询|查看|追踪|跟踪).{0,8}订单\s*(?:号|编号)?\s*[a-z0-9-]*\d[a-z0-9-]*|我的?(?:账户余额|物流).{0,8}(?:多少|到哪(?:里|了)?|状态|进度)|物流(?:单号|编号)\s*[a-z0-9-]*\d[a-z0-9-]*)/i.test(clause);
}

function requestsEnglishBusinessAction(clause: string): boolean {
  if (isEnglishNegatedExecution(clause)) return false;

  if (isEnglishInformationalRequest(clause)) return false;

  const requestPrefix = /\b(?:please|can you|could you|would you|i want(?: to)?|i need(?: you to)?|help me)\b/;
  const action = /\b(?:cancel|delete|refund|change|update|set|look up|check|track|find|get|show)\b.{0,40}\b(?:order|address|shipment|account|balance)\b|\b(?:my|our)\s+(?:order|address|shipment|account)\b.{0,24}\b(?:cancelled|deleted|refunded|changed|updated)\b|\brefund\b.{0,12}\b(?:me|this|it)\b|\b(?:issue|process)\b.{0,8}\ba refund\b|\b(?:want|need)\s+(?:a\s+)?refund\b/;
  if (requestPrefix.test(clause) && action.test(clause)) return true;

  const directImperativeRefund = /^(?:refund (?:me|this|it)|(?:issue|process) a refund)(?:\s+(?:please|now))?$/;
  if (directImperativeRefund.test(clause)) return true;

  const selfHelpQuestion = /^how (?:(?:can|do) i|to)\b/;
  if (selfHelpQuestion.test(clause)) return false;

  const directPrivateState = /\b(?:where (?:is|are) (?:my|our) (?:order|shipment)|what (?:is|'s) (?:my|our) (?:order status|account balance)|what (?:is|'s) the status of order\s*(?:#|id|number)?\s*[a-z0-9-]*\d[a-z0-9-]*|(?:my|our) (?:order|shipment) status|status of (?:my|our) (?:order|shipment)|(?:my|our) account balance|order\s*(?:#|id|number)?\s*[a-z0-9-]*\d[a-z0-9-]*\s*status|status of order\s*(?:#|id|number)?\s*[a-z0-9-]*\d[a-z0-9-]*)\b/;
  if (directPrivateState.test(clause)) return true;

  const policyQuestion = /\b(?:how to|what (?:is|'s|are)|process|policy|rules?|steps?|guide|eligib)/;
  if (policyQuestion.test(clause)) return false;

  const concreteTarget = /\b(?:my|our)\s+(?:order|address|shipment|account|balance)\b|\b(?:order|tracking)\s*(?:#|id|number)?\s*[a-z0-9-]*\d[a-z0-9-]*\b/;
  return action.test(clause) && concreteTarget.test(clause);
}

function splitEnglishActionConnector(clause: string): string[] {
  if (!isEnglishNegatedExecution(clause) && !isEnglishInformationalRequest(clause)) {
    return [clause];
  }
  const explicitActionParts = clause
    .split(/\band\b(?=\s*(?:please|can you|could you|would you|help me)\s+(?:cancel|delete|refund|change|update|set|look up|check|track|find|get|show|issue|process)\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicitActionParts.length > 1) {
    return explicitActionParts;
  }
  if (/\b(?:how to|how can i|how do i)\b/.test(clause)) {
    return [clause];
  }
  return clause
    .split(/\band\b(?=\s*(?:please\s+)?(?:cancel|delete|refund|change|update|set|look up|check|track|find|get|show|issue|process)\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitChineseActionConnector(clause: string): string[] {
  if (!isChineseNegatedExecution(clause) && !isChineseInformationalRequest(clause)) {
    return [clause];
  }
  if (/(?:如何|怎么)/.test(clause)) {
    return [clause];
  }
  return clause
    .split(/(?:再|并且|并|以及)(?=(?:(?:取消|删除).{0,12}订单|(?:修改|更改).{0,12}(?:收货)?地址|直接(?:退款|退货|退钱)))/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isChineseNegatedExecution(clause: string): boolean {
  return /(?:不是|并非|不需要|不要|无需|不用|别).{0,8}(?:要)?(?:你)?(?:帮我|替我|给我)/.test(clause);
}

function isChineseInformationalRequest(clause: string): boolean {
  return /(?:(?:我)?(?:只是)?(?:想(?:要)?|需要).{0,6}(?:知道|了解|问|咨询).{0,20}(?:如何|怎么|流程|政策|规则|条件|步骤|指南|说明)|^(?:请|麻烦)(?:帮我)?(?:告诉我|说明|解释).{0,20}(?:如何|怎么|流程|政策|规则|条件|步骤|指南))/.test(clause);
}

function isEnglishNegatedExecution(clause: string): boolean {
  return /\b(?:do not|don't|not|never)\b.{0,24}\b(?:cancel|delete|refund|change|update|set)\b/.test(clause);
}

function isEnglishInformationalRequest(clause: string): boolean {
  return /\b(?:want|need) to (?:know|learn|understand|ask)\b.{0,48}\b(?:how|process|policy|rules?|steps?)\b|^(?:please\s+)?(?:can|could|would) you (?:tell me|explain)\b.{0,48}\b(?:how|process|policy|rules?|steps?)\b/.test(clause);
}
