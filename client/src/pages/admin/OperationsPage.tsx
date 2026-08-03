import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Loading, MessagePlugin, Tag } from 'tdesign-react';
import { ArrowRightIcon, RefreshIcon } from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import {
  getOperationsOverview,
  rerunQualityRun,
  retryDocument,
} from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';
import type { OperationHealth, OperationsOverview } from '../../types';

const HEALTH_THEMES: Record<OperationHealth, 'success' | 'primary' | 'default' | 'warning' | 'danger'> = {
  healthy: 'success',
  configured: 'primary',
  optional_disabled: 'default',
  degraded: 'warning',
  failed: 'danger',
};

export default function OperationsPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await getOperationsOverview());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('operations.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => { void load(); }, [load]);

  const recover = async (problem: OperationsOverview['recentProblems'][number]): Promise<void> => {
    if (!problem.recovery) return;
    setRecovering(problem.id);
    try {
      if (problem.recovery === 'retry_document') await retryDocument(problem.id);
      if (problem.recovery === 'rerun_quality') await rerunQualityRun(problem.id);
      MessagePlugin.success(t('operations.recoveryQueued'));
      await load();
    } catch (reason) {
      MessagePlugin.error(reason instanceof Error ? reason.message : t('operations.recoveryFailed'));
    } finally {
      setRecovering(null);
    }
  };

  if (loading && !overview) {
    return <div className="app-centered-state"><Loading text={t('common.loading')} /></div>;
  }

  return (
    <div className="app-page-container" data-testid="operations-page">
      <header className="app-page-header">
        <div>
          <h1>{t('operations.title')}</h1>
          <p>{t('operations.description')}</p>
        </div>
        <Button icon={<RefreshIcon />} loading={loading} onClick={() => void load()}>{t('common.refresh')}</Button>
      </header>
      {error && <Alert theme="error" message={error} />}

      <section className="app-operations-services" aria-label={t('operations.services')}>
        {overview?.services.map((service) => (
          <Card key={service.key} className="app-panel-card app-operations-service-card">
            <div className="app-operations-card-heading">
              <strong>{t(`operations.service.${service.key}`)}</strong>
              <Tag theme={HEALTH_THEMES[service.health]}>{t(`operations.health.${service.health}`)}</Tag>
            </div>
            <div className="app-operations-mode">{t(`operations.mode.${service.mode}`)}</div>
            <p>{t(`operations.detail.${service.detail}`)}</p>
            {service.ownerPath !== '/admin/operations' && (
              <Button variant="text" icon={<ArrowRightIcon />} onClick={() => navigate(service.ownerPath)}>
                {t('operations.openWorkbench')}
              </Button>
            )}
          </Card>
        ))}
      </section>

      <Card title={t('operations.tasks')} className="app-panel-card app-operations-section">
        <div className="app-operations-task-grid">
          {(['documents', 'quality', 'indexes', 'ocr'] as const).map((key) => (
            <div key={key}>
              <strong>{t(`operations.task.${key}`)}</strong>
              <span>{t('operations.queued')}: {overview?.tasks[key].queued ?? 0}</span>
              <span>{t('operations.running')}: {overview?.tasks[key].running ?? 0}</span>
              <span className={(overview?.tasks[key].failed ?? 0) > 0 ? 'has-failures' : ''}>
                {t('operations.failed')}: {overview?.tasks[key].failed ?? 0}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('operations.recentProblems')} className="app-panel-card app-operations-section">
        {overview?.recentProblems.length ? (
          <div className="app-operations-problems">
            {overview.recentProblems.map((problem) => (
              <div key={`${problem.kind}-${problem.id}`} className="app-operations-problem">
                <div>
                  <div><Tag theme={problem.status === 'failed' ? 'danger' : 'warning'}>{t(`operations.kind.${problem.kind}`)}</Tag> <strong>{problem.title}</strong></div>
                  <p>{problem.failureCode ?? problem.status} · {new Date(problem.occurredAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</p>
                </div>
                <div className="app-operations-problem-actions">
                  {problem.recovery && (
                    <Button
                      theme="primary"
                      variant="outline"
                      loading={recovering === problem.id}
                      onClick={() => void recover(problem)}
                    >
                      {t(`operations.recovery.${problem.recovery}`)}
                    </Button>
                  )}
                  <Button variant="text" onClick={() => navigate(problem.ownerPath)}>{t('operations.openWorkbench')}</Button>
                </div>
              </div>
            ))}
          </div>
        ) : <div className="app-empty-state">{t('operations.noProblems')}</div>}
      </Card>
    </div>
  );
}
