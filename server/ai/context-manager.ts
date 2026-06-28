import { LLMMessage } from '../types/ai';
import { getLLMClient } from './llm-client';
import { logger } from '../utils/logger';

const MAX_CONTEXT_TOKENS = 4000;
const RECENT_ROUNDS = 3;
const SUMMARY_PROMPT = `请用中文简要总结以下对话的关键内容和当前状态。保持简洁，不超过150字。

对话：
{conversation}

总结：`;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function formatMessagesForSummary(messages: LLMMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '客服' : '系统'}: ${m.content}`)
    .join('\n');
}

export async function getWindow(
  messages: LLMMessage[],
  maxTokens: number = MAX_CONTEXT_TOKENS,
): Promise<LLMMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  // Separate user/assistant messages from system messages
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  if (conversationMessages.length === 0) {
    return systemMessages;
  }

  // Keep most recent N rounds
  const rounds: Array<{ user?: LLMMessage; assistant?: LLMMessage }> = [];
  let currentRound: { user?: LLMMessage; assistant?: LLMMessage } = {};

  for (const msg of conversationMessages) {
    if (msg.role === 'user') {
      if (currentRound.user || currentRound.assistant) {
        rounds.push(currentRound);
        currentRound = {};
      }
      currentRound.user = msg;
    } else if (msg.role === 'assistant') {
      currentRound.assistant = msg;
    }
  }
  if (currentRound.user || currentRound.assistant) {
    rounds.push(currentRound);
  }

  const recentRounds = rounds.slice(-RECENT_ROUNDS);
  const olderRounds = rounds.slice(0, -RECENT_ROUNDS);

  let windowMessages: LLMMessage[] = [];

  // If there are older rounds, summarize them
  if (olderRounds.length > 0) {
    const olderMessages: LLMMessage[] = [];
    for (const round of olderRounds) {
      if (round.user) olderMessages.push(round.user);
      if (round.assistant) olderMessages.push(round.assistant);
    }

    try {
      const llmClient = getLLMClient();
      const conversationText = formatMessagesForSummary(olderMessages);
      const summaryPrompt = SUMMARY_PROMPT.replace('{conversation}', conversationText);
      const summary = await llmClient.chat([{ role: 'user', content: summaryPrompt }], {
        temperature: 0.3,
        maxTokens: 300,
      });

      windowMessages.push({
        role: 'system',
        content: `[历史对话摘要] ${summary.trim()}`,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to summarize conversation, including raw messages');
      // Fallback: include the last message from older rounds
      const lastOlder = olderMessages[olderMessages.length - 1];
      if (lastOlder) {
        windowMessages.push(lastOlder);
      }
    }
  }

  // Add recent rounds
  for (const round of recentRounds) {
    if (round.user) windowMessages.push(round.user);
    if (round.assistant) windowMessages.push(round.assistant);
  }

  // Token budget check
  let totalTokens = 0;
  for (const msg of [...systemMessages, ...windowMessages]) {
    totalTokens += estimateTokens(msg.content);
  }

  while (totalTokens > maxTokens && windowMessages.length > 0) {
    const removed = windowMessages.shift();
    if (removed) {
      totalTokens -= estimateTokens(removed.content);
    }
  }

  return [...systemMessages, ...windowMessages];
}

export function estimateTotalTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
