import assert from 'node:assert/strict';
import { evaluateGrounding } from '../services/grounding-policy';
import { IntentCategory } from '../types/domain';

function testMissingEvidenceIsRefused(): void {
  const decision = evaluateGrounding({
    message: '你们支持哪些配送方式？',
    intent: IntentCategory.GENERAL,
    faqMatches: [],
    retrievalResults: [],
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'insufficient',
    groundingReason: 'no_evidence',
    shouldGenerate: false,
    shouldEscalate: false,
    citations: [],
  });
}

function testDirectFaqKeepsDeterministicAnswerMode(): void {
  const faq = {
    id: 'faq-1',
    question: '配送范围是什么？',
    answer: '目前支持中国大陆地区配送。',
    similarity: 0.9,
    source: 'hybrid' as const,
    keywordScore: 0.82,
  };
  const evidence = {
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  };

  const decision = evaluateGrounding({
    message: faq.question,
    intent: IntentCategory.GENERAL,
    faqMatches: [faq],
    retrievalResults: [evidence],
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'direct_faq',
    groundingStatus: 'sufficient',
    groundingReason: 'direct_faq_match',
    shouldGenerate: false,
    shouldEscalate: false,
    citations: [evidence],
  });
}

function testFaqAnswerSubstringDoesNotQualifyForDirectAnswer(): void {
  const faq = {
    id: 'faq-answer-substring',
    question: '退款审核需要多久？',
    answer: '退款申请会在三个工作日内完成审核。',
    similarity: 0.7,
    source: 'keyword' as const,
    keywordScore: 0.7,
  };
  const evidence = {
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  };

  const decision = evaluateGrounding({
    message: '三个工作日',
    intent: IntentCategory.REFUND,
    faqMatches: [faq],
    retrievalResults: [evidence],
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'grounded_generation');
  assert.equal(decision.groundingReason, 'retrieval_supported');
}

function testSharedGenericKeywordDoesNotChooseAnArbitraryDirectFaq(): void {
  const faqMatches = [
    {
      id: 'faq-refund-apply',
      question: '如何申请退款？',
      answer: '在订单页提交退款申请。',
      similarity: 0.9,
      source: 'keyword' as const,
      keywordScore: 0.9,
    },
    {
      id: 'faq-refund-time',
      question: '退款多久到账？',
      answer: '审核后原路退回。',
      similarity: 0.9,
      source: 'keyword' as const,
      keywordScore: 0.9,
    },
  ];
  const retrievalResults = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退款',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults,
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'grounded_generation');
  assert.equal(decision.groundingReason, 'retrieval_supported');
}

function testWeakEvidenceIsRefused(): void {
  const weakResult = {
    knowledgeType: 'document' as const,
    knowledgeId: 'chunk-weak',
    documentId: 'document-1',
    title: '配送政策.md',
    content: '历史配送说明。',
    similarity: 0.49,
    source: 'vector' as const,
    vectorScore: 0.49,
  };

  const decision = evaluateGrounding({
    message: '可以配送到火星吗？',
    intent: IntentCategory.GENERAL,
    faqMatches: [],
    retrievalResults: [weakResult],
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'insufficient',
    groundingReason: 'weak_evidence',
    shouldGenerate: false,
    shouldEscalate: false,
    citations: [weakResult],
  });
}

function testConflictingDirectFaqAnswersEscalate(): void {
  const faqMatches = [
    {
      id: 'faq-old',
      question: '退货期限是多少天？',
      answer: '签收后七天内可以申请退货。',
      similarity: 0.91,
      source: 'hybrid' as const,
      keywordScore: 0.88,
    },
    {
      id: 'faq-new',
      question: '退货期限是多少天',
      answer: '签收后十五天内可以申请退货。',
      similarity: 0.89,
      source: 'keyword' as const,
      keywordScore: 0.85,
    },
  ];
  const evidence = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退货期限是多少天？',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults: evidence,
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'conflicting',
    groundingReason: 'conflicting_direct_faq',
    shouldGenerate: false,
    shouldEscalate: true,
    citations: evidence,
  });
}

function testAliasQueryCannotBypassConflictingDirectFaqAnswers(): void {
  const faqMatches = [
    {
      id: 'faq-refund-arrival-old',
      question: '退款需要多久到账？',
      answer: '退款会在三个工作日内到账。',
      similarity: 0.91,
      source: 'hybrid' as const,
      keywordScore: 0.88,
    },
    {
      id: 'faq-refund-arrival-new',
      question: '退款需要多久到账',
      answer: '退款会在七个工作日内到账。',
      similarity: 0.89,
      source: 'keyword' as const,
      keywordScore: 0.85,
    },
  ];
  const evidence = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退款到账时间',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults: evidence,
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'refusal');
  assert.equal(decision.groundingStatus, 'conflicting');
  assert.equal(decision.shouldEscalate, true);
}

function testEquivalentDirectFaqAnswersDoNotConflict(): void {
  const faqMatches = [
    {
      id: 'faq-punctuation',
      question: '退货期限是多少天？',
      answer: '签收后七天内可以退货。',
      similarity: 0.91,
      source: 'hybrid' as const,
      keywordScore: 0.88,
    },
    {
      id: 'faq-whitespace',
      question: '退货期限是多少天',
      answer: '签收后 七天内可以退货',
      similarity: 0.89,
      source: 'keyword' as const,
      keywordScore: 0.85,
    },
  ];
  const evidence = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退货期限是多少天？',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults: evidence,
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'direct_faq');
  assert.equal(decision.groundingStatus, 'sufficient');
  assert.equal(decision.shouldEscalate, false);
}

function testThousandsSeparatorsDoNotCreateAnswerConflict(): void {
  const faqMatches = [
    {
      id: 'faq-limit-comma',
      question: '退款上限是多少？',
      answer: '退款上限为 1,000 元。',
      similarity: 0.91,
      source: 'hybrid' as const,
      keywordScore: 0.88,
    },
    {
      id: 'faq-limit-plain',
      question: '退款上限是多少',
      answer: '退款上限为1000元',
      similarity: 0.89,
      source: 'keyword' as const,
      keywordScore: 0.85,
    },
  ];
  const retrievalResults = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退款上限是多少？',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults,
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'direct_faq');
  assert.equal(decision.groundingStatus, 'sufficient');
}

function testNumericQuestionDifferencesDoNotCreateFalseConflict(): void {
  const faqMatches = [
    {
      id: 'faq-fee-decimal',
      question: '退款手续费是1.5%吗？',
      answer: '退款手续费是 1.5%。',
      similarity: 0.92,
      source: 'hybrid' as const,
      keywordScore: 0.9,
    },
    {
      id: 'faq-fee-integer',
      question: '退款手续费是15%吗？',
      answer: '退款手续费是 15%。',
      similarity: 0.9,
      source: 'keyword' as const,
      keywordScore: 0.89,
    },
  ];
  const retrievalResults = faqMatches.map((faq) => ({
    knowledgeType: 'faq' as const,
    knowledgeId: faq.id,
    title: faq.question,
    content: faq.answer,
    similarity: faq.similarity,
    source: faq.source,
    keywordScore: faq.keywordScore,
  }));

  const decision = evaluateGrounding({
    message: '退款手续费是1.5%吗？',
    intent: IntentCategory.REFUND,
    faqMatches,
    retrievalResults,
    explicitEscalation: false,
  });

  assert.equal(decision.answerMode, 'direct_faq');
  assert.equal(decision.groundingStatus, 'sufficient');
  assert.equal(decision.citations[0]?.knowledgeId, 'faq-fee-decimal');
}

function testLeadingDecimalQuestionKeepsItsNumericMeaning(): void {
  for (const decimal of ['-.5', '.5']) {
    const faqMatches = [
      {
        id: 'faq-fee-five',
        question: '退款手续费是5%吗？',
        answer: '退款手续费是 5%。',
        similarity: 0.92,
        source: 'hybrid' as const,
        keywordScore: 0.9,
      },
      {
        id: 'faq-fee-leading-decimal',
        question: `退款手续费是${decimal}%吗？`,
        answer: `退款手续费调整为 ${decimal}%。`,
        similarity: 0.91,
        source: 'keyword' as const,
        keywordScore: 0.9,
      },
    ];
    const retrievalResults = faqMatches.map((faq) => ({
      knowledgeType: 'faq' as const,
      knowledgeId: faq.id,
      title: faq.question,
      content: faq.answer,
      similarity: faq.similarity,
      source: faq.source,
      keywordScore: faq.keywordScore,
    }));

    const decision = evaluateGrounding({
      message: `退款手续费是${decimal}%吗？`,
      intent: IntentCategory.REFUND,
      faqMatches,
      retrievalResults,
      explicitEscalation: false,
    });

    assert.equal(decision.answerMode, 'direct_faq', decimal);
    assert.equal(decision.citations[0]?.knowledgeId, 'faq-fee-leading-decimal', decimal);
  }
}

function testNumericPolicyDifferencesRemainConflicting(): void {
  const answerPairs = [
    ['退款手续费为 1.5%。', '退款手续费为 15%。'],
    ['退款会在 7-15 天内完成。', '退款会在 715 天内完成。'],
    ['退款调整为 -100 元。', '退款调整为 100 元。'],
    ['退款手续费为 5%。', '退款手续费为 5 元。'],
  ];

  for (const [firstAnswer, secondAnswer] of answerPairs) {
    const faqMatches = [
      {
        id: 'faq-numeric-a',
        question: '退款时效和费用是什么？',
        answer: firstAnswer,
        similarity: 0.91,
        source: 'hybrid' as const,
        keywordScore: 0.9,
      },
      {
        id: 'faq-numeric-b',
        question: '退款时效和费用是什么',
        answer: secondAnswer,
        similarity: 0.9,
        source: 'keyword' as const,
        keywordScore: 0.88,
      },
    ];
    const retrievalResults = faqMatches.map((faq) => ({
      knowledgeType: 'faq' as const,
      knowledgeId: faq.id,
      title: faq.question,
      content: faq.answer,
      similarity: faq.similarity,
      source: faq.source,
      keywordScore: faq.keywordScore,
    }));
    const decision = evaluateGrounding({
      message: '退款时效和费用是什么？',
      intent: IntentCategory.REFUND,
      faqMatches,
      retrievalResults,
      explicitEscalation: false,
    });
    assert.equal(decision.groundingStatus, 'conflicting', `${firstAnswer} / ${secondAnswer}`);
  }
}

function testUnsupportedHighRiskActionIsRefusedAndEscalated(): void {
  const evidence = {
    knowledgeType: 'faq' as const,
    knowledgeId: 'faq-refund',
    title: '退款政策',
    content: '符合条件的订单可以申请退款。',
    similarity: 0.9,
    source: 'hybrid' as const,
    keywordScore: 0.8,
  };

  const decision = evaluateGrounding({
    message: '请直接帮我取消订单 12345 并退款',
    intent: IntentCategory.REFUND,
    faqMatches: [{
      id: evidence.knowledgeId,
      question: evidence.title,
      answer: evidence.content,
      similarity: evidence.similarity,
      source: evidence.source,
      keywordScore: evidence.keywordScore,
    }],
    retrievalResults: [evidence],
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'high_risk',
    groundingReason: 'unsupported_business_action',
    shouldGenerate: false,
    shouldEscalate: true,
    citations: [evidence],
  });
}

function testUnsupportedHighRiskActionEscalatesWithoutKnowledgeEvidence(): void {
  const decision = evaluateGrounding({
    message: '请直接帮我取消订单 12345 并退款',
    intent: IntentCategory.REFUND,
    faqMatches: [],
    retrievalResults: [],
    explicitEscalation: false,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'high_risk',
    groundingReason: 'unsupported_business_action',
    shouldGenerate: false,
    shouldEscalate: true,
    citations: [],
  });
}

function testPrivateBusinessStateAndActionRequestsEscalate(): void {
  const requests = [
    '请帮我查看账户余额',
    '帮我删除订单 12345',
    '我要退款',
    '麻烦取消我的订单',
    '帮我取消订单12345可以吗',
    '请帮我修改收货地址，可以吗',
    '怎么还没处理，帮我取消订单12345',
    '麻烦把我的订单取消掉',
    '请把订单12345取消',
    '不要帮我取消订单但是帮我修改收货地址',
    '我想了解退款政策然后帮我取消订单12345',
    '不要你帮我退款只要帮我取消订单12345',
    '请告诉我退款流程再帮我取消订单12345',
    '请告诉我退款流程并帮我取消订单12345',
    '不要取消订单而是修改我的收货地址',
    '我想了解退款政策并帮我取消订单12345',
    '我想了解退款政策并取消订单12345',
    '请告诉我退款流程，再取消订单12345',
    '帮我退钱',
    '给我退钱',
    '我要退钱',
    '直接退款',
    '请问我的订单状态？',
    '订单 12345 到哪了',
    '查一下订单12345',
    '帮我看下订单12345',
    'please look up my account balance',
    'Could you set my shipping address to 123 Main Street',
    'What is going on? Please cancel my order',
    "Don't cancel my order but change my address",
    'I want to know the refund policy then cancel my order',
    "Don't refund it but please cancel my order",
    'Can you tell me the refund process and then cancel my order?',
    'I want to know the refund policy and cancel my order',
    'Can you explain the refund process and cancel my order',
    'Can you explain the refund policy and cancel my order?',
    'I want to know how to request a refund and please cancel my order',
    'I want to know how to request a refund and can you cancel my order',
    'Please refund me',
    'Can you refund this?',
    'Could you issue a refund?',
    'Refund me',
    'Issue a refund',
    'Process a refund',
    'I want my order cancelled',
    'Can you find my order 12345',
    'Where is my order?',
    'What is my order status?',
    'What is my account balance?',
    'What is the status of order 12345?',
    'order #12345 status',
    'status of order 12345',
  ];

  for (const message of requests) {
    const decision = evaluateGrounding({
      message,
      intent: IntentCategory.ORDER,
      faqMatches: [],
      retrievalResults: [],
      explicitEscalation: false,
    });
    assert.equal(decision.groundingStatus, 'high_risk', message);
    assert.equal(decision.shouldEscalate, true, message);
  }
}

function testPolicyQuestionsAreNotEscalatedAsPrivateActions(): void {
  const evidence = {
    knowledgeType: 'document' as const,
    knowledgeId: 'policy-document',
    documentId: 'policy-document',
    title: '客服流程',
    content: '这里介绍订单、退款和物流查询流程。',
    similarity: 0.8,
    source: 'hybrid' as const,
    keywordScore: 0.75,
  };
  const questions = [
    '请问如何查询物流信息？',
    '如何查看账户余额？',
    '请问账户余额多久更新？',
    '请问账户余额可以提现吗？',
    '账户余额是什么？',
    '我想知道如何取消订单',
    '我想了解退款流程',
    '我想问怎么修改收货地址',
    '请告诉我怎么取消订单',
    '请说明如何修改收货地址',
    '我只是想了解退款政策，不是要你帮我退款',
    '别帮我取消订单，我只想问流程',
    '不用帮我取消订单，只想了解流程',
    '取消订单的流程是什么？',
    '取消订单需要什么条件？',
    '修改收货地址的步骤是什么？',
    '更改收货地址要怎么操作？',
    '签收后七天内可以申请退款',
    'How can I track my order?',
    'How can I see my account balance?',
    'How can I check my order status?',
    'How can I check the status of order 12345?',
    'I want to know how to cancel my order',
    'I need to know the refund process for my order',
    'Can you tell me how to cancel my order?',
    'Could you explain how to change my shipping address?',
    'What is the refund process for my order?',
    'How to cancel and refund my order?',
  ];

  for (const message of questions) {
    const decision = evaluateGrounding({
      message,
      intent: IntentCategory.GENERAL,
      faqMatches: [],
      retrievalResults: [evidence],
      explicitEscalation: false,
    });
    assert.equal(decision.answerMode, 'grounded_generation', message);
    assert.equal(decision.shouldEscalate, false, message);
  }
}

function testDirectActionWordingRemainsHighRisk(): void {
  const messages = [
    '我想申请退款',
    '我想取消订单 12345',
    'I want to cancel my order',
    'I need you to change my shipping address',
  ];

  for (const message of messages) {
    const decision = evaluateGrounding({
      message,
      intent: IntentCategory.ORDER,
      faqMatches: [],
      retrievalResults: [],
      explicitEscalation: false,
    });
    assert.equal(decision.groundingStatus, 'high_risk', message);
    assert.equal(decision.shouldEscalate, true, message);
  }
}

function testExplicitHumanRequestDoesNotGenerate(): void {
  const decision = evaluateGrounding({
    message: '请转人工客服',
    intent: IntentCategory.GENERAL,
    faqMatches: [],
    retrievalResults: [],
    explicitEscalation: true,
  });

  assert.deepEqual(decision, {
    answerMode: 'refusal',
    groundingStatus: 'escalated',
    groundingReason: 'user_requested_human',
    shouldGenerate: false,
    shouldEscalate: true,
    citations: [],
  });
}

testMissingEvidenceIsRefused();
testDirectFaqKeepsDeterministicAnswerMode();
testFaqAnswerSubstringDoesNotQualifyForDirectAnswer();
testSharedGenericKeywordDoesNotChooseAnArbitraryDirectFaq();
testWeakEvidenceIsRefused();
testConflictingDirectFaqAnswersEscalate();
testAliasQueryCannotBypassConflictingDirectFaqAnswers();
testEquivalentDirectFaqAnswersDoNotConflict();
testThousandsSeparatorsDoNotCreateAnswerConflict();
testNumericQuestionDifferencesDoNotCreateFalseConflict();
testLeadingDecimalQuestionKeepsItsNumericMeaning();
testNumericPolicyDifferencesRemainConflicting();
testUnsupportedHighRiskActionIsRefusedAndEscalated();
testUnsupportedHighRiskActionEscalatesWithoutKnowledgeEvidence();
testPrivateBusinessStateAndActionRequestsEscalate();
testPolicyQuestionsAreNotEscalatedAsPrivateActions();
testDirectActionWordingRemainsHighRisk();
testExplicitHumanRequestDoesNotGenerate();
console.log('grounding policy tests passed');
