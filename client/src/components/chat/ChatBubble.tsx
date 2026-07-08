import React from 'react';
import { Tag } from 'tdesign-react';
import type { ChatMessage } from '../../hooks/useChat';
import { intentLabel } from '../../i18n';
import { useTranslation } from '../../hooks/usePreferences';
import { SatisfactionRating } from './SatisfactionRating';

interface ChatBubbleProps {
  message: ChatMessage;
  onSubmitRating?: (messageId: string, rating: number) => void;
}

const INTENT_COLORS: Record<string, string> = {
  refund: '#ee0000',
  order: '#0070f3',
  technical: '#f5a623',
  general: '#8f8f8f',
};

/**
 * Single chat bubble component for user and AI messages.
 */
export function ChatBubble({ message, onSubmitRating }: ChatBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const { language, t } = useTranslation();

  return (
    <div
      className={`app-chat-message ${isUser ? 'app-chat-message--user' : 'app-chat-message--assistant'}`}
    >
      {/* Role label */}
      <span className="app-chat-role-label">
        {isUser ? t('chat.user') : t('chat.assistant')}
      </span>

      {/* Bubble */}
      <div
        className={`app-chat-bubble ${isUser ? 'app-chat-bubble--user' : 'app-chat-bubble--assistant'}`}
      >
        {message.content || (message.isStreaming ? (
          <span style={{ opacity: 0.6 }}>{t('chat.thinking')}</span>
        ) : '')}

        {/* Streaming cursor */}
        {message.isStreaming && message.content && (
          <span
            className="app-chat-stream-cursor"
            style={{
              backgroundColor: isUser ? 'var(--app-on-primary)' : 'var(--app-text)',
            }}
          />
        )}
      </div>

      {/* Intent tag (AI messages only) */}
      {!isUser && message.intent && (
        <div className="app-chat-intent-row">
          <Tag
            theme="default"
            variant="light"
            size="small"
            style={{
              backgroundColor: `${INTENT_COLORS[message.intent] || '#8b8b8b'}15`,
              color: INTENT_COLORS[message.intent] || '#8b8b8b',
              borderColor: `${INTENT_COLORS[message.intent] || '#8b8b8b'}30`,
            }}
          >
            {intentLabel(language, message.intent) || message.intent}
            {message.intentConf !== null && message.intentConf !== undefined && (
              <span style={{ marginLeft: '4px', fontSize: '11px' }}>
                {(message.intentConf * 100).toFixed(0)}%
              </span>
            )}
          </Tag>
        </div>
      )}

      {/* FAQ reference matches (AI messages only) */}
      {!isUser && message.faqMatches && message.faqMatches.length > 0 && (
        <div className="app-chat-faq-reference">
          <div className="app-chat-faq-reference__title">{t('chat.faqReferences')}</div>
          {message.faqMatches.slice(0, 3).map((faq) => (
            <div
              key={faq.id}
              className="app-chat-faq-reference__item"
            >
              <div className="app-chat-faq-reference__question">
                {t('chat.faqQuestionPrefix')}{faq.question}
              </div>
              <div className="app-chat-faq-reference__answer">
                {t('chat.faqAnswerPrefix')}{faq.answer.length > 100 ? faq.answer.slice(0, 100) + '...' : faq.answer}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Satisfaction rating (AI messages only, after streaming completes) */}
      {!isUser && !message.isStreaming && message.content && onSubmitRating && (
        <div className="app-chat-rating-row">
          <SatisfactionRating
            currentRating={message.satisfaction ?? undefined}
            onSubmitRating={(rating: number) => onSubmitRating(message.id, rating)}
          />
        </div>
      )}
    </div>
  );
}
