import assert from 'node:assert/strict';
import { config } from '../config';
import { getLLMClient } from '../ai/llm-client';
import { classify } from '../ai/intent-classifier';
import { IntentCategory } from '../types/domain';

async function testJsonSchemaIsPreferred(): Promise<void> {
  const client = getLLMClient();
  const originalChat = client.chat;
  const formats: string[] = [];

  client.chat = async (_messages, options) => {
    formats.push(options?.responseFormat ?? 'text');
    return JSON.stringify({
      intent: IntentCategory.ORDER,
      confidence: 0.91,
      reasoning: '用户询问订单状态',
    });
  };

  try {
    const result = await classify('我的订单到哪里了？');
    assert.equal(result.intent, IntentCategory.ORDER);
    assert.equal(result.confidence, 0.91);
    assert.deepEqual(formats, ['json_schema']);
  } finally {
    client.chat = originalChat;
  }
}

async function testJsonObjectIsSecondChoice(): Promise<void> {
  const client = getLLMClient();
  const originalChat = client.chat;
  const formats: string[] = [];

  client.chat = async (_messages, options) => {
    const format = options?.responseFormat ?? 'text';
    formats.push(format);
    if (format === 'json_schema') {
      throw new Error('json_schema is not supported');
    }
    return JSON.stringify({
      intent: IntentCategory.REFUND,
      confidence: 0.87,
      reasoning: '用户申请退款',
    });
  };

  try {
    const result = await classify('我要申请退款');
    assert.equal(result.intent, IntentCategory.REFUND);
    assert.equal(result.confidence, 0.87);
    assert.deepEqual(formats, ['json_schema', 'json_object']);
  } finally {
    client.chat = originalChat;
  }
}

async function testPlainTextJsonIsFinalLlmChoice(): Promise<void> {
  const client = getLLMClient();
  const originalChat = client.chat;
  const formats: string[] = [];

  client.chat = async (_messages, options) => {
    const format = options?.responseFormat ?? 'text';
    formats.push(format);
    if (format !== 'text') {
      throw new Error(`${format} is not supported`);
    }
    return `以下是分类结果：
\`\`\`json
{"intent":"technical","confidence":0.76,"reasoning":"用户反馈页面打不开"}
\`\`\``;
  };

  try {
    const result = await classify('页面打不开');
    assert.equal(result.intent, IntentCategory.TECHNICAL);
    assert.equal(result.confidence, 0.76);
    assert.deepEqual(formats, ['json_schema', 'json_object', 'text']);
  } finally {
    client.chat = originalChat;
  }
}

async function testKeywordsRemainLastResort(): Promise<void> {
  const client = getLLMClient();
  const originalChat = client.chat;
  const formats: string[] = [];

  client.chat = async (_messages, options) => {
    formats.push(options?.responseFormat ?? 'text');
    throw new Error('simulated provider failure');
  };

  try {
    const result = await classify('退款什么时候到账');
    assert.equal(result.intent, IntentCategory.REFUND);
    assert.equal(result.reasoning, 'Keyword match: found 1 matching keywords');
    assert.deepEqual(formats, ['json_schema', 'json_object', 'text']);
  } finally {
    client.chat = originalChat;
  }
}

async function testNoKeySkipsFormatNegotiation(): Promise<void> {
  const originalApiKey = config.llm.apiKey;
  config.llm.apiKey = '';
  const client = getLLMClient();
  const originalChat = client.chat;
  let chatCalled = false;

  client.chat = async () => {
    chatCalled = true;
    throw new Error('no-key mode must not call chat');
  };

  try {
    const result = await classify('我要申请退款');
    assert.equal(result.intent, IntentCategory.REFUND);
    assert.equal(chatCalled, false);
  } finally {
    client.chat = originalChat;
    config.llm.apiKey = originalApiKey;
  }
}

async function main(): Promise<void> {
  const originalApiKey = config.llm.apiKey;
  config.llm.apiKey = 'intent-classifier-test-key';
  try {
    await testJsonSchemaIsPreferred();
    await testJsonObjectIsSecondChoice();
    await testPlainTextJsonIsFinalLlmChoice();
    await testKeywordsRemainLastResort();
  } finally {
    config.llm.apiKey = originalApiKey;
  }
  await testNoKeySkipsFormatNegotiation();
  console.log('Intent classifier compatibility checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
