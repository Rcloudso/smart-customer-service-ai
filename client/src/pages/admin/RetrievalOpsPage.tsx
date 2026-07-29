import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Dialog,
  Input,
  MessagePlugin,
  Pagination,
  Progress,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
} from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type {
  RetrievalActivationCheck,
  RetrievalIndexJob,
  RetrievalStatus,
  RetrievalTrace,
  RetrievalTraceDetail,
  RetrievalTraceStatus,
} from '../../types';
import { useTranslation } from '../../hooks/usePreferences';
import './RetrievalOpsPage.css';

type PendingAction = {
  kind: 'activate' | 'rollback';
  job: RetrievalIndexJob;
  gate?: RetrievalActivationCheck;
};

const healthThemes = {
  healthy: 'success',
  degraded: 'warning',
  unavailable: 'danger',
  not_configured: 'default',
} as const;

const traceThemes = {
  completed: 'success',
  degraded: 'warning',
  failed: 'danger',
} as const;

export function RetrievalOpsPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [status, setStatus] = useState<RetrievalStatus | null>(null);
  const [jobs, setJobs] = useState<RetrievalIndexJob[]>([]);
  const [traces, setTraces] = useState<RetrievalTrace[]>([]);
  const [traceTotal, setTraceTotal] = useState(0);
  const [tracePage, setTracePage] = useState(1);
  const [traceStatus, setTraceStatus] = useState<RetrievalTraceStatus | ''>('');
  const [traceBackend, setTraceBackend] = useState<'memory' | 'qdrant' | ''>('');
  const [traceSession, setTraceSession] = useState('');
  const [traceDates, setTraceDates] = useState<Array<string | number>>([]);
  const [detail, setDetail] = useState<RetrievalTraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [traceLoading, setTraceLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [latencyConfirmed, setLatencyConfirmed] = useState(false);
  const pageSize = 20;

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextStatus, jobPage] = await Promise.all([
        adminApi.getRetrievalStatus(),
        adminApi.listRetrievalIndexJobs(1, 50),
      ]);
      setStatus(nextStatus);
      setJobs(jobPage.items);
      setError(false);
    } catch {
      setError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadTraces = useCallback(async () => {
    setTraceLoading(true);
    try {
      const result = await adminApi.listRetrievalTraces({
        page: tracePage,
        pageSize,
        status: traceStatus || undefined,
        backend: traceBackend || undefined,
        sessionId: traceSession.trim() || undefined,
        createdFrom: traceDates[0]
          ? new Date(`${String(traceDates[0])}T00:00:00`).toISOString()
          : undefined,
        createdTo: traceDates[1]
          ? new Date(`${String(traceDates[1])}T23:59:59.999`).toISOString()
          : undefined,
      });
      setTraces(result.items);
      setTraceTotal(result.total);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setTraceLoading(false);
    }
  }, [traceBackend, traceDates, tracePage, traceSession, traceStatus]);

  useEffect(() => {
    void Promise.all([loadOverview(), loadTraces()]);
  }, [loadOverview, loadTraces]);

  useEffect(() => {
    if (!jobs.some((job) => ['queued', 'running', 'interrupted'].includes(job.status))) {
      return undefined;
    }
    const timer = window.setInterval(() => void loadOverview(true), 1500);
    return () => window.clearInterval(timer);
  }, [jobs, loadOverview]);

  const openActivation = async (job: RetrievalIndexJob) => {
    setActionLoading(true);
    try {
      const gate = await adminApi.getRetrievalActivationCheck(job.id);
      setLatencyConfirmed(false);
      setPendingAction({ kind: 'activate', job, gate });
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const confirmAction = async () => {
    if (!pendingAction || !status) return;
    setActionLoading(true);
    try {
      if (pendingAction.kind === 'activate') {
        await adminApi.activateRetrievalIndexJob({
          id: pendingAction.job.id,
          expectedCurrentCollection: status.collection,
          confirmLatencyWarning: latencyConfirmed,
        });
        MessagePlugin.success(t('retrievalOps.activated'));
      } else {
        await adminApi.rollbackRetrievalIndexJob({
          id: pendingAction.job.id,
          expectedCurrentCollection: pendingAction.job.collection,
        });
        MessagePlugin.success(t('retrievalOps.rolledBack'));
      }
      setPendingAction(null);
      await loadOverview();
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const createJob = async () => {
    setActionLoading(true);
    try {
      await adminApi.createRetrievalIndexJob();
      MessagePlugin.success(t('retrievalOps.jobQueued'));
      await loadOverview();
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const openTrace = async (traceId: string) => {
    setTraceLoading(true);
    try {
      setDetail(await adminApi.getRetrievalTrace(traceId));
    } catch {
      MessagePlugin.error(t('retrievalOps.traceLoadFailed'));
    } finally {
      setTraceLoading(false);
    }
  };

  const knowledgeById = useMemo(() => new Map(
    detail?.knowledge.map((item) => [
      `${item.knowledgeType}:${item.knowledgeId}`,
      item,
    ]) ?? [],
  ), [detail]);

  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';

  return (
    <div className="app-page-container app-retrieval-ops" data-testid="retrieval-ops-page">
      <div className="app-page-header">
        <div>
          <h2 className="app-page-title">{t('retrievalOps.title')}</h2>
          <p className="app-page-description">{t('retrievalOps.description')}</p>
        </div>
        <Button
          variant="outline"
          icon={<RefreshIcon />}
          loading={loading}
          onClick={() => void Promise.all([loadOverview(), loadTraces()])}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {error && (
        <Alert
          theme="error"
          message={t('retrievalOps.loadFailed')}
          close={false}
          className="app-retrieval-alert"
        />
      )}

      <section aria-labelledby="retrieval-overview-title">
        <div className="app-retrieval-section-heading">
          <h3 id="retrieval-overview-title">{t('retrievalOps.overview')}</h3>
        </div>
        <div className="app-retrieval-overview-grid">
          <Card>
            <span className="app-retrieval-label">{t('retrievalOps.provider')}</span>
            <strong>{status ? t(`retrievalOps.provider.${status.provider}`) : '—'}</strong>
          </Card>
          <Card>
            <span className="app-retrieval-label">{t('retrievalOps.qdrantHealth')}</span>
            {status ? (
              <Tag theme={healthThemes[status.qdrantHealth]}>
                {t(`retrievalOps.health.${status.qdrantHealth}`)}
              </Tag>
            ) : '—'}
          </Card>
          <Card>
            <span className="app-retrieval-label">{t('retrievalOps.activeCollection')}</span>
            <strong title={status?.collection ?? ''}>{status?.collection ?? '—'}</strong>
            <small>{status?.alias ?? '—'}</small>
          </Card>
          <Card>
            <span className="app-retrieval-label">{t('retrievalOps.vectorStats')}</span>
            <strong>
              {status?.points ?? '—'} / {status?.dimensions ?? '—'}
            </strong>
            <small>{t('retrievalOps.pointsDimensions')}</small>
          </Card>
          <Card>
            <span className="app-retrieval-label">{t('retrievalOps.syncStatus')}</span>
            <Tag theme={status?.syncStatus === 'synced' ? 'success' : 'warning'}>
              {status ? t(`retrievalOps.sync.${status.syncStatus}`) : '—'}
            </Tag>
          </Card>
        </div>
      </section>

      <Tabs defaultValue="jobs">
        <Tabs.TabPanel value="jobs" label={t('retrievalOps.indexJobs')}>
          <div className="app-retrieval-toolbar">
            <p>{t('retrievalOps.indexJobsDescription')}</p>
            <Button
              theme="primary"
              loading={actionLoading}
              disabled={!status?.qdrantConfigured}
              onClick={() => void createJob()}
            >
              {t('retrievalOps.createJob')}
            </Button>
          </div>
          <div className="app-retrieval-table-scroll">
            <Table
              rowKey="id"
              loading={loading}
              data={jobs}
              empty={t('retrievalOps.noJobs')}
              columns={[
                {
                  colKey: 'status',
                  title: t('retrievalOps.status'),
                  width: 120,
                  cell: ({ row }) => (
                    <Tag theme={jobTheme(row.status)}>
                      {t(`retrievalOps.jobStatus.${row.status}`)}
                    </Tag>
                  ),
                },
                {
                  colKey: 'collection',
                  title: t('retrievalOps.collection'),
                  ellipsis: true,
                },
                {
                  colKey: 'progress',
                  title: t('retrievalOps.progress'),
                  width: 180,
                  cell: ({ row }) => (
                    <Progress
                      percentage={Math.round(
                        (row.completedCount / Math.max(row.expectedCount, 1)) * 100,
                      )}
                      label={`${row.completedCount}/${row.expectedCount}`}
                    />
                  ),
                },
                {
                  colKey: 'profile',
                  title: t('retrievalOps.profileDimension'),
                  cell: ({ row }) => `${row.embeddingProfile} · ${row.vectorDimension}`,
                },
                {
                  colKey: 'updatedAt',
                  title: t('retrievalOps.updatedAt'),
                  width: 180,
                  cell: ({ row }) => new Date(row.updatedAt).toLocaleString(dateLocale),
                },
                {
                  colKey: 'action',
                  title: t('common.actions'),
                  width: 180,
                  cell: ({ row }) => (
                    <Space>
                      {row.status === 'ready' && (
                        <Button
                          size="small"
                          loading={actionLoading}
                          onClick={() => void openActivation(row)}
                        >
                          {t('retrievalOps.activate')}
                        </Button>
                      )}
                      {row.status === 'active' && row.previousCollection && (
                        <Button
                          size="small"
                          variant="outline"
                          onClick={() => setPendingAction({ kind: 'rollback', job: row })}
                        >
                          {t('retrievalOps.rollback')}
                        </Button>
                      )}
                      {row.failureCode && (
                        <span className="app-retrieval-error-code">{row.failureCode}</span>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        </Tabs.TabPanel>

        <Tabs.TabPanel value="traces" label={t('retrievalOps.traces')}>
          <Card className="app-retrieval-filter-card">
            <div className="app-retrieval-filters">
              <DateRangePicker
                value={traceDates}
                onChange={(value) => {
                  setTraceDates(value as Array<string | number>);
                  setTracePage(1);
                }}
                placeholder={[
                  t('retrievalOps.fromDate'),
                  t('retrievalOps.toDate'),
                ]}
                clearable
              />
              <Select
                value={traceStatus}
                placeholder={t('retrievalOps.traceStatus')}
                clearable
                options={(['completed', 'degraded', 'failed'] as const).map((value) => ({
                  label: t(`retrievalOps.traceStatus.${value}`),
                  value,
                }))}
                onChange={(value) => {
                  setTraceStatus(String(value ?? '') as RetrievalTraceStatus | '');
                  setTracePage(1);
                }}
              />
              <Select
                value={traceBackend}
                placeholder={t('retrievalOps.backend')}
                clearable
                options={[
                  { label: 'memory', value: 'memory' },
                  { label: 'qdrant', value: 'qdrant' },
                ]}
                onChange={(value) => {
                  setTraceBackend(String(value ?? '') as 'memory' | 'qdrant' | '');
                  setTracePage(1);
                }}
              />
              <Input
                data-testid="retrieval-trace-session-filter"
                value={traceSession}
                onChange={setTraceSession}
                placeholder={t('retrievalOps.sessionId')}
                onEnter={() => {
                  setTracePage(1);
                  void loadTraces();
                }}
              />
              <Button onClick={() => void loadTraces()}>{t('common.search')}</Button>
            </div>
          </Card>
          <div
            className="app-retrieval-table-scroll"
            data-testid="retrieval-trace-table"
          >
            <Table
              rowKey="id"
              loading={traceLoading}
              data={traces}
              empty={t('retrievalOps.noTraces')}
              columns={[
                {
                  colKey: 'status',
                  title: t('retrievalOps.traceStatus'),
                  width: 120,
                  cell: ({ row }) => (
                    <Tag theme={traceThemes[row.status]}>
                      {t(`retrievalOps.traceStatus.${row.status}`)}
                    </Tag>
                  ),
                },
                { colKey: 'backend', title: t('retrievalOps.backend'), width: 100 },
                {
                  colKey: 'sessionId',
                  title: t('retrievalOps.sessionId'),
                  ellipsis: true,
                },
                {
                  colKey: 'latency',
                  title: t('retrievalOps.totalLatency'),
                  width: 130,
                  cell: ({ row }) => `${row.totalLatencyMs.toFixed(1)} ms`,
                },
                {
                  colKey: 'createdAt',
                  title: t('retrievalOps.createdAt'),
                  width: 180,
                  cell: ({ row }) => new Date(row.createdAt).toLocaleString(dateLocale),
                },
                {
                  colKey: 'action',
                  title: t('common.actions'),
                  width: 100,
                  cell: ({ row }) => (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => void openTrace(row.id)}
                    >
                      {t('retrievalOps.viewTrace')}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
          <Pagination
            current={tracePage}
            pageSize={pageSize}
            total={traceTotal}
            showPageSize={false}
            onCurrentChange={setTracePage}
          />
        </Tabs.TabPanel>
      </Tabs>

      <Dialog
        visible={pendingAction !== null}
        header={pendingAction?.kind === 'activate'
          ? t('retrievalOps.confirmActivate')
          : t('retrievalOps.confirmRollback')}
        confirmOnEnter
        confirmBtn={{
          loading: actionLoading,
          disabled: pendingAction?.kind === 'activate'
            && (
              !pendingAction.gate?.eligible
              || (
                Boolean(pendingAction.gate?.warnings.length)
                && !latencyConfirmed
              )
            ),
        }}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void confirmAction()}
      >
        {pendingAction?.kind === 'activate' && pendingAction.gate && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              theme={pendingAction.gate.eligible ? 'success' : 'error'}
              message={pendingAction.gate.eligible
                ? t('retrievalOps.gatePassed')
                : `${t('retrievalOps.gateBlocked')}: ${pendingAction.gate.reasons.join(', ')}`}
            />
            {pendingAction.gate.warnings.length > 0 && (
              <>
                <Alert
                  theme="warning"
                  message={pendingAction.gate.warnings.join(', ')}
                />
                <Checkbox
                  checked={latencyConfirmed}
                  onChange={setLatencyConfirmed}
                >
                  {t('retrievalOps.confirmLatencyWarning')}
                </Checkbox>
              </>
            )}
          </Space>
        )}
        {pendingAction?.kind === 'rollback' && (
          <Alert
            theme="warning"
            message={t('retrievalOps.rollbackDescription', {
              collection: pendingAction.job.previousCollection ?? '',
            })}
          />
        )}
      </Dialog>

      <Dialog
        visible={detail !== null}
        width="min(760px, calc(100vw - 32px))"
        header={t('retrievalOps.traceDetail')}
        footer={false}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="app-retrieval-trace-detail">
            <div className="app-retrieval-message-grid">
              <div>
                <strong>{t('retrievalOps.userMessage')}</strong>
                <p>{detail.messages.user?.content ?? t('retrievalOps.contentUnavailable')}</p>
              </div>
              <div>
                <strong>{t('retrievalOps.assistantMessage')}</strong>
                <p>{detail.messages.assistant?.content ?? t('retrievalOps.contentUnavailable')}</p>
              </div>
            </div>
            <Timeline layout="vertical">
              {detail.trace.stages.map((stage) => (
                <Timeline.Item
                  key={stage.name}
                  dotColor={stage.status === 'completed'
                    ? 'primary'
                    : stage.status === 'skipped'
                      ? 'grey'
                      : 'warning'}
                  label={`${stage.latencyMs.toFixed(1)} ms`}
                >
                  <div className="app-retrieval-stage">
                    <strong>{t(`retrievalOps.stage.${stage.name}`)}</strong>
                    <span>
                      {t(`retrievalOps.stageStatus.${stage.status}`)}
                      {' · '}
                      {stage.inputCount} → {stage.outputCount}
                    </span>
                    {stage.errorCode && (
                      <code>{stage.errorCode}</code>
                    )}
                    {Object.keys(stage.budget).length > 0 && (
                      <small>
                        {Object.entries(stage.budget)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(' · ')}
                      </small>
                    )}
                    {stage.candidates.length > 0 && (
                      <ol>
                        {stage.candidates.map((candidate, index) => {
                          const resolved = knowledgeById.get(
                            `${candidate.knowledgeType}:${candidate.knowledgeId}`,
                          );
                          return (
                            <li key={`${candidate.knowledgeType}:${candidate.knowledgeId}:${index}`}>
                              <span>
                                {resolved?.title || candidate.knowledgeId}
                                {' · '}
                                {candidate.source ?? candidate.knowledgeType}
                              </span>
                              <span>{candidate.score?.toFixed(4) ?? '—'}</span>
                              {resolved?.available && <p>{resolved.content}</p>}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </Timeline.Item>
              ))}
            </Timeline>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function jobTheme(status: RetrievalIndexJob['status']): 'default' | 'primary' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success';
  if (status === 'ready') return 'primary';
  if (status === 'failed' || status === 'stale') return 'danger';
  if (status === 'running' || status === 'interrupted') return 'warning';
  return 'default';
}

export default RetrievalOpsPage;
