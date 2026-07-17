/**
 * Chat API client — SSE streaming and satisfaction rating.
 */

import { ApiError, get } from './client';
import { usePreferences } from '../hooks/usePreferences';
import type { ChatHistorySession, ConversationDetail, PaginationResponse } from '../types';

export interface FaqMatchDTO {
  id: string;
  question: string;
  answer: string;
  similarity: number;
  source?: 'vector' | 'keyword' | 'hybrid';
  vectorScore?: number;
  keywordScore?: number;
  fusionScore?: number;
  vectorRank?: number;
  keywordRank?: number;
}

/**
 * Generate or retrieve a stable anonymous user identifier.
 * Uses localStorage so chat history survives page refreshes on the same browser.
 */
function getAnonymousUserId(): string {
  try {
    let anonId = localStorage.getItem('anonymous_user_id');
    if (!anonId) {
      anonId = 'anon-' + crypto.randomUUID();
      localStorage.setItem('anonymous_user_id', anonId);
    }
    return anonId;
  } catch {
    return 'anon-' + crypto.randomUUID();
  }
}

function t(key: string, params?: Record<string, string | number>): string {
  return usePreferences.getState().t(key, params);
}

export interface SSECallbacks {
  onToken?: (token: string) => void;
  onIntent?: (intent: string, confidence: number) => void;
  onFaq?: (faqMatches: FaqMatchDTO[]) => void;
  onEscalate?: (reason: string) => void;
  onDone?: (data: { sessionId: string; messageId: string; intent: string }) => void;
  onError?: (message: string) => void;
}

export interface SendMessageResult {
  sessionId: string;
  messageId: string;
  intent: string;
  fullContent: string;
}

export type ChatHistoryResponse = PaginationResponse<ChatHistorySession>;
export type ChatHistoryDetail = ConversationDetail;

function getToken(): string | null {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

/**
 * Send a message to the chat API and consume the SSE stream.
 */
export async function sendMessage(
  message: string,
  sessionId: string | undefined,
  callbacks: SSECallbacks,
): Promise<SendMessageResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const body: Record<string, unknown> = { message, userIdent: getAnonymousUserId() };
  if (sessionId) {
    body.sessionId = sessionId;
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorMessage = t('chat.requestFailed');
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.message || errorMessage;
    } catch {
      // ignore parse error
    }
    callbacks.onError?.(errorMessage);
    throw new ApiError(response.status, response.status, errorMessage);
  }

  if (!response.body) {
    const errorMessage = t('chat.streamUnsupported');
    callbacks.onError?.(errorMessage);
    throw new ApiError(500, 500, errorMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let resultSessionId = sessionId || '';
  let resultMessageId = '';
  let resultIntent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            content: unknown;
            confidence?: number;
          };

          switch (event.type) {
            case 'token':
              fullContent += event.content as string;
              callbacks.onToken?.(event.content as string);
              break;
            case 'intent':
              callbacks.onIntent?.(event.content as string, event.confidence ?? 0);
              break;
            case 'faq':
              callbacks.onFaq?.(
                (event.content as FaqMatchDTO[]) || [],
              );
              break;
            case 'escalate':
              callbacks.onEscalate?.(event.content as string);
              break;
            case 'done': {
              const doneData = event.content as {
                sessionId: string;
                messageId: string;
                intent: string;
              };
              resultSessionId = doneData.sessionId;
              resultMessageId = doneData.messageId;
              resultIntent = doneData.intent;
              callbacks.onDone?.(doneData);
              break;
            }
            case 'error':
              callbacks.onError?.(event.content as string);
              break;
            default:
              break;
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    sessionId: resultSessionId,
    messageId: resultMessageId,
    intent: resultIntent,
    fullContent,
  };
}

/**
 * Submit satisfaction rating for a chat session.
 */
export async function submitRating(messageId: string, sessionId: string, rating: number): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/api/chat/satisfaction', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messageId, sessionId, rating }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, response.status, t('chat.satisfactionSubmitFailed'));
  }
}

export function getCurrentAnonymousUserId(): string {
  return getAnonymousUserId();
}

export async function getChatHistory(page: number = 1, pageSize: number = 20): Promise<ChatHistoryResponse> {
  return get<ChatHistoryResponse>('/chat/sessions', {
    userIdent: getAnonymousUserId(),
    page,
    pageSize,
  });
}

export async function getChatHistoryDetail(sessionId: string): Promise<ChatHistoryDetail> {
  return get<ChatHistoryDetail>(`/chat/sessions/${sessionId}`, {
    userIdent: getAnonymousUserId(),
  });
}
