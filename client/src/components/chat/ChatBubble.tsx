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
  refund: '#e34d59',
  order: '#0052d9',
  technical: '#e37318',
  general: '#8b8b8b',
};

/**
 * Single chat bubble component for user and AI messages.
 */
export function ChatBubble({ message, onSubmitRating }: ChatBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const { language, t } = useTranslation();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '16px',
        padding: '0 16px',
      }}
    >
      {/* Role label */}
      <span
        style={{
          fontSize: '12px',
          color: 'var(--app-text-muted)',
          marginBottom: '4px',
          padding: '0 8px',
        }}
      >
        {isUser ? t('chat.user') : t('chat.assistant')}
      </span>

      {/* Bubble */}
      <div
        className={`app-chat-bubble ${isUser ? 'app-chat-bubble--user' : 'app-chat-bubble--assistant'}`}
        style={{
          backgroundColor: isUser ? 'var(--app-primary)' : undefined,
          color: isUser ? '#ffffff' : undefined,
        }}
      >
        {message.content || (message.isStreaming ? (
          <span style={{ opacity: 0.6 }}>{t('chat.thinking')}</span>
        ) : '')}

        {/* Streaming cursor */}
        {message.isStreaming && message.content && (
          <span
            style={{
              display: 'inline-block',
              width: '2px',
              height: '16px',
              backgroundColor: isUser ? '#ffffff' : 'var(--app-text)',
              marginLeft: '2px',
              verticalAlign: 'text-bottom',
              animation: 'blink 1s step-end infinite',
            }}
          />
        )}
        <style>{`
          @keyframes blink {
            50% { opacity: 0; }
          }
        `}</style>
      </div>

      {/* Intent tag (AI messages only) */}
      {!isUser && message.intent && (
        <div style={{ marginTop: '4px', padding: '0 8px' }}>
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
        <div
          style={{
            marginTop: '8px',
            padding: '8px 12px',
            backgroundColor: 'var(--app-surface-muted)',
            borderRadius: '8px',
            fontSize: '12px',
            maxWidth: '75%',
            border: '1px solid var(--app-border-soft)',
          }}
        >
          <div style={{ color: 'var(--app-text-muted)', marginBottom: '4px' }}>{t('chat.faqReferences')}</div>
          {message.faqMatches.slice(0, 3).map((faq) => (
            <div
              key={faq.id}
              style={{
                padding: '4px 0',
                borderBottom: '1px solid var(--app-border-soft)',
              }}
            >
              <div style={{ fontWeight: 500, color: 'var(--app-text-secondary)' }}>
                {t('chat.faqQuestionPrefix')}{faq.question}
              </div>
              <div style={{ color: 'var(--app-text-muted)', fontSize: '11px', marginTop: '2px' }}>
                {t('chat.faqAnswerPrefix')}{faq.answer.length > 100 ? faq.answer.slice(0, 100) + '...' : faq.answer}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Satisfaction rating (AI messages only, after streaming completes) */}
      {!isUser && !message.isStreaming && message.content && onSubmitRating && (
        <div style={{ marginTop: '8px', padding: '0 8px' }}>
          <SatisfactionRating
            currentRating={message.satisfaction ?? undefined}
            onSubmitRating={(rating: number) => onSubmitRating(message.id, rating)}
          />
        </div>
      )}
    </div>
  );
}
