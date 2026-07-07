import { create } from 'zustand';
import * as chatApi from '../api/chat';
import { usePreferences } from './usePreferences';
import type { ChatHistoryDetail } from '../api/chat';
import { MessageRole } from '../types';

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
  satisfaction?: number | null;
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
  submitRating: (messageId: string, rating: number) => Promise<void>;
  loadHistory: (detail: ChatHistoryDetail) => void;
  clearChat: () => void;
  clearError: () => void;
}

let messageCounter = 0;
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
        },
        onError: (message: string) => {
          set({ error: message });
          // Update assistant message with error
          set((prev) => ({
            messages: prev.messages.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: m.content || formatErrorContent(message), isStreaming: false }
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
            ? { ...m, isStreaming: false }
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
            ? { ...m, content: formatErrorContent(errorMsg), isStreaming: false }
            : m,
        ),
      });
    }
  },

  submitRating: async (messageId: string, rating: number) => {
    const state = get();
    if (!state.sessionId) return;

    try {
      // The server expects sessionId not messageId for satisfaction
      await chatApi.submitRating(state.sessionId, rating);
      set((prev) => ({
        messages: prev.messages.map((m) =>
          m.id === messageId ? { ...m, satisfaction: rating } : m,
        ),
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('chat.satisfactionSubmitFailed');
      set({ error: errorMsg });
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
          satisfaction: message.satisfaction,
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

  clearChat: () => {
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
  },

  clearError: () => {
    set({ error: null });
  },
}));
