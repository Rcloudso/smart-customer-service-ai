import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Dialog,
  Input,
  Select,
  Table,
  Tag,
} from 'tdesign-react';
import type { SelectValue } from 'tdesign-react';
import {
  FilterClearIcon,
  RefreshIcon,
  SearchIcon,
} from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type {
  EscalationCategory,
  EscalationDetail,
  EscalationListItem,
  EscalationPriority,
  EscalationQueue,
} from '../../types';
import { EscalationStatus } from '../../types';
import { SafeMarkdown } from '../../components/common/SafeMarkdown';
import { useTranslation } from '../../hooks/usePreferences';

const PRIORITY_THEME = {
  urgent: 'danger',
  high: 'warning',
  normal: 'default',
} as const;

const STATUS_THEME = {
  pending: 'warning',
  resolved: 'success',
  dismissed: 'default',
} as const;

function option(label: string, value: string): { label: string; value: string } {
  return { label, value };
}

export function EscalationTriagePage(): React.ReactElement {
  const { language, t } = useTranslation();
  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState<EscalationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<EscalationStatus | ''>(EscalationStatus.PENDING);
  const [category, setCategory] = useState<EscalationCategory | ''>('');
  const [priority, setPriority] = useState<EscalationPriority | ''>('');
  const [queue, setQueue] = useState<EscalationQueue | ''>('');
  const [applied, setApplied] = useState({
    keyword: '',
    status: EscalationStatus.PENDING as EscalationStatus | '',
    category: '' as EscalationCategory | '',
    priority: '' as EscalationPriority | '',
    queue: '' as EscalationQueue | '',
  });
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detail, setDetail] = useState<EscalationDetail | null>(null);

  const statusOptions = useMemo(() => [
    option(t('triage.status.pending'), 'pending'),
    option(t('triage.status.resolved'), 'resolved'),
    option(t('triage.status.dismissed'), 'dismissed'),
  ], [language]);
  const categoryOptions = useMemo(() => [
    option(t('triage.filter.allCategories'), ''),
    ...['account_security', 'complaint', 'refund', 'order', 'technical', 'general', 'unknown']
      .map((value) => option(t(`triage.category.${value}`), value)),
  ], [language]);
  const priorityOptions = useMemo(() => [
    option(t('triage.filter.allPriorities'), ''),
    ...['urgent', 'high', 'normal']
      .map((value) => option(t(`triage.priority.${value}`), value)),
  ], [language]);
  const queueOptions = useMemo(() => [
    option(t('triage.filter.allQueues'), ''),
    ...[
      'account_security',
      'complaints',
      'after_sales',
      'order_support',
      'technical_support',
      'general_support',
      'manual_triage',
    ].map((value) => option(t(`triage.queue.${value}`), value)),
  ], [language]);

  const fetchEscalations = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await adminApi.listEscalations({
        page,
        pageSize,
        keyword: applied.keyword || undefined,
        status: applied.status || undefined,
        category: applied.category || undefined,
        priority: applied.priority || undefined,
        queue: applied.queue || undefined,
      });
      if (requestId !== requestIdRef.current) return;
      setItems(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch (fetchError) {
      if (requestId !== requestIdRef.current) return;
      setItems([]);
      setTotal(0);
      setError(fetchError instanceof Error ? fetchError.message : t('triage.listLoadFailed'));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [page, pageSize, applied, language]);

  useEffect(() => {
    void fetchEscalations();
  }, [fetchEscalations]);

  const applyFilters = () => {
    const next = { keyword: keyword.trim(), status, category, priority, queue };
    const unchanged = page === 1 && JSON.stringify(next) === JSON.stringify(applied);
    setApplied(next);
    setPage(1);
    if (unchanged) void fetchEscalations();
  };

  const resetFilters = () => {
    setKeyword('');
    setStatus(EscalationStatus.PENDING);
    setCategory('');
    setPriority('');
    setQueue('');
    setApplied({
      keyword: '',
      status: EscalationStatus.PENDING,
      category: '',
      priority: '',
      queue: '',
    });
    setPage(1);
  };

  const openDetail = async (escalationId: string) => {
    setDetailVisible(true);
    setDetailLoading(true);
    setDetailError('');
    setDetail(null);
    try {
      setDetail(await adminApi.getEscalationDetail(escalationId));
    } catch (fetchError) {
      setDetailError(fetchError instanceof Error ? fetchError.message : t('triage.detailLoadFailed'));
    } finally {
      setDetailLoading(false);
    }
  };

  const columns = [
    {
      colKey: 'summary',
      title: t('triage.summary'),
      width: 320,
      cell: ({ row }: { row: EscalationListItem }) => (
        <button
          type="button"
          className="app-triage-summary-button"
          onClick={() => void openDetail(row.id)}
        >
          <strong>{row.packet.summary}</strong>
          <span>{row.sessionId.slice(0, 12)} · {row.userIdent}</span>
        </button>
      ),
    },
    {
      colKey: 'priority',
      title: t('triage.priority'),
      width: 108,
      cell: ({ row }: { row: EscalationListItem }) => (
        <Tag theme={PRIORITY_THEME[row.packet.priority]} variant="light">
          {t(`triage.priority.${row.packet.priority}`)}
        </Tag>
      ),
    },
    {
      colKey: 'category',
      title: t('triage.category'),
      width: 132,
      cell: ({ row }: { row: EscalationListItem }) => t(`triage.category.${row.packet.category}`),
    },
    {
      colKey: 'queue',
      title: t('triage.recommendedQueue'),
      width: 154,
      cell: ({ row }: { row: EscalationListItem }) => t(`triage.queue.${row.packet.recommendedQueue}`),
    },
    {
      colKey: 'risk',
      title: t('triage.risk'),
      width: 160,
      cell: ({ row }: { row: EscalationListItem }) => row.packet.riskFlags.length > 0
        ? (
          <div className="app-triage-tags">
            {row.packet.riskFlags.slice(0, 2).map((risk) => (
              <Tag key={risk} size="small" theme="danger" variant="light-outline">
                {t(`triage.risk.${risk}`)}
              </Tag>
            ))}
          </div>
        )
        : <span className="app-triage-muted">{t('triage.noRisk')}</span>,
    },
    {
      colKey: 'waiting',
      title: t('triage.waiting'),
      width: 112,
      cell: ({ row }: { row: EscalationListItem }) => formatWaitingTime(row.createdAt, t),
    },
    {
      colKey: 'status',
      title: t('common.status'),
      width: 100,
      cell: ({ row }: { row: EscalationListItem }) => (
        <Tag theme={STATUS_THEME[row.status]} variant="light">
          {t(`triage.status.${row.status}`)}
        </Tag>
      ),
    },
    {
      colKey: 'actions',
      title: t('common.actions'),
      width: 110,
      fixed: 'right' as const,
      cell: ({ row }: { row: EscalationListItem }) => (
        <Button
          variant="text"
          theme="primary"
          className="app-table-action-button"
          onClick={() => void openDetail(row.id)}
        >
          {t('triage.viewDetail')}
        </Button>
      ),
    },
  ];

  return (
    <div className="app-page-container app-triage-page" data-testid="escalation-triage-page">
      <div className="app-page-header">
        <div>
          <h2 className="app-page-title">{t('triage.title')}</h2>
          <p className="app-page-description">{t('triage.description')}</p>
        </div>
      </div>

      <Card bordered className="app-toolbar-card">
        <div className="app-toolbar-row">
          <Input
            value={keyword}
            onChange={(value: string) => setKeyword(value)}
            onEnter={applyFilters}
            prefixIcon={<SearchIcon />}
            placeholder={t('triage.searchPlaceholder')}
            className="app-filter-input"
            clearable
          />
          <Select
            value={status}
            onChange={(value: SelectValue) => setStatus(String(value ?? '') as EscalationStatus | '')}
            options={statusOptions}
            className="app-filter-select"
            aria-label={t('triage.filter.status')}
          />
          <Select
            value={category}
            onChange={(value: SelectValue) => setCategory(String(value ?? '') as EscalationCategory | '')}
            options={categoryOptions}
            className="app-filter-select"
            aria-label={t('triage.category')}
          />
          <Select
            value={priority}
            onChange={(value: SelectValue) => setPriority(String(value ?? '') as EscalationPriority | '')}
            options={priorityOptions}
            className="app-filter-select"
            aria-label={t('triage.priority')}
          />
          <Select
            value={queue}
            onChange={(value: SelectValue) => setQueue(String(value ?? '') as EscalationQueue | '')}
            options={queueOptions}
            className="app-filter-select"
            aria-label={t('triage.recommendedQueue')}
          />
          <Button theme="primary" icon={<SearchIcon />} onClick={applyFilters}>
            {t('common.search')}
          </Button>
          <Button variant="outline" icon={<FilterClearIcon />} onClick={resetFilters}>
            {t('common.reset')}
          </Button>
          <div className="app-toolbar-spacer" />
          <Button variant="outline" icon={<RefreshIcon />} onClick={() => void fetchEscalations()}>
            {t('common.refresh')}
          </Button>
        </div>
      </Card>

      {error && (
        <Alert
          className="app-triage-alert"
          theme="error"
          message={error}
          operation={<Button variant="text" onClick={() => void fetchEscalations()}>{t('triage.retry')}</Button>}
        />
      )}

      <div data-testid="escalation-triage-table">
        <Card bordered className="app-table-card app-triage-table">
          <Table
            data={items}
            columns={columns}
            rowKey="id"
            loading={loading}
            hover
            stripe
            empty={t('triage.empty')}
            pagination={{
              current: page,
              pageSize,
              total,
              showJumper: true,
              pageSizeOptions: [10, 20, 50],
              onChange: (pagination) => {
                setPage(pagination.current);
                setPageSize(pagination.pageSize);
              },
            }}
          />
        </Card>
      </div>

      <Dialog
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        header={t('triage.detailTitle')}
        width="min(920px, calc(100vw - 32px))"
        footer={null}
        destroyOnClose
      >
        {detailLoading && <div className="app-triage-loading">{t('common.loading')}</div>}
        {!detailLoading && detailError && (
          <Alert theme="error" message={detailError} />
        )}
        {!detailLoading && detail && (
          <TriageDetail detail={detail} dateLocale={dateLocale} t={t} />
        )}
      </Dialog>
    </div>
  );
}

function TriageDetail({
  detail,
  dateLocale,
  t,
}: {
  detail: EscalationDetail;
  dateLocale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}): React.ReactElement {
  const packet = detail.packet;
  const referencedIds = new Set(detail.referencedMessageIds);
  const scrollToMessage = (messageId: string) => {
    document.getElementById(`triage-message-${messageId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  };

  return (
    <div className="app-triage-detail" data-testid="escalation-triage-detail">
      {packet.extractionMode === 'legacy_unstructured' && (
        <Alert theme="warning" message={t('triage.legacyRecord')} />
      )}
      <section className="app-triage-hero">
        <div className="app-triage-hero__title">
          <Tag theme={PRIORITY_THEME[packet.priority]} variant="light">
            {t(`triage.priority.${packet.priority}`)}
          </Tag>
          <h3>{packet.summary}</h3>
        </div>
        <div className="app-triage-meta-grid">
          <Meta label={t('triage.category')} value={t(`triage.category.${packet.category}`)} />
          <Meta label={t('triage.recommendedQueue')} value={t(`triage.queue.${packet.recommendedQueue}`)} />
          <Meta label={t('triage.reasonCode')} value={t(`triage.reason.${packet.reasonCode}`)} />
          <Meta label={t('triage.createdAt')} value={new Date(packet.createdAt).toLocaleString(dateLocale)} />
        </div>
      </section>

      <section>
        <h4>{t('triage.escalationReason')}</h4>
        <p>{packet.reason}</p>
      </section>
      <section className="app-triage-next-step">
          <h4>{t('triage.nextStep')}</h4>
        <p>
          {t(`triage.next.${packet.priority}`, {
            queue: t(`triage.queue.${packet.recommendedQueue}`),
          })}
        </p>
      </section>

      <div className="app-triage-detail-grid">
        <section>
          <h4>{t('triage.confirmedFacts')}</h4>
          {packet.confirmedFacts.length > 0 ? (
            <div className="app-triage-fact-list">
              {packet.confirmedFacts.map((fact, index) => (
                <button
                  type="button"
                  key={`${fact.sourceMessageId}-${index}`}
                  className="app-triage-fact"
                  onClick={() => scrollToMessage(fact.sourceMessageId)}
                >
                  <strong>{translatedOrRaw(t, `triage.fact.${fact.label}`, fact.label)}</strong>
                  <span>{fact.value}</span>
                  <small>{t('triage.locateSource')}</small>
                </button>
              ))}
            </div>
          ) : <p className="app-triage-muted">{t('triage.noConfirmedFacts')}</p>}
        </section>
        <section>
          <h4>{t('triage.missingInformation')}</h4>
          {packet.missingInformation.length > 0 ? (
            <ul>
              {packet.missingInformation.map((item) => (
                <li key={item}>{translatedOrRaw(t, `triage.missing.${item}`, item)}</li>
              ))}
            </ul>
          ) : <p className="app-triage-muted">{t('triage.none')}</p>}
        </section>
      </div>

      <section>
        <h4>{t('triage.risk')}</h4>
        <div className="app-triage-tags">
          {packet.riskFlags.length > 0
            ? packet.riskFlags.map((risk) => (
              <Tag key={risk} theme="danger" variant="light-outline">
                {translatedOrRaw(t, `triage.risk.${risk}`, risk)}
              </Tag>
            ))
            : <span className="app-triage-muted">{t('triage.noRisk')}</span>}
        </div>
      </section>

      <section>
        <h4>{t('triage.conversationEvidence')}</h4>
        <div className="app-triage-messages">
          {detail.messages.map((message) => (
            <div
              id={`triage-message-${message.id}`}
              data-testid={`triage-message-${message.id}`}
              key={message.id}
              className={[
                'app-conversation-message',
                message.role === 'user' ? 'app-conversation-message--user' : '',
                referencedIds.has(message.id) ? 'app-triage-message--referenced' : '',
              ].join(' ')}
            >
              <div className="app-conversation-message__meta">
                <span>{message.role === 'user' ? t('conversations.user') : t('conversations.aiAgent')}</span>
                <span>{new Date(message.createdAt).toLocaleString(dateLocale)}</span>
                {referencedIds.has(message.id) && (
                  <Tag size="small" theme="primary" variant="light">{t('triage.cited')}</Tag>
                )}
              </div>
              <div className="app-conversation-message__content">
                <SafeMarkdown content={message.content} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4>{t('triage.retrievalEvidence')}</h4>
        {packet.evidenceSources.length > 0 ? (
          <div className="app-triage-evidence-list">
            {packet.evidenceSources.map((source) => (
              <div key={`${source.knowledgeType}-${source.knowledgeId}-${source.chunkIndex ?? ''}`}>
                <strong>{source.title}</strong>
                <span>
                  {source.knowledgeType.toUpperCase()} · {(source.similarity * 100).toFixed(1)}%
                  {source.pageStart ? ` · ${t('triage.page', { page: source.pageStart })}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : <p className="app-triage-muted">{t('triage.noRetrievalEvidence')}</p>}
      </section>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatWaitingTime(
  createdAt: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 60) return t('triage.wait.minutes', { count: minutes });
  if (minutes < 1_440) return t('triage.wait.hours', { count: Math.floor(minutes / 60) });
  return t('triage.wait.days', { count: Math.floor(minutes / 1_440) });
}

function translatedOrRaw(
  t: (key: string, params?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
): string {
  const translated = t(key);
  return translated === key ? fallback.replaceAll('_', ' ') : translated;
}

export default EscalationTriagePage;
