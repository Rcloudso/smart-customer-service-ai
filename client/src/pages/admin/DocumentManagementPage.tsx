import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Input,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Upload,
} from 'tdesign-react';
import type { SelectValue, UploadFile } from 'tdesign-react';
import {
  CloseIcon,
  DeleteIcon,
  SearchIcon,
  UploadIcon,
} from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type { DocumentChunk, DocumentItem, DocumentStatus } from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

const STATUS_THEMES: Record<DocumentStatus, 'default' | 'success' | 'danger'> = {
  pending: 'default',
  ready: 'success',
  failed: 'danger',
};

export function DocumentManagementPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [selected, setSelected] = useState<DocumentItem | null>(null);
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkPageSize, setChunkPageSize] = useState(10);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const statusOptions = useMemo(() => [
    { label: t('common.all'), value: '' },
    { label: t('documents.status.pending'), value: 'pending' },
    { label: t('documents.status.ready'), value: 'ready' },
    { label: t('documents.status.failed'), value: 'failed' },
  ], [language]);
  const activeOptions = useMemo(() => [
    { label: t('common.all'), value: '' },
    { label: t('documents.active'), value: 'true' },
    { label: t('documents.inactive'), value: 'false' },
  ], [language]);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listDocuments({
        status: status || undefined,
        isActive: activeFilter === '' ? undefined : activeFilter === 'true',
        keyword: keyword.trim() || undefined,
        page,
        pageSize,
      });
      setDocuments(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch {
      MessagePlugin.error(t('documents.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [status, activeFilter, keyword, page, pageSize, language]);

  const fetchChunks = useCallback(async (documentId: string, targetPage: number, targetPageSize: number) => {
    setChunksLoading(true);
    try {
      const result = await adminApi.listDocumentChunks(documentId, targetPage, targetPageSize);
      setChunks(result.items ?? []);
      setChunkTotal(result.total ?? 0);
    } catch {
      MessagePlugin.error(t('documents.chunksLoadFailed'));
    } finally {
      setChunksLoading(false);
    }
  }, [language]);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  const openDetails = async (document: DocumentItem) => {
    setSelected(document);
    setChunkPage(1);
    await fetchChunks(document.id, 1, chunkPageSize);
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const document = await adminApi.uploadDocument(file);
      MessagePlugin[document.status === 'ready' ? 'success' : 'warning'](
        document.status === 'ready' ? t('documents.uploaded') : t('documents.uploadFailedAccepted'),
      );
      setPage(1);
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('documents.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const handleRetry = async (document: DocumentItem) => {
    setBusyId(document.id);
    try {
      const result = await adminApi.retryDocument(document.id);
      MessagePlugin[result.status === 'ready' ? 'success' : 'warning'](
        result.status === 'ready' ? t('documents.retrySucceeded') : t('documents.retryFailed'),
      );
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('documents.retryFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (document: DocumentItem, isActive: boolean) => {
    setBusyId(document.id);
    try {
      await adminApi.updateDocument(document.id, isActive);
      MessagePlugin.success(t('documents.updated'));
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('common.operationFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (document: DocumentItem) => {
    setBusyId(document.id);
    try {
      await adminApi.deleteDocument(document.id);
      MessagePlugin.success(t('documents.deleted'));
      if (selected?.id === document.id) setSelected(null);
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('common.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      colKey: 'fileName', title: t('documents.fileName'), width: 220, ellipsis: true,
      cell: ({ row }: { row: DocumentItem }) => <strong>{row.fileName}</strong>,
    },
    {
      colKey: 'format', title: t('documents.format'), width: 80,
      cell: ({ row }: { row: DocumentItem }) => <Tag variant="light">{row.format.toUpperCase()}</Tag>,
    },
    {
      colKey: 'sizeBytes', title: t('documents.size'), width: 100,
      cell: ({ row }: { row: DocumentItem }) => formatBytes(row.sizeBytes),
    },
    {
      colKey: 'status', title: t('common.status'), width: 100,
      cell: ({ row }: { row: DocumentItem }) => (
        <Tag theme={STATUS_THEMES[row.status]} variant="light">
          {t(`documents.status.${row.status}`)}
        </Tag>
      ),
    },
    { colKey: 'chunkCount', title: t('documents.chunkCount'), width: 90 },
    {
      colKey: 'isActive', title: t('documents.enabled'), width: 90,
      cell: ({ row }: { row: DocumentItem }) => (
        <Switch
          value={Boolean(row.isActive)}
          disabled={row.status !== 'ready' || busyId === row.id}
          onChange={(value: boolean) => handleToggle(row, value)}
          aria-label={t('documents.enabled')}
        />
      ),
    },
    {
      colKey: 'updatedAt', title: t('documents.updatedAt'), width: 170,
      cell: ({ row }: { row: DocumentItem }) => new Date(row.updatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'),
    },
    {
      colKey: 'actions', title: t('common.actions'), width: 220, fixed: 'right' as const,
      cell: ({ row }: { row: DocumentItem }) => (
        <Space size="small">
          <Button variant="text" size="small" onClick={() => openDetails(row)} data-testid="document-view">
            {t('documents.view')}
          </Button>
          {row.status === 'failed' && (
            <Button variant="text" theme="primary" size="small" loading={busyId === row.id} onClick={() => handleRetry(row)} data-testid="document-retry">
              {t('documents.retry')}
            </Button>
          )}
          <Popconfirm content={t('documents.deleteConfirm')} onConfirm={() => handleDelete(row)}>
            <Button variant="text" theme="danger" size="small" icon={<DeleteIcon />} loading={busyId === row.id} aria-label={t('common.delete')} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const chunkColumns = [
    { colKey: 'chunkIndex', title: t('documents.chunkIndex'), width: 80 },
    { colKey: 'title', title: t('documents.chunkTitle'), width: 140, ellipsis: true, cell: ({ row }: { row: DocumentChunk }) => row.title ?? '—' },
    { colKey: 'content', title: t('documents.chunkContent'), ellipsis: true },
    { colKey: 'pages', title: t('documents.pages'), width: 100, cell: ({ row }: { row: DocumentChunk }) => formatPages(row) },
    { colKey: 'characterCount', title: t('documents.characters'), width: 90 },
  ];

  return (
    <div className="app-page-container" data-testid="documents-page">
      <div className="app-page-header">
        <div>
          <h2 className="app-page-title">{t('documents.title')}</h2>
          <p className="app-page-description">{t('documents.description')}</p>
        </div>
      </div>

      <Card bordered className="app-toolbar-card">
        <div className="app-toolbar-row">
          <Input value={keyword} onChange={(value: string) => setKeyword(value)} placeholder={t('documents.searchPlaceholder')} prefixIcon={<SearchIcon />} clearable className="app-filter-input" />
          <Select value={status} onChange={(value: SelectValue) => { setStatus(String(value ?? '') as DocumentStatus | ''); setPage(1); }} options={statusOptions} className="app-filter-select" />
          <Select value={activeFilter} onChange={(value: SelectValue) => { setActiveFilter(String(value ?? '') as '' | 'true' | 'false'); setPage(1); }} options={activeOptions} className="app-filter-select" />
          <Button theme="primary" icon={<SearchIcon />} onClick={() => { setPage(1); fetchDocuments(); }}>{t('common.search')}</Button>
          <div className="app-toolbar-spacer" />
          <div className="app-toolbar-actions">
            <Upload
              action="#"
              theme="file"
              accept=".txt,.md,.pdf,.docx"
              autoUpload={false}
              disabled={uploading}
              onChange={(files: UploadFile | UploadFile[]) => {
                const file = (Array.isArray(files) ? files[0] : files) as UploadFile;
                if (file?.raw) handleUpload(file.raw as File);
              }}
            >
              <Button theme="primary" icon={<UploadIcon />} loading={uploading} data-testid="document-upload">
                {t('documents.upload')}
              </Button>
            </Upload>
          </div>
        </div>
      </Card>

      <Card bordered className="app-table-card">
        <Table
          rowKey="id"
          data={documents}
          columns={columns}
          loading={loading}
          empty={t('documents.empty')}
          tableLayout="fixed"
          pagination={{ current: page, pageSize, total, showJumper: true }}
          onPageChange={(info) => { setPage(info.current); setPageSize(info.pageSize); }}
        />
      </Card>

      <Dialog
        visible={Boolean(selected)}
        header={t('documents.detailTitle')}
        closeBtn={<Button variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        footer={false}
        width="840px"
        onClose={() => setSelected(null)}
      >
        {selected && (
          <div className="app-document-detail" data-testid="document-detail">
            <div className="app-document-meta">
              <span><strong>{t('documents.fileName')}</strong>{selected.fileName}</span>
              <span><strong>{t('documents.format')}</strong>{selected.format.toUpperCase()}</span>
              <span><strong>{t('documents.size')}</strong>{formatBytes(selected.sizeBytes)}</span>
              <span><strong>{t('common.status')}</strong>{t(`documents.status.${selected.status}`)}</span>
              <span><strong>{t('documents.characters')}</strong>{selected.characterCount}</span>
              <span><strong>{t('documents.chunkCount')}</strong>{selected.chunkCount}</span>
              {selected.failureCode && <span className="app-document-failure"><strong>{t('documents.failureCode')}</strong>{t(`documents.failure.${selected.failureCode}`)}</span>}
            </div>
            <Table
              rowKey="id"
              data={chunks}
              columns={chunkColumns}
              loading={chunksLoading}
              empty={t('documents.chunksEmpty')}
              tableLayout="fixed"
              pagination={{ current: chunkPage, pageSize: chunkPageSize, total: chunkTotal, showJumper: true }}
              onPageChange={(info) => {
                setChunkPage(info.current);
                setChunkPageSize(info.pageSize);
                fetchChunks(selected.id, info.current, info.pageSize);
              }}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPages(chunk: DocumentChunk): string {
  if (!chunk.pageStart) return '—';
  return chunk.pageEnd && chunk.pageEnd !== chunk.pageStart
    ? `${chunk.pageStart}-${chunk.pageEnd}`
    : String(chunk.pageStart);
}

export default DocumentManagementPage;
