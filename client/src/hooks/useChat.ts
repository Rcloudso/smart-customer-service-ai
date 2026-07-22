import { create } from 'zustand';
import * as chatApi from '../api/chat';
import { usePreferences } from './usePreferences';
import type { ChatHistoryDetail } from '../api/chat';
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
  satisfaction?: number | null;
  failed?: boolean;
  isStreaming?: boolean;
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

function isVisibleChatRole(role: ChatHistoryDetail['messages'][number]['role']): boolean {
  return role === MessageRole.USER || role === MessageRole.ASSISTANT;
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

      // Mark streaming as complete
      set((prev) => ({
        isStreaming: false,
        sessionId: result.sessionId,
        messages: prev.messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, id: result.messageId || m.id, isStreaming: false }
            : m,
        ),
      }));
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
