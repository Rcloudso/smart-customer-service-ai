import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import { AddIcon, ChatIcon } from 'tdesign-icons-react';
import { useChat } from '../hooks/useChat';
import { useTranslation } from '../hooks/usePreferences';
import { ChatBubble } from '../components/chat/ChatBubble';
import { ChatInput } from '../components/chat/ChatInput';
import { PreferenceControls } from '../components/common/PreferenceControls';
import * as chatApi from '../api/chat';
import type { ChatHistorySession } from '../types';

/**
 * Main chat page — title bar + message list + input area.
 */
export function ChatPage(): React.ReactElement {
  const {
    sessionId,
    messages,
    isStreaming,
    error,
    sendMessage,
    submitRating,
    loadHistory,
    clearChat,
    clearError,
  } = useChat();
  const { language, t } = useTranslation();
  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySessions, setHistorySessions] = useState<ChatHistorySession[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change or streaming occurs
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Show error messages
  useEffect(() => {
    if (error) {
      MessagePlugin.error(error);
      clearError();
    }
  }, [error, clearError]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await chatApi.getChatHistory();
      setHistorySessions(result.items ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('chat.historyLoadFailed');
      MessagePlugin.error(message);
    } finally {
      setHistoryLoading(false);
    }
  }, [language]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text).finally(() => {
        fetchHistory();
      });
    },
    [fetchHistory, sendMessage],
  );

  const handleLoadHistory = useCallback(async (sessionId: string) => {
    setHistoryLoading(true);
    try {
      const detail = await chatApi.getChatHistoryDetail(sessionId);
      loadHistory(detail);
      MessagePlugin.success(t('chat.historyLoaded'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('chat.historyLoadFailed');
      MessagePlugin.error(message);
    } finally {
      setHistoryLoading(false);
    }
  }, [language, loadHistory]);

  const handleNewChat = useCallback(() => {
    void clearChat().then(fetchHistory);
  }, [clearChat, fetchHistory]);

  const handleSubmitRating = useCallback(
    async (messageId: string, rating: number): Promise<boolean> => {
      const submitted = await submitRating(messageId, rating);
      if (submitted) MessagePlugin.success(t('chat.ratingThanks'));
      return submitted;
    },
    [submitRating, t],
  );

  return (
    <div className="app-chat-layout" data-testid="chat-layout">
      <aside className="app-chat-sidebar" data-testid="chat-sidebar">
        <div className="app-chat-sidebar-header">
          <Button
            theme="primary"
            variant="outline"
            icon={<AddIcon />}
            onClick={handleNewChat}
            disabled={isStreaming}
            block
            data-testid="new-chat-button"
          >
            {t('chat.newChat')}
          </Button>
        </div>
        <div className="app-chat-sidebar-title">{t('chat.historyTitle')}</div>
        {historyLoading ? (
          <div className="app-chat-history-empty">{t('common.loading')}</div>
        ) : historySessions.length === 0 ? (
          <div className="app-chat-history-empty">{t('chat.historyEmpty')}</div>
        ) : (
          <div className="app-chat-history-list">
            {historySessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`app-chat-history-item ${session.id === sessionId ? 'app-chat-history-item--active' : ''}`}
                onClick={() => handleLoadHistory(session.id)}
                data-testid="chat-history-item"
              >
                <span className="app-chat-history-preview">
                  {session.preview || t('chat.newChat')}
                </span>
                <span className="app-chat-history-meta">
                  {t('chat.historyMessageCount', { count: session.messageCount })} · {new Date(session.updatedAt).toLocaleString(dateLocale)}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="app-chat-shell" data-testid="chat-main">
        {/* Title bar */}
        <div className="app-chat-header">
          <div>
            <h1 className="app-chat-title">
              {t('chat.title')}
            </h1>
            <p className="app-chat-subtitle">
              {t('chat.subtitle')}
            </p>
          </div>
          <div className="app-chat-header-actions">
            <PreferenceControls compact />
          </div>
        </div>

        {/* Messages area */}
        <div
          ref={messagesContainerRef}
          className="app-chat-messages"
          data-testid="chat-messages"
        >
          {messages.length === 0 ? (
            <div className="app-chat-empty">
              <div className="app-chat-empty-icon">
                <ChatIcon size="28px" />
              </div>
              <h2 className="app-chat-empty-title">
                {t('chat.greeting')}
              </h2>
              <p className="app-chat-empty-copy">
                {t('chat.intro')}
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onSubmitRating={handleSubmitRating}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </main>
    </div>
  );
}

export default ChatPage;
