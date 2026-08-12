import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function main(): void {
  const api = source('client/src/api/chat.ts');
  const hook = source('client/src/hooks/useChat.ts');
  const bubble = `${source('client/src/components/chat/ChatBubble.tsx')}\n${source('client/src/components/chat/OrderToolCard.tsx')}`;
  const admin = source('client/src/pages/admin/ConversationsPage.tsx');
  const adminRoute = source('server/routes/admin/conversations.ts');
  const dictionary = JSON.parse(source('client/src/i18n/dictionary.json')) as Record<
    string,
    { zh?: string; en?: string }
  >;

  assert.match(api, /onTool/, 'chat SSE client should expose tool events');
  assert.match(api, /verifyOrder/, 'chat API should verify an order');
  assert.match(api, /lookupOrder/, 'chat API should execute authorized lookup');
  assert.match(hook, /orderTool/, 'transient order state should live in the current message');
  assert.match(hook, /verifyAndLookupOrder/, 'chat state should own the verification workflow');
  assert.match(bubble, /order-verification-card/, 'assistant bubble should render verification UI');
  assert.match(bubble, /order-result-card/, 'assistant bubble should render sanitized results');
  assert.match(adminRoute, /toolExecutions/, 'admin conversation detail should include tool audit');
  assert.match(admin, /conversation-tool-executions/, 'existing detail dialog should render tool audit');

  for (const key of [
    'chat.orderTool.verifyTitle',
    'chat.orderTool.useDemo',
    'chat.orderTool.retry',
    'chat.orderTool.transfer',
    'chat.orderTool.grantExpired',
    'chat.orderTool.rateLimited',
    'chat.orderTool.resultTitle',
    'conversations.toolExecutions',
    'conversations.toolDuration',
  ]) {
    assert.ok(dictionary[key]?.zh, `${key} should include Chinese copy`);
    assert.ok(dictionary[key]?.en, `${key} should include English copy`);
  }
  console.log('Order tool UI contract checks passed');
}

main();
