import { create } from 'zustand';
import * as chatApi from '../api/chat';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent?: string | null;
  intentConf?: number | null;
  faqMatches?: Array<{
    id: string;
    question: string;
    answer: string;
    similarity: number;
  }>;
  satisfaction?: number | null;
  isStreaming?: boolean;
}

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  currentIntent: string | null;
  currentFaqs: Array<{
    id: string;
    question: string;
    answer: string;
    similarity: number;
  }>;
  error: string | null;
  showEscalation: boolean;
  escalationReason: string | null;
  sendMessage: (text: string) => Promise<void>;
  submitRating: (messageId: string, rating: number) => Promise<void>;
  clearChat: () => void;
  clearError: () => void;
}

let messageCounter = 0;
function nextLocalId(): string {
  messageCounter++;
  return `local-${Date.now()}-${messageCounter}`;
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
                ? { ...m, content: m.content || `[错误] ${message}`, isStreaming: false }
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
      const errorMsg = err instanceof Error ? err.message : '发送消息失败';
      set({
        isStreaming: false,
        error: errorMsg,
        messages: get().messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: `[错误] ${errorMsg}`, isStreaming: false }
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
      const errorMsg = err instanceof Error ? err.message : '提交评分失败';
      set({ error: errorMsg });
    }
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
