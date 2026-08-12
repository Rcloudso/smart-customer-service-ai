import { create } from 'zustand';
import * as chatApi from '../api/chat';
import { usePreferences } from './usePreferences';
import type { ChatHistoryDetail } from '../api/chat';
import type { OrderStatusResultDTO, OrderToolEvent } from '../api/chat';
import { ApiError } from '../api/client';
import {
  AnswerMode,
  GroundingStatus,
  KnowledgeRetrievalSnapshot,
  MessageRole,
} from '../types';

export interface ChatFaqMatch {
  id: string;
  question: string;
  answer: string;
  similarity: number;
  source?: 'vector' | 'keyword' | 'hybrid';
  vectorScore?: number;
  keywordScore?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent?: string | null;
  intentConf?: number | null;
  faqMatches?: ChatFaqMatch[];
  knowledgeSources?: KnowledgeRetrievalSnapshot[];
  answerMode?: AnswerMode | null;
  groundingStatus?: GroundingStatus | null;
  groundingReason?: string | null;
  retrievalPolicyId?: string | null;
  satisfaction?: number | null;
  failed?: boolean;
  isStreaming?: boolean;
  orderTool?: OrderToolViewState;
}

export type OrderToolViewStatus =
  | 'verification_required'
  | 'verifying'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface OrderToolViewState {
  status: OrderToolViewStatus;
  maskedOrderReference?: string | null;
  orderReference?: string;
  demoAvailable?: boolean;
  demoSample?: { orderReference: string; verificationCode: string };
  expiresAt?: string;
  executionId?: string;
  result?: OrderStatusResultDTO;
  localizedText?: { zh: string; en: string };
  error?: string;
  failureStage?: 'verify' | 'lookup';
  safeErrorCode?: string;
}

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  currentIntent: string | null;
  currentFaqs: ChatFaqMatch[];
  error: string | null;
  showEscalation: boolean;
  escalationReason: string | null;
  sendMessage: (text: string) => Promise<void>;
  submitRating: (messageId: string, rating: number) => Promise<boolean>;
  verifyAndLookupOrder: (
    messageId: string,
    orderReference: string,
    verificationCode: string,
  ) => Promise<void>;
  retryOrderLookup: (messageId: string) => Promise<void>;
  cancelOrderTool: (messageId: string) => void;
  resumeOrderTool: (messageId: string) => void;
  requestOrderSupport: () => Promise<void>;
  loadHistory: (detail: ChatHistoryDetail) => void;
  clearChat: () => Promise<void>;
  clearError: () => void;
}

let messageCounter = 0;
let closeChatInFlight = false;
function nextLocalId(): string {
  messageCounter++;
  return `local-${Date.now()}-${messageCounter}`;
}

function t(key: string, params?: Record<string, string | number>): string {
  return usePreferences.getState().t(key, params);
}

function formatErrorContent(message: string): string {
  return `[${t('chat.errorPrefix')}] ${message}`;
}

function localizeOrderToolError(
  error: unknown,
  stage: 'verify' | 'lookup',
): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 429) return t('chat.orderTool.rateLimited');
    if (stage === 'lookup' && error.statusCode === 401) {
      return t('chat.orderTool.grantExpired');
    }
  }
  return t(stage === 'verify' ? 'chat.orderTool.verifyFailed' : 'chat.orderTool.lookupFailed');
}

function isVisibleChatRole(role: ChatHistoryDetail['messages'][number]['role']): boolean {
  return role === MessageRole.USER || role === MessageRole.ASSISTANT;
}

function extractOrderReference(message: string): string | undefined {
  return message.normalize('NFKC').match(/\bRW-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/iu)?.[0].toUpperCase();
}

function updateOrderToolMessage(
  messages: ChatMessage[],
  messageId: string,
  update: (tool: OrderToolViewState) => OrderToolViewState,
): ChatMessage[] {
  return messages.map((message) => (
    message.id === messageId && message.orderTool
      ? { ...message, orderTool: update(message.orderTool) }
      : message
  ));
}

export const useChat = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  isStreaming: false,
  currentIntent: null,
  currentFaqs: [],
  error: null,
  showEscalation: false,
  escalationReason: null,

  sendMessage: async (text: string) => {
    const state = get();
    if (state.isStreaming) return;

    const userMsgId = nextLocalId();
    const assistantMsgId = nextLocalId();

    // Add user message
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: text,
    };

    // Add placeholder assistant message
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };

    set({
      messages: [...state.messages, userMsg, assistantMsg],
      isStreaming: true,
      error: null,
      currentIntent: null,
      currentFaqs: [],
      showEscalation: false,
      escalationReason: null,
    });

    try {
      const result = await chatApi.sendMessage(text, state.sessionId ?? undefined, {
        onToken: (token: string) => {
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: m.content + token }
                : m,
            ),
          }));
        },
        onIntent: (intent: string, confidence: number) => {
          set({
            currentIntent: intent,
          });
          // Update assistant message intent
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? { ...m, intent, intentConf: confidence }
                : m,
            ),
          }));
        },
        onFaq: (faqMatches) => {
          set({
            currentFaqs: faqMatches,
          });
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? { ...m, faqMatches }
                : m,
            ),
          }));
        },
        onEscalate: (reason: string) => {
          set({ showEscalation: true, escalationReason: reason });
        },
        onTool: (toolEvent: OrderToolEvent) => {
          set((prev) => ({
            messages: prev.messages.map((message) => (
              message.id === assistantMsgId
                ? {
                    ...message,
                    orderTool: {
                      status: toolEvent.status,
                      maskedOrderReference: toolEvent.maskedOrderReference,
                      orderReference: extractOrderReference(text),
                      demoAvailable: toolEvent.demoAvailable,
                      demoSample: toolEvent.demoSample,
                      executionId: toolEvent.executionId,
                      safeErrorCode: toolEvent.safeErrorCode,
                      error: toolEvent.safeErrorCode === 'tool_disabled'
                        ? t('chat.orderTool.disabled')
                        : undefined,
                      failureStage: toolEvent.status === 'failed' ? 'lookup' : undefined,
                    },
                  }
                : message
            )),
          }));
        },
        onDone: (data) => {
          // Update session ID
          set({ sessionId: data.sessionId });
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    knowledgeSources: data.knowledgeSources,
                    answerMode: data.answerMode,
                    groundingStatus: data.groundingStatus,
                    groundingReason: data.groundingReason,
                    retrievalPolicyId: data.retrievalPolicyId,
                    failed: false,
                  }
                : m,
            ),
          }));
        },
        onError: (message: string) => {
          set({ error: message });
          // Update assistant message with error
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: formatErrorContent(message),
                    failed: true,
                    isStreaming: false,
                  }
                : m,
            ),
          }));
        },
      });

      const finalMessageId = result.messageId || assistantMsgId;
      // Mark streaming as complete
      set((prev) => ({
        isStreaming: false,
        sessionId: result.sessionId,
        messages: prev.messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, id: finalMessageId, isStreaming: false }
            : m,
        ),
      }));
      if (get().messages.find((message) => message.id === finalMessageId)?.orderTool?.status === 'running') {
        await get().retryOrderLookup(finalMessageId);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('chat.sendFailed');
      set({
        isStreaming: false,
        error: errorMsg,
        messages: get().messages.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: formatErrorContent(errorMsg),
                failed: true,
                isStreaming: false,
              }
            : m,
        ),
      });
    }
  },

  submitRating: async (messageId: string, rating: number) => {
    const state = get();
    if (!state.sessionId) return false;

    try {
      await chatApi.submitRating(messageId, state.sessionId, rating);
      set((prev) => ({
        messages: prev.messages.map((m) =>
          m.id === messageId ? { ...m, satisfaction: rating } : m,
        ),
      }));
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('chat.satisfactionSubmitFailed');
      set({ error: errorMsg });
      return false;
    }
  },

  verifyAndLookupOrder: async (messageId, orderReference, verificationCode) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    set((prev) => ({
      messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
        ...tool,
        status: 'verifying',
        orderReference,
        error: undefined,
        failureStage: undefined,
      })),
    }));
    try {
      const verified = await chatApi.verifyOrder({
        sessionId,
        orderReference,
        verificationCode,
      });
      set((prev) => ({
        messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
          ...tool,
          status: 'running',
          maskedOrderReference: verified.maskedOrderReference,
          expiresAt: verified.expiresAt,
        })),
      }));
    } catch (error) {
      const message = localizeOrderToolError(error, 'verify');
      set((prev) => ({
        error: message,
        messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
          ...tool,
          status: 'failed',
          error: message,
          failureStage: 'verify',
        })),
      }));
      return;
    }

    try {
      const lookup = await chatApi.lookupOrder(sessionId);
      set((prev) => ({
        messages: prev.messages.map((message) => (
          message.id === messageId && message.orderTool
            ? {
                ...message,
                id: lookup.messageId,
                content: lookup.localizedText[usePreferences.getState().language],
                orderTool: {
                  ...message.orderTool,
                  status: 'succeeded',
                  executionId: lookup.executionId,
                  result: lookup.result,
                  localizedText: lookup.localizedText,
                  error: undefined,
                  failureStage: undefined,
                },
              }
            : message
        )),
      }));
    } catch (error) {
      const message = localizeOrderToolError(error, 'lookup');
      const expired = error instanceof ApiError && error.statusCode === 401;
      set((prev) => ({
        error: message,
        messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
          ...tool,
          status: expired ? 'expired' : 'failed',
          error: message,
          failureStage: expired ? 'verify' : 'lookup',
        })),
      }));
    }
  },

  retryOrderLookup: async (messageId) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    set((prev) => ({
      messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
        ...tool,
        status: 'running',
        error: undefined,
      })),
    }));
    try {
      const lookup = await chatApi.lookupOrder(sessionId);
      set((prev) => ({
        messages: prev.messages.map((message) => (
          message.id === messageId && message.orderTool
            ? {
                ...message,
                id: lookup.messageId,
                content: lookup.localizedText[usePreferences.getState().language],
                orderTool: {
                  ...message.orderTool,
                  status: 'succeeded',
                  executionId: lookup.executionId,
                  result: lookup.result,
                  localizedText: lookup.localizedText,
                  error: undefined,
                  failureStage: undefined,
                },
              }
            : message
        )),
      }));
    } catch (error) {
      const message = localizeOrderToolError(error, 'lookup');
      const expired = error instanceof ApiError && error.statusCode === 401;
      set((prev) => ({
        error: message,
        messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
          ...tool,
          status: expired ? 'expired' : 'failed',
          error: message,
          failureStage: expired ? 'verify' : 'lookup',
        })),
      }));
    }
  },

  cancelOrderTool: (messageId) => {
    set((prev) => ({
      messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
        ...tool,
        status: 'cancelled',
        error: undefined,
      })),
    }));
  },

  resumeOrderTool: (messageId) => {
    set((prev) => ({
      messages: updateOrderToolMessage(prev.messages, messageId, (tool) => ({
        ...tool,
        status: 'verification_required',
        error: undefined,
      })),
    }));
  },

  requestOrderSupport: async () => {
    await get().sendMessage(t('chat.orderTool.transferRequest'));
  },

  loadHistory: (detail: ChatHistoryDetail) => {
    set({
      sessionId: detail.session.id,
      messages: detail.messages
        .filter((message) => isVisibleChatRole(message.role))
        .map((message) => ({
          id: message.id,
          role: message.role === MessageRole.USER ? 'user' : 'assistant',
          content: message.content,
          intent: message.intent,
          intentConf: message.intentConf,
          knowledgeSources: message.retrievalSnapshot,
          answerMode: message.answerMode,
          groundingStatus: message.groundingStatus,
          groundingReason: message.groundingReason,
          retrievalPolicyId: message.retrievalPolicyId,
          satisfaction: message.satisfaction,
          failed: false,
          isStreaming: false,
        })),
      isStreaming: false,
      currentIntent: null,
      currentFaqs: [],
      error: null,
      showEscalation: false,
      escalationReason: null,
    });
  },

  clearChat: async () => {
    if (closeChatInFlight) return;
    closeChatInFlight = true;
    const sessionId = get().sessionId;
    try {
      if (sessionId) {
        await chatApi.closeSession(sessionId);
      }
      set({
        sessionId: null,
        messages: [],
        isStreaming: false,
        currentIntent: null,
        currentFaqs: [],
        error: null,
        showEscalation: false,
        escalationReason: null,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('chat.closeFailed');
      set({ error: errorMsg });
    } finally {
      closeChatInFlight = false;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
