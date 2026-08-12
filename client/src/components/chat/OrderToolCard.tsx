import React, { useEffect, useState } from 'react';
import { Button, Card, Input, Tag } from 'tdesign-react';
import type { OrderToolViewState } from '../../hooks/useChat';
import { useTranslation } from '../../hooks/usePreferences';

interface OrderToolCardProps {
  tool: OrderToolViewState;
  disabled?: boolean;
  onVerify: (orderReference: string, verificationCode: string) => Promise<void>;
  onRetry: () => Promise<void>;
  onCancel: () => void;
  onResume: () => void;
  onTransfer: () => Promise<void>;
}

const BUSY_STATUSES = new Set<OrderToolViewState['status']>(['verifying', 'running']);

export function OrderToolCard({
  tool,
  disabled = false,
  onVerify,
  onRetry,
  onCancel,
  onResume,
  onTransfer,
}: OrderToolCardProps): React.ReactElement {
  const { language, t } = useTranslation();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [orderReference, setOrderReference] = useState(tool.orderReference ?? '');
  const [verificationCode, setVerificationCode] = useState('');
  const busy = BUSY_STATUSES.has(tool.status);

  useEffect(() => {
    if (tool.orderReference) setOrderReference(tool.orderReference);
  }, [tool.orderReference]);

  const fillDemo = (): void => {
    if (!tool.demoSample) return;
    setOrderReference(tool.demoSample.orderReference);
    setVerificationCode(tool.demoSample.verificationCode);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!orderReference.trim() || !verificationCode.trim() || busy || disabled) return;
    void onVerify(orderReference.trim(), verificationCode.trim()).then(() => {
      setVerificationCode('');
    });
  };

  if (tool.status === 'succeeded' && tool.result) {
    const result = tool.result;
    return (
      <div className="app-order-tool-card-shell" data-testid="order-result-card">
        <Card bordered size="small" className="app-order-tool-card app-order-tool-result">
        <div className="app-order-tool-card__header">
          <div>
            <div className="app-order-tool-card__eyebrow">{t('chat.orderTool.readOnly')}</div>
            <strong>{t('chat.orderTool.resultTitle')}</strong>
          </div>
          <Tag theme="success" variant="light">{t('chat.orderTool.status.succeeded')}</Tag>
        </div>
        <p className="app-order-tool-card__summary">
          {tool.localizedText?.[language]}
        </p>
        <dl className="app-order-tool-result__grid">
          <div><dt>{t('chat.orderTool.orderReference')}</dt><dd>{result.orderReferenceMasked}</dd></div>
          <div><dt>{t('chat.orderTool.orderStatus')}</dt><dd>{t(`chat.orderTool.orderStatus.${result.orderStatus}`)}</dd></div>
          <div><dt>{t('chat.orderTool.shippingStatus')}</dt><dd>{t(`chat.orderTool.shippingStatus.${result.shippingStatus}`)}</dd></div>
          <div><dt>{t('chat.orderTool.carrier')}</dt><dd>{t(`chat.orderTool.carrier.${result.carrier}`)}</dd></div>
          <div><dt>{t('chat.orderTool.trackingNumber')}</dt><dd>{result.trackingNumberMasked ?? '—'}</dd></div>
          <div><dt>{t('chat.orderTool.latestEvent')}</dt><dd>{t(`chat.orderTool.event.${result.latestEvent}`)}</dd></div>
          <div><dt>{t('chat.orderTool.latestEventAt')}</dt><dd>{result.latestEventAt ? new Date(result.latestEventAt).toLocaleString(locale) : '—'}</dd></div>
          <div><dt>{t('chat.orderTool.estimatedDelivery')}</dt><dd>{result.estimatedDeliveryDate ?? '—'}</dd></div>
          <div><dt>{t('chat.orderTool.dataUpdatedAt')}</dt><dd>{new Date(result.dataUpdatedAt).toLocaleString(locale)}</dd></div>
        </dl>
        <p className="app-order-tool-card__privacy">{t('chat.orderTool.refreshNotice')}</p>
        </Card>
      </div>
    );
  }

  if (tool.status === 'cancelled') {
    return (
      <div className="app-order-tool-card-shell" data-testid="order-verification-card">
        <Card bordered size="small" className="app-order-tool-card">
        <div className="app-order-tool-card__header">
          <strong>{t('chat.orderTool.cancelled')}</strong>
          <Tag variant="light">{t('chat.orderTool.status.cancelled')}</Tag>
        </div>
        <div className="app-order-tool-card__actions">
          <Button size="small" variant="outline" onClick={onResume}>{t('chat.orderTool.resume')}</Button>
          <Button size="small" variant="text" onClick={() => void onTransfer()}>{t('chat.orderTool.transfer')}</Button>
        </div>
        </Card>
      </div>
    );
  }

  const showVerificationForm = tool.status === 'verification_required'
    || tool.status === 'expired'
    || (tool.status === 'failed' && tool.failureStage === 'verify');
  const canRetryLookup = tool.status === 'failed'
    && tool.failureStage === 'lookup'
    && tool.safeErrorCode !== 'tool_disabled';

  return (
    <div className="app-order-tool-card-shell" data-testid="order-verification-card">
      <Card bordered size="small" className="app-order-tool-card">
      <div className="app-order-tool-card__header">
        <div>
          <div className="app-order-tool-card__eyebrow">{t('chat.orderTool.readOnly')}</div>
          <strong>{t('chat.orderTool.verifyTitle')}</strong>
        </div>
        <Tag
          theme={tool.status === 'failed' || tool.status === 'expired' ? 'warning' : 'primary'}
          variant="light"
        >
          {t(`chat.orderTool.status.${tool.status}`)}
        </Tag>
      </div>

      <p className="app-order-tool-card__description">{t('chat.orderTool.verifyDescription')}</p>
      {tool.error && <div className="app-order-tool-card__error" role="alert">{tool.error}</div>}

      {showVerificationForm && (
        <form className="app-order-tool-form" onSubmit={submit} aria-label={t('chat.orderTool.verifyTitle')}>
          <label>
            <span>{t('chat.orderTool.orderReference')}</span>
            <Input
              value={orderReference}
              onChange={(value: string) => setOrderReference(value)}
              placeholder={t('chat.orderTool.orderReferencePlaceholder')}
              disabled={disabled || busy}
              autocomplete="off"
              data-testid="order-reference-input"
            />
          </label>
          <label>
            <span>{t('chat.orderTool.verificationCode')}</span>
            <Input
              type="password"
              value={verificationCode}
              onChange={(value: string) => setVerificationCode(value)}
              placeholder={t('chat.orderTool.verificationCodePlaceholder')}
              disabled={disabled || busy}
              autocomplete="off"
              data-testid="order-verification-code-input"
            />
          </label>
          {tool.demoAvailable && tool.demoSample && (
            <Button type="button" size="small" variant="text" onClick={fillDemo}>
              {t('chat.orderTool.useDemo')}
            </Button>
          )}
          <div className="app-order-tool-card__actions">
            <Button
              type="submit"
              theme="primary"
              size="small"
              loading={busy}
              disabled={disabled || !orderReference.trim() || !verificationCode.trim()}
            >
              {t('chat.orderTool.verifyAndLookup')}
            </Button>
            <Button type="button" size="small" variant="outline" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="small" variant="text" onClick={() => void onTransfer()} disabled={busy}>
              {t('chat.orderTool.transfer')}
            </Button>
          </div>
        </form>
      )}

      {tool.status === 'running' || tool.status === 'verifying' ? (
        <div className="app-order-tool-card__progress" aria-live="polite">
          {tool.status === 'verifying'
            ? t('chat.orderTool.verifying')
            : t('chat.orderTool.running')}
        </div>
      ) : null}

      {canRetryLookup && (
        <div className="app-order-tool-card__actions">
          <Button size="small" theme="primary" onClick={() => void onRetry()}>{t('chat.orderTool.retry')}</Button>
          <Button size="small" variant="text" onClick={() => void onTransfer()}>{t('chat.orderTool.transfer')}</Button>
        </div>
      )}
      <p className="app-order-tool-card__privacy">{t('chat.orderTool.privacy')}</p>
      </Card>
    </div>
  );
}
