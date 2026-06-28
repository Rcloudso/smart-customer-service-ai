import React, { useRef, useEffect, useCallback } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import { ClearIcon } from 'tdesign-icons-react';
import { useChat } from '../hooks/useChat';
import { useTranslation } from '../hooks/usePreferences';
import { ChatBubble } from '../components/chat/ChatBubble';
import { ChatInput } from '../components/chat/ChatInput';
import { PreferenceControls } from '../components/common/PreferenceControls';

/**
 * Main chat page — title bar + message list + input area.
 */
export function ChatPage(): React.ReactElement {
  const {
    messages,
    isStreaming,
    error,
    sendMessage,
    submitRating,
    clearChat,
    clearError,
  } = useChat();
  const { t } = useTranslation();

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

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const handleClear = useCallback(() => {
    clearChat();
    MessagePlugin.success(t('chat.cleared'));
  }, [clearChat, t]);

  const handleSubmitRating = useCallback(
    (messageId: string, rating: number) => {
      submitRating(messageId, rating);
      MessagePlugin.success('感谢您的评价！');
    },
    [submitRating],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: 'var(--app-bg)',
        maxWidth: '800px',
        margin: '0 auto',
        width: '100%',
      }}
    >
      {/* Title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: 'var(--app-surface)',
          borderBottom: '1px solid var(--app-border)',
          flexShrink: 0,
        }}
      >
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--app-text)' }}>
            {t('chat.title')}
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--app-text-muted)', margin: '2px 0 0 0' }}>
            {t('chat.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {messages.length > 0 && (
            <Button
              variant="text"
              icon={<ClearIcon />}
              onClick={handleClear}
              size="small"
            >
              {t('chat.clear')}
            </Button>
          )}
          <PreferenceControls compact />
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 0',
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--app-text-muted)',
              padding: '0 32px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
            <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--app-text-secondary)', margin: '0 0 8px 0' }}>
              {t('chat.greeting')}
            </h2>
            <p style={{ fontSize: '14px', lineHeight: 1.6, margin: 0 }}>
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
    </div>
  );
}

export default ChatPage;
