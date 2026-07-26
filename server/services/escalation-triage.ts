import {
  EscalationCategory,
  EscalationEvidenceSource,
  EscalationPacket,
  EscalationPriority,
  EscalationQueue,
  EscalationReasonCode,
  EscalationRiskFlag,
  GroundingStatus,
  IntentCategory,
  Message,
  MessageRole,
} from '../types/domain';

export const ESCALATION_PACKET_SCHEMA_VERSION = 1;
export const ESCALATION_RULE_VERSION = 'triage_v1';

export interface BuildEscalationPacketInput {
  escalationId: string;
  sessionId: string;
  reason: string;
  intent?: IntentCategory | null;
  groundingStatus?: GroundingStatus | null;
  messages: Message[];
  now?: Date;
}

const patterns = {
  unauthorized: /非本人交易|未经授权|盗刷|unauthori[sz]ed (?:charge|transaction)|fraudulent charge/i,
  accountSecurity: /账号?被盗|账户?被盗|账号?异常|密码泄露|登录异常|hacked|account (?:was )?(?:stolen|compromised)|credential leak/i,
  safety: /人身安全|生命危险|立即危险|威胁我|immediate danger|physical safety|threatening me/i,
  complaint: /投诉|举报|消费者协会|消协|起诉|律师|complaint|report (?:you|this)|lawsuit|lawyer/i,
  materialComplaint: /严重投诉|重大投诉|起诉|律师|媒体曝光|major complaint|lawsuit|legal action/i,
  refund: /退款|退货|退钱|refund|return/i,
  order: /订单|物流|发货|配送|快递|order|shipping|delivery/i,
  technical: /报错|故障|无法使用|打不开|崩溃|technical|error|bug|crash|not working/i,
  explicitHuman: /转人工|人工客服|找人工|找客服|人工服务|human agent|live agent|representative|talk to (?:a )?human/i,
  frustration: /一直说|没用|听不懂|机器人|破系统|垃圾|useless|not listening|frustrated/i,
  privateOperation: /查询|查看|修改|取消|申请|处理|进度|状态|query|check|change|cancel|apply|process|status/i,
};

export function buildDeterministicEscalationPacket(
  input: BuildEscalationPacketInput,
): EscalationPacket {
  const userMessages = input.messages.filter((message) => message.role === MessageRole.USER);
  const combinedText = `${input.reason}\n${userMessages.map((message) => message.content).join('\n')}`;
  const category = determineCategory(combinedText, input.intent);
  const reasonCode = determineReasonCode(combinedText, input.groundingStatus);
  const riskFlags = determineRiskFlags(combinedText, input.groundingStatus);
  const priority = determinePriority(combinedText, riskFlags);
  const recommendedQueue = determineQueue(category);
  const createdAt = (input.now ?? new Date()).toISOString();
  const latestUserText = userMessages.at(-1)?.content.trim() ?? '';

  return {
    escalationId: input.escalationId,
    sessionId: input.sessionId,
    schemaVersion: ESCALATION_PACKET_SCHEMA_VERSION,
    ruleVersion: ESCALATION_RULE_VERSION,
    summary: buildSummary(input.reason, latestUserText),
    category,
    priority,
    reasonCode,
    reason: input.reason,
    riskFlags,
    confirmedFacts: userMessages.slice(-3).map((message) => ({
      label: 'customer_statement',
      value: message.content.trim().slice(0, 500),
      sourceMessageId: message.id,
      sourceExcerpt: message.content.trim().slice(0, 300),
    })).filter((fact) => Boolean(fact.value)),
    missingInformation: determineMissingInformation(category, riskFlags),
    evidenceSources: collectEvidenceSources(input.messages),
    recommendedQueue,
    suggestedNextStep: determineNextStep(recommendedQueue, priority),
    extractionMode: 'deterministic',
    createdAt,
    updatedAt: createdAt,
  };
}

function determineCategory(text: string, intent?: IntentCategory | null): EscalationCategory {
  if (patterns.accountSecurity.test(text) || patterns.unauthorized.test(text)) {
    return 'account_security';
  }
  if (patterns.complaint.test(text)) return 'complaint';
  if (intent) return intent;
  if (patterns.refund.test(text)) return IntentCategory.REFUND;
  if (patterns.order.test(text)) return IntentCategory.ORDER;
  if (patterns.technical.test(text)) return IntentCategory.TECHNICAL;
  return IntentCategory.GENERAL;
}

function determineReasonCode(
  text: string,
  groundingStatus?: GroundingStatus | null,
): EscalationReasonCode {
  if (patterns.unauthorized.test(text)) return 'unauthorized_transaction';
  if (patterns.accountSecurity.test(text)) return 'account_security';
  if (patterns.safety.test(text)) return 'safety_risk';
  if (groundingStatus === 'conflicting' || /知识库存在冲突|conflicting knowledge/i.test(text)) {
    return 'knowledge_conflict';
  }
  if (patterns.complaint.test(text)) return 'complaint';
  if (
    groundingStatus === 'high_risk'
    || /尚未授权的业务操作|私有状态|private (?:account|order|state)/i.test(text)
  ) {
    return 'unsupported_business_action';
  }
  if (patterns.explicitHuman.test(text)) return 'user_requested_human';
  if (patterns.frustration.test(text)) return 'frustration';
  if (/ESCALATE:|模型建议转人工|model requested/i.test(text)) return 'model_requested_escalation';
  return 'low_confidence_or_coverage_gap';
}

function determineRiskFlags(
  text: string,
  groundingStatus?: GroundingStatus | null,
): EscalationRiskFlag[] {
  const flags: EscalationRiskFlag[] = [];
  if (patterns.accountSecurity.test(text)) flags.push('account_security');
  if (patterns.unauthorized.test(text)) flags.push('unauthorized_transaction');
  if (patterns.safety.test(text)) flags.push('safety_risk');
  if (patterns.complaint.test(text)) flags.push('complaint');
  if (groundingStatus === 'conflicting' || /知识库存在冲突|conflicting knowledge/i.test(text)) {
    flags.push('knowledge_conflict');
  }
  if (
    groundingStatus === 'high_risk'
    || /尚未授权的业务操作|私有状态|private (?:account|order|state)/i.test(text)
  ) {
    flags.push('private_data_required', 'business_action_required');
  }
  if (groundingStatus === 'insufficient') flags.push('low_confidence');
  return [...new Set(flags)];
}

function determinePriority(
  text: string,
  riskFlags: EscalationRiskFlag[],
): EscalationPriority {
  if (
    riskFlags.includes('account_security')
    || riskFlags.includes('unauthorized_transaction')
    || riskFlags.includes('safety_risk')
  ) {
    return 'urgent';
  }
  if (
    riskFlags.includes('knowledge_conflict')
    || riskFlags.includes('private_data_required')
    || patterns.materialComplaint.test(text)
  ) {
    return 'high';
  }
  return 'normal';
}

function determineQueue(category: EscalationCategory): EscalationQueue {
  switch (category) {
    case 'account_security': return 'account_security';
    case 'complaint': return 'complaints';
    case IntentCategory.REFUND: return 'after_sales';
    case IntentCategory.ORDER: return 'order_support';
    case IntentCategory.TECHNICAL: return 'technical_support';
    case IntentCategory.GENERAL: return 'general_support';
    default: return 'manual_triage';
  }
}

function determineMissingInformation(
  category: EscalationCategory,
  riskFlags: EscalationRiskFlag[],
): string[] {
  if (category === 'account_security') {
    return ['identity_verification', 'affected_account', 'incident_time'];
  }
  if (category === IntentCategory.REFUND) return ['order_identifier', 'refund_reason'];
  if (category === IntentCategory.ORDER) return ['order_identifier'];
  if (category === IntentCategory.TECHNICAL) return ['device_or_environment', 'reproduction_steps'];
  if (category === 'complaint') return ['desired_resolution'];
  if (riskFlags.includes('private_data_required')) return ['authorized_identity_context'];
  return ['desired_resolution'];
}

function determineNextStep(queue: EscalationQueue, priority: EscalationPriority): string {
  const prefix = priority === 'urgent'
    ? 'Immediately review and secure the customer account'
    : priority === 'high'
      ? 'Prioritize human review and verify the cited evidence'
      : 'Review the conversation and collect missing information';
  return `${prefix}; route to ${queue}.`;
}

function buildSummary(reason: string, latestUserText: string): string {
  const cleanReason = reason.trim();
  const cleanUserText = latestUserText.trim();
  if (!cleanUserText || cleanUserText === cleanReason) return cleanReason.slice(0, 500);
  return `${cleanReason}: ${cleanUserText}`.slice(0, 500);
}

function collectEvidenceSources(messages: Message[]): EscalationEvidenceSource[] {
  const seen = new Set<string>();
  const sources: EscalationEvidenceSource[] = [];
  for (const message of messages) {
    for (const snapshot of message.retrievalSnapshot) {
      const key = `${snapshot.knowledgeType}:${snapshot.knowledgeId}:${snapshot.chunkIndex ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        knowledgeType: snapshot.knowledgeType,
        knowledgeId: snapshot.knowledgeId,
        documentId: snapshot.documentId,
        title: snapshot.title,
        similarity: snapshot.similarity,
        chunkIndex: snapshot.chunkIndex,
        pageStart: snapshot.pageStart,
        pageEnd: snapshot.pageEnd,
      });
    }
  }
  return sources.slice(0, 10);
}
