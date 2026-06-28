/**
 * Chat API client — SSE streaming and satisfaction rating.
 */

import { ApiError } from './client';

/**
 * Generate or retrieve a stable anonymous user identifier.
 * Uses sessionStorage so it persists for the tab's lifetime
 * but is unique per browser tab (not shared across NAT).
 */
function getAnonymousUserId(): string {
  try {
    let anonId = sessionStorage.getItem('anonymous_user_id');
    if (!anonId) {
      anonId = 'anon-' + crypto.randomUUID();
      sessionStorage.setItem('anonymous_user_id', anonId);
    }
    return anonId;
  } catch {
    return 'anon-' + crypto.randomUUID();
  }
}

export interface SSECallbacks {
  onToken?: (token: string) => void;
  onIntent?: (intent: string, confidence: number) => void;
  onFaq?: (faqMatches: Array<{ id: string; question: string; answer: string; similarity: number }>) => void;
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
    let errorMessage = '请求失败';
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
    callbacks.onError?.('浏览器不支持流式响应');
    throw new ApiError(500, 500, '浏览器不支持流式响应');
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
                (event.content as Array<{
                  id: string;
                  question: string;
                  answer: string;
                  similarity: number;
                }>) || [],
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
export async function submitRating(sessionId: string, rating: number): Promise<void> {
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
    body: JSON.stringify({ sessionId, rating }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, response.status, '提交评分失败');
  }
}
