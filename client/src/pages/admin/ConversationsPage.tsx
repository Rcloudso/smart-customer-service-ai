import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Table,
  Card,
  Button,
  Input,
  DatePicker,
  Select,
  Tag,
  Dialog,
  MessagePlugin,
} from 'tdesign-react';
import type { SelectValue } from 'tdesign-react';
import {
  SearchIcon,
  DownloadIcon,
  FilterClearIcon,
  RefreshIcon,
} from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type { ConversationDetail } from '../../api/admin';
import { SessionStatus } from '../../api/admin';
import { SafeMarkdown } from '../../components/common/SafeMarkdown';
import { useTranslation } from '../../hooks/usePreferences';

/** Simplified column definition to avoid depending on TDesign's internal TableColumn type. */
interface SimpleColumn {
  colKey: string;
  title: string;
  width?: number;
  ellipsis?: boolean;
  align?: 'left' | 'center' | 'right';
  cell?: (params: { row: ConversationRow }) => React.ReactNode;
}

interface ConversationRow {
  id: string;
  userIdent: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

function localDayTimezoneOffsets(date: string): {
  start: number;
  end: number;
} {
  if (!date) {
    const current = new Date().getTimezoneOffset();
    return { start: current, end: current };
  }
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start: start.getTimezoneOffset(),
    end: end.getTimezoneOffset(),
  };
}

const STATUS_MAP: Record<string, { labelKey: string; theme: 'success' | 'warning' | 'danger' | 'default' }> = {
  active: { labelKey: 'status.active', theme: 'success' },
  closed: { labelKey: 'status.closed', theme: 'default' },
  escalated: { labelKey: 'status.escalated', theme: 'warning' },
};

/**
 * Conversations management page with filtering, detail view, and export.
 */
export function ConversationsPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [createdDate, setCreatedDate] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [appliedStatusFilter, setAppliedStatusFilter] = useState('');
  const [appliedCreatedDate, setAppliedCreatedDate] = useState('');
  const timezoneOffsets = localDayTimezoneOffsets(appliedCreatedDate);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const requestIdRef = useRef(0);
  const statusOptions = [
    { label: t('status.all'), value: '' },
    { label: t('status.active'), value: SessionStatus.ACTIVE },
    { label: t('status.closed'), value: SessionStatus.CLOSED },
    { label: t('status.escalated'), value: SessionStatus.ESCALATED },
  ];

  const fetchConversations = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await adminApi.getConversations({
        page,
        limit: pageSize,
        status: (appliedStatusFilter || undefined) as SessionStatus | undefined,
        keyword: appliedKeyword || undefined,
        from: appliedCreatedDate || undefined,
        to: appliedCreatedDate || undefined,
        timezoneOffset: timezoneOffsets.start,
        timezoneOffsetTo: timezoneOffsets.end,
      });

      if (requestId !== requestIdRef.current) return;
      setData((result.items ?? []) as ConversationRow[]);
      setTotal(result.total ?? 0);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : t('conversations.listLoadFailed');
      MessagePlugin.error(message);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    page,
    pageSize,
    appliedStatusFilter,
    appliedKeyword,
    appliedCreatedDate,
    timezoneOffsets.start,
    timezoneOffsets.end,
    language,
  ]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleSearch = () => {
    const nextKeyword = keyword.trim();
    const shouldRefresh = page === 1
      && nextKeyword === appliedKeyword
      && statusFilter === appliedStatusFilter
      && createdDate === appliedCreatedDate;
    setAppliedKeyword(nextKeyword);
    setAppliedStatusFilter(statusFilter);
    setAppliedCreatedDate(createdDate);
    setPage(1);
    if (shouldRefresh) void fetchConversations();
  };

  const handleReset = () => {
    setKeyword('');
    setStatusFilter('');
    setCreatedDate('');
    setAppliedKeyword('');
    setAppliedStatusFilter('');
    setAppliedCreatedDate('');
    setPage(1);
  };

  const handleViewDetail = async (sessionId: string) => {
    setDetailLoading(true);
    setDetailVisible(true);
    try {
      const result = await adminApi.getConversationDetail(sessionId);
      setDetail(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('conversations.detailLoadFailed');
      MessagePlugin.error(message);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      await adminApi.exportConversations({
        from: appliedCreatedDate || undefined,
        to: appliedCreatedDate || undefined,
        status: (appliedStatusFilter || undefined) as SessionStatus | undefined,
        keyword: appliedKeyword || undefined,
        timezoneOffset: timezoneOffsets.start,
        timezoneOffsetTo: timezoneOffsets.end,
      });
      MessagePlugin.success(t('common.exportSuccess'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.exportFailed');
      MessagePlugin.error(message);
    }
  };

  const handlePageChange = (pageInfo: { current: number; pageSize: number }) => {
    setPage(pageInfo.current);
    setPageSize(pageInfo.pageSize);
  };

  const columns: SimpleColumn[] = [
    {
      colKey: 'id',
      title: t('conversations.sessionId'),
      width: 140,
      ellipsis: true,
      cell: ({ row }: { row: ConversationRow }) => (
        <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--app-text-secondary)' }}>
          {row.id.slice(0, 12)}...
        </span>
      ),
    },
    {
      colKey: 'userIdent',
      title: t('conversations.userIdent'),
      width: 120,
      ellipsis: true,
    },
    {
      colKey: 'status',
      title: t('common.status'),
      width: 96,
      cell: ({ row }: { row: ConversationRow }) => {
        const statusInfo = STATUS_MAP[row.status] || { labelKey: row.status, theme: 'default' as const };
        return <Tag theme={statusInfo.theme} variant="light" size="small">{t(statusInfo.labelKey)}</Tag>;
      },
    },
    {
      colKey: 'messageCount',
      title: t('conversations.messageCount'),
      width: 80,
      align: 'center' as const,
    },
    {
      colKey: 'createdAt',
      title: t('conversations.createdAt'),
      width: 160,
      cell: ({ row }: { row: ConversationRow }) => (
        <span style={{ fontSize: '12px', color: 'var(--app-text-muted)' }}>
          {new Date(row.createdAt).toLocaleString(dateLocale)}
        </span>
      ),
    },
    {
      colKey: 'actions',
      title: t('common.actions'),
      width: 100,
      cell: ({ row }: { row: ConversationRow }) => (
        <Button
          theme="primary"
          variant="text"
          size="small"
          className="app-table-action-button"
          onClick={() => handleViewDetail(row.id)}
        >
          {t('conversations.viewDetail')}
        </Button>
      ),
    },
  ];

  return (
    <div className="app-page-container">
      <div className="app-page-header">
        <h2 className="app-page-title">
          {t('conversations.title')}
        </h2>
      </div>

      {/* Filters */}
      <Card bordered className="app-toolbar-card">
        <div className="app-toolbar-row">
          <Input
            placeholder={t('conversations.searchPlaceholder')}
            value={keyword}
            onChange={(val: string) => setKeyword(val)}
            prefixIcon={<SearchIcon />}
            className="app-filter-input"
            clearable
          />
          <label className="app-filter-select-field">
            <span className="app-sr-only">{t('conversations.statusFilter')}</span>
            <Select
              value={statusFilter}
              onChange={(val: SelectValue) => setStatusFilter(String(val ?? ''))}
              options={statusOptions}
              placeholder={t('conversations.statusFilter')}
              className="app-filter-select"
            />
          </label>
          <DatePicker
            value={createdDate}
            onChange={(value) => setCreatedDate(String(value ?? ''))}
            placeholder={t('conversations.createdDateFilter')}
            clearable
            className="app-filter-date"
            data-testid="conversation-created-date-filter"
          />
          <Button theme="primary" onClick={handleSearch} icon={<SearchIcon />}>
            {t('common.search')}
          </Button>
          <Button variant="outline" onClick={handleReset} icon={<FilterClearIcon />} data-testid="conversation-filter-reset">
            {t('common.reset')}
          </Button>
          <div className="app-toolbar-spacer" />
          <div className="app-toolbar-actions">
            <Button
              variant="outline"
              onClick={handleExport}
              icon={<DownloadIcon />}
              title={t('conversations.exportFilteredHint')}
            >
              {t('conversations.exportFiltered')}
            </Button>
            <Button variant="outline" onClick={fetchConversations} icon={<RefreshIcon />}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card bordered className="app-table-card">
        <Table
          data={data}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="medium"
          stripe
          hover
          pagination={{
            current: page,
            pageSize,
            total,
            showJumper: true,
            pageSizeOptions: [10, 20, 50],
            onChange: (pageInfo) => handlePageChange(pageInfo),
          }}
        />
      </Card>

      {/* Detail dialog */}
      <Dialog
        header={t('conversations.detailTitle')}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        width="720px"
        footer={null}
        destroyOnClose
      >
        {detailLoading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--app-text-muted)' }}>
            {t('common.loading')}
          </div>
        ) : detail ? (
          <div className="app-conversation-detail">
            {/* Session info */}
            <div className="app-conversation-session">
              <div>{t('conversations.session')}: {detail.session.id}</div>
              <div>{t('conversations.user')}: {detail.session.userIdent}</div>
              <div>{t('common.status')}: {detail.session.status}</div>
              <div>{t('conversations.time')}: {new Date(detail.session.createdAt).toLocaleString(dateLocale)}</div>
              {detail.escalation && (
                <div className="app-conversation-escalation">
                  {t('conversations.escalation')}: {detail.escalation.reason} ({detail.escalation.status})
                </div>
              )}
            </div>

            {/* Messages */}
            {detail.messages.map((msg, idx) => (
              <div
                key={msg.id || idx}
                className={`app-conversation-message ${msg.role === 'user' ? 'app-conversation-message--user' : ''}`}
              >
                <div className="app-conversation-message__meta">
                  <span>{msg.role === 'user' ? t('conversations.user') : t('conversations.aiAgent')}</span>
                  <span>{new Date(msg.createdAt).toLocaleString(dateLocale)}</span>
                  {msg.intent && (
                    <Tag size="small" variant="light" theme="default">
                      {msg.intent}
                    </Tag>
                  )}
                  {msg.satisfaction && (
                    <span>{t('conversations.rating')}: {'★'.repeat(msg.satisfaction)}</span>
                  )}
                </div>
                <div className="app-conversation-message__content">
                  <SafeMarkdown content={msg.content} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

export default ConversationsPage;
