import React from 'react';
import { Tag } from 'tdesign-react';
import type { ChatMessage } from '../../hooks/useChat';
import { intentLabel } from '../../i18n';
import { useTranslation } from '../../hooks/usePreferences';
import { SatisfactionRating } from './SatisfactionRating';
import { SafeMarkdown } from '../common/SafeMarkdown';
import { OrderToolCard } from './OrderToolCard';

interface ChatBubbleProps {
  message: ChatMessage;
  onSubmitRating?: (messageId: string, rating: number) => Promise<boolean>;
  onVerifyOrder?: (messageId: string, orderReference: string, verificationCode: string) => Promise<void>;
  onRetryOrder?: (messageId: string) => Promise<void>;
  onCancelOrder?: (messageId: string) => void;
  onResumeOrder?: (messageId: string) => void;
  onTransferOrder?: () => Promise<void>;
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
export function ChatBubble({
  message,
  onSubmitRating,
  onVerifyOrder,
  onRetryOrder,
  onCancelOrder,
  onResumeOrder,
  onTransferOrder,
}: ChatBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const { language, t } = useTranslation();
  const documentSources = message.knowledgeSources?.filter((source) => (
    source.knowledgeType === 'document'
  )) ?? [];
  const faqSources = message.knowledgeSources?.filter((source) => (
    source.knowledgeType === 'faq'
  )) ?? [];
  const transientFaqMatches = message.knowledgeSources === undefined ? message.faqMatches ?? [] : [];
  const visibleContent = !isUser
    && message.orderTool?.status === 'succeeded'
    && message.orderTool.localizedText
    ? message.orderTool.localizedText[language]
    : message.content;

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
        {visibleContent ? (
          isUser
            ? visibleContent
            : <SafeMarkdown className="app-chat-markdown" content={visibleContent} />
        ) : (message.isStreaming ? (
          <span style={{ opacity: 0.6 }}>{t('chat.thinking')}</span>
        ) : '')}

        {/* Streaming cursor */}
        {message.isStreaming && visibleContent && (
          <span
            className="app-chat-stream-cursor"
            style={{
              backgroundColor: isUser ? 'var(--app-on-primary)' : 'var(--app-text)',
            }}
          />
        )}
      </div>

      {!isUser && message.orderTool && onVerifyOrder && onRetryOrder
        && onCancelOrder && onResumeOrder && onTransferOrder && (
        <OrderToolCard
          tool={message.orderTool}
          onVerify={(orderReference, verificationCode) => (
            onVerifyOrder(message.id, orderReference, verificationCode)
          )}
          onRetry={() => onRetryOrder(message.id)}
          onCancel={() => onCancelOrder(message.id)}
          onResume={() => onResumeOrder(message.id)}
          onTransfer={onTransferOrder}
        />
      )}

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

      {!isUser && message.answerMode && message.groundingStatus && (
        <div className="app-chat-grounding-row" data-testid="chat-grounding-status">
          <Tag theme="default" variant="light" size="small">
            {t(`chat.answerMode.${message.answerMode}`)}
          </Tag>
          <Tag
            theme={
              message.groundingStatus === 'sufficient'
                ? 'success'
                : message.groundingStatus === 'insufficient'
                  ? 'warning'
                  : 'danger'
            }
            variant="light"
            size="small"
          >
            {t(`chat.groundingStatus.${message.groundingStatus}`)}
          </Tag>
        </div>
      )}

      {/* FAQ reference matches (AI messages only) */}
      {!isUser && (faqSources.length > 0 || transientFaqMatches.length > 0) && (
        <div className="app-chat-faq-reference" data-testid="chat-faq-references">
          <div className="app-chat-faq-reference__title">{t('chat.faqReferences')}</div>
          {faqSources.map((source) => (
            <div
              key={`${source.knowledgeType}:${source.knowledgeId}`}
              className="app-chat-faq-reference__item"
            >
              <div className="app-chat-faq-reference__question">
                {t('chat.faqQuestionPrefix')}{source.title}
              </div>
            </div>
          ))}
          {transientFaqMatches.slice(0, 3).map((faq) => (
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

      {!isUser && documentSources.length > 0 && (
        <div className="app-chat-document-reference" data-testid="chat-document-references">
          <div className="app-chat-document-reference__title">{t('chat.documentReferences')}</div>
          {documentSources.map((source) => {
            const pages = source.pageStart
              ? `${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ''}`
              : null;
            return (
              <div
                key={`${source.knowledgeType}:${source.knowledgeId}`}
                className="app-chat-document-reference__item"
              >
                <div className="app-chat-document-reference__name">{source.title}</div>
                <div className="app-chat-document-reference__location">
                  {source.chunkIndex !== undefined && t('chat.documentChunkLabel', {
                    index: source.chunkIndex + 1,
                  })}
                  {pages && (
                    <>
                      {source.chunkIndex !== undefined && ' · '}
                      {t('chat.documentPageLabel', { pages })}
                    </>
                  )}
                </div>
                {source.extractionEngine && (
                  <div className="app-chat-document-reference__provenance">
                    <span>
                      {t('chat.documentOcrLabel', {
                        engine: t(`documents.ocrEngine.${source.extractionEngine}`),
                        version: source.extractionEngineVersion ?? '—',
                      })}
                    </span>
                    {source.sourceBlockIds && source.sourceBlockIds.length > 0 && (
                      <span>
                        {t('chat.documentBlockLabel', {
                          blocks: source.sourceBlockIds.join(', '),
                        })}
                      </span>
                    )}
                    {source.extractionJobId && (
                      <span>
                        {t('chat.documentExtractionLabel', {
                          job: source.extractionJobId.slice(0, 8),
                        })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Satisfaction rating (AI messages only, after streaming completes) */}
      {!isUser && !message.isStreaming && !message.failed && visibleContent && onSubmitRating
        && (!message.orderTool || message.orderTool.status === 'succeeded') && (
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
