import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  FilterClearIcon,
  RefreshIcon,
  SearchIcon,
  UploadIcon,
} from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import { DocumentReviewDialog } from '../../components/DocumentReviewDialog';
import type {
  DocumentBlock,
  DocumentChunk,
  DocumentDetail,
  DocumentItem,
  DocumentQualityDecision,
  DocumentStatus,
} from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

const STATUS_THEMES: Record<DocumentStatus, 'default' | 'success' | 'danger'> = {
  pending: 'default',
  ready: 'success',
  failed: 'danger',
};

const QUALITY_THEMES: Record<DocumentQualityDecision, 'success' | 'warning' | 'danger'> = {
  ready: 'success',
  review_required: 'warning',
  rejected: 'danger',
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
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [appliedStatus, setAppliedStatus] = useState<DocumentStatus | ''>('');
  const [appliedActiveFilter, setAppliedActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [reviewDocument, setReviewDocument] = useState<DocumentItem | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<DocumentChunk | null>(null);
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkPageSize, setChunkPageSize] = useState(10);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [blockPage, setBlockPage] = useState(1);
  const [blockPageSize, setBlockPageSize] = useState(10);
  const [blockTotal, setBlockTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const uploadingRef = useRef(false);
  const busyIdRef = useRef<string | null>(null);

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
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await adminApi.listDocuments({
        status: appliedStatus || undefined,
        isActive: appliedActiveFilter === '' ? undefined : appliedActiveFilter === 'true',
        keyword: appliedKeyword || undefined,
        page,
        pageSize,
      });
      if (requestId !== requestIdRef.current) return;
      setDocuments(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch {
      if (requestId !== requestIdRef.current) return;
      MessagePlugin.error(t('documents.loadFailed'));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [appliedStatus, appliedActiveFilter, appliedKeyword, page, pageSize, language]);

  const fetchChunks = useCallback(async (
    documentId: string,
    targetPage: number,
    targetPageSize: number,
    requestId = detailRequestIdRef.current,
  ) => {
    setChunksLoading(true);
    try {
      const result = await adminApi.listDocumentChunks(documentId, targetPage, targetPageSize);
      if (requestId !== detailRequestIdRef.current) return;
      setChunks(result.items ?? []);
      setChunkTotal(result.total ?? 0);
    } catch {
      if (requestId !== detailRequestIdRef.current) return;
      MessagePlugin.error(t('documents.chunksLoadFailed'));
    } finally {
      if (requestId === detailRequestIdRef.current) setChunksLoading(false);
    }
  }, [language]);

  const fetchBlocks = useCallback(async (
    documentId: string,
    targetPage: number,
    targetPageSize: number,
    requestId = detailRequestIdRef.current,
  ) => {
    setBlocksLoading(true);
    try {
      const result = await adminApi.listDocumentBlocks(documentId, targetPage, targetPageSize);
      if (requestId !== detailRequestIdRef.current) return;
      setBlocks(result.items ?? []);
      setBlockTotal(result.total ?? 0);
    } catch {
      if (requestId !== detailRequestIdRef.current) return;
      MessagePlugin.error(t('documents.blocksLoadFailed'));
    } finally {
      if (requestId === detailRequestIdRef.current) setBlocksLoading(false);
    }
  }, [language]);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  const openDetails = async (document: DocumentItem) => {
    const detailRequestId = ++detailRequestIdRef.current;
    setSelected({ ...document, processingSummary: null, representationSummary: null });
    setSelectedChunk(null);
    setDetailsLoading(true);
    setChunksLoading(true);
    setBlocksLoading(true);
    setChunkPage(1);
    setBlockPage(1);
    try {
      const [detail] = await Promise.all([
        adminApi.getDocument(document.id),
        fetchChunks(document.id, 1, chunkPageSize, detailRequestId),
        fetchBlocks(document.id, 1, blockPageSize, detailRequestId),
      ]);
      if (detailRequestId !== detailRequestIdRef.current) return;
      setSelected(detail);
    } catch {
      if (detailRequestId !== detailRequestIdRef.current) return;
      MessagePlugin.error(t('documents.detailLoadFailed'));
      setSelected(null);
    } finally {
      if (detailRequestId === detailRequestIdRef.current) setDetailsLoading(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    try {
      const document = await adminApi.uploadDocument(file);
      MessagePlugin[document.status === 'ready' ? 'success' : 'warning'](
        document.status === 'ready'
          ? t('documents.uploaded')
          : document.failureCode === 'ocr_review_required'
            ? t('documents.ocrReviewReady')
            : t('documents.uploadFailedAccepted'),
      );
      setUploadFiles([]);
      setPage(1);
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('documents.uploadFailed'));
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const handleSearch = () => {
    const nextKeyword = keyword.trim();
    const shouldRefresh = page === 1
      && nextKeyword === appliedKeyword
      && status === appliedStatus
      && activeFilter === appliedActiveFilter;
    setAppliedKeyword(nextKeyword);
    setAppliedStatus(status);
    setAppliedActiveFilter(activeFilter);
    setPage(1);
    if (shouldRefresh) void fetchDocuments();
  };

  const handleReset = () => {
    setKeyword('');
    setStatus('');
    setActiveFilter('');
    setAppliedKeyword('');
    setAppliedStatus('');
    setAppliedActiveFilter('');
    setPage(1);
  };

  const handleRetry = async (document: DocumentItem) => {
    if (busyIdRef.current) return;
    busyIdRef.current = document.id;
    setBusyId(document.id);
    try {
      const result = await adminApi.retryDocument(document.id);
      MessagePlugin[result.status === 'ready' ? 'success' : 'warning'](
        result.status === 'ready'
          ? t('documents.retrySucceeded')
          : result.failureCode === 'ocr_review_required'
            ? t('documents.ocrReviewReady')
            : t('documents.retryFailed'),
      );
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('documents.retryFailed'));
    } finally {
      busyIdRef.current = null;
      setBusyId(null);
    }
  };

  const handleReprocess = async (document: DocumentItem) => {
    if (busyIdRef.current) return;
    busyIdRef.current = document.id;
    setBusyId(document.id);
    try {
      const result = await adminApi.reprocessDocument(document.id);
      MessagePlugin[result.status === 'ready' ? 'success' : 'warning'](
        result.status === 'ready' ? t('documents.reprocessSucceeded') : t('documents.reprocessFailed'),
      );
      await fetchDocuments();
      if (selected?.id === document.id) await openDetails(result);
    } catch {
      MessagePlugin.error(t('documents.reprocessFailed'));
    } finally {
      busyIdRef.current = null;
      setBusyId(null);
    }
  };

  const handleToggle = async (document: DocumentItem, isActive: boolean) => {
    if (busyIdRef.current) return;
    busyIdRef.current = document.id;
    setBusyId(document.id);
    try {
      await adminApi.updateDocument(document.id, isActive);
      MessagePlugin.success(t('documents.updated'));
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('common.operationFailed'));
    } finally {
      busyIdRef.current = null;
      setBusyId(null);
    }
  };

  const handleDelete = async (document: DocumentItem) => {
    if (busyIdRef.current) return;
    busyIdRef.current = document.id;
    setBusyId(document.id);
    try {
      await adminApi.deleteDocument(document.id);
      MessagePlugin.success(t('documents.deleted'));
      if (selected?.id === document.id) setSelected(null);
      await fetchDocuments();
    } catch {
      MessagePlugin.error(t('common.deleteFailed'));
    } finally {
      busyIdRef.current = null;
      setBusyId(null);
    }
  };

  const handleReviewPublished = async (document: DocumentItem) => {
    await fetchDocuments();
    if (selected?.id === document.id) await openDetails(document);
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
      colKey: 'status', title: t('common.status'), width: 150,
      cell: ({ row }: { row: DocumentItem }) => (
        <div className="app-document-status">
          <Tag
            theme={row.failureCode === 'ocr_review_required' ? 'warning' : STATUS_THEMES[row.status]}
            variant="light"
          >
            {t(row.failureCode === 'ocr_review_required'
              ? 'documents.status.review_required'
              : `documents.status.${row.status}`)}
          </Tag>
          {row.qualityDecision && (
            <Tag theme={QUALITY_THEMES[row.qualityDecision]} variant="light">
              {t(`documents.quality.${row.qualityDecision}`)}
            </Tag>
          )}
          {row.failureCode && (
            <span>{t(`documents.failure.${row.failureCode}`)}</span>
          )}
        </div>
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
          <Button theme="primary" variant="text" size="small" className="app-table-action-button" onClick={() => openDetails(row)} data-testid="document-view">
            {t('documents.view')}
          </Button>
          {row.failureCode === 'ocr_review_required' && (
            <Button
              variant="text"
              theme="primary"
              size="small"
              className="app-table-action-button"
              onClick={() => setReviewDocument(row)}
              data-testid="document-review"
            >
              {t('documents.review')}
            </Button>
          )}
          {row.status === 'failed' && row.failureCode !== 'ocr_review_required' && (
            <Button variant="text" theme="primary" size="small" className="app-table-action-button" loading={busyId === row.id} onClick={() => handleRetry(row)} data-testid="document-retry">
              {t('documents.retry')}
            </Button>
          )}
          {row.status === 'ready' && row.representationVersion !== 'document-ir-v1' && (
            <Button variant="text" theme="primary" size="small" className="app-table-action-button" loading={busyId === row.id} onClick={() => handleReprocess(row)} data-testid="document-reprocess">
              {t('documents.reprocess')}
            </Button>
          )}
          <Popconfirm content={t('documents.deleteConfirm')} onConfirm={() => handleDelete(row)}>
            <Button variant="text" theme="danger" size="small" className="app-table-action-button" icon={<DeleteIcon />} loading={busyId === row.id} aria-label={t('common.delete')} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const chunkColumns = [
    { colKey: 'chunkIndex', title: t('documents.chunkIndex'), width: 80 },
    { colKey: 'title', title: t('documents.chunkTitle'), width: 140, ellipsis: true, cell: ({ row }: { row: DocumentChunk }) => row.title ?? '—' },
    {
      colKey: 'content', title: t('documents.chunkContent'),
      cell: ({ row }: { row: DocumentChunk }) => (
        <div className="app-document-chunk-preview">
          <span data-testid="document-chunk-preview-text">{row.content}</span>
          <Button theme="primary" variant="text" size="small" className="app-table-action-button" onClick={() => setSelectedChunk(row)} data-testid="document-chunk-view">
            {t('documents.viewFullChunk')}
          </Button>
        </div>
      ),
    },
    {
      colKey: 'headingPath', title: t('documents.headingPath'), width: 160, ellipsis: true,
      cell: ({ row }: { row: DocumentChunk }) => row.headingPath?.join(' / ') || row.title || '—',
    },
    { colKey: 'pages', title: t('documents.pages'), width: 90, cell: ({ row }: { row: DocumentChunk }) => formatPages(row) },
    { colKey: 'characterCount', title: t('documents.characters'), width: 90 },
  ];

  const blockColumns = [
    { colKey: 'order', title: t('documents.blockOrder'), width: 72 },
    {
      colKey: 'kind', title: t('documents.blockType'), width: 110,
      cell: ({ row }: { row: DocumentBlock }) => <Tag variant="light">{t(`documents.blockType.${row.kind}`)}</Tag>,
    },
    {
      colKey: 'headingPath', title: t('documents.headingPath'), width: 160, ellipsis: true,
      cell: ({ row }: { row: DocumentBlock }) => row.headingPath.join(' / ') || '—',
    },
    {
      colKey: 'pageNumber', title: t('documents.pages'), width: 72,
      cell: ({ row }: { row: DocumentBlock }) => row.pageNumber ?? '—',
    },
    {
      colKey: 'content', title: t('documents.blockContent'),
      cell: ({ row }: { row: DocumentBlock }) => (
        <span className="app-document-block-preview" data-testid="document-block-preview">
          {formatBlockPreview(row)}
        </span>
      ),
    },
    {
      colKey: 'excluded', title: t('documents.blockState'), width: 120,
      cell: ({ row }: { row: DocumentBlock }) => (
        <div className="app-document-status">
          <Tag theme={row.excluded ? 'warning' : 'success'} variant="light">
            {t(row.excluded ? 'documents.blockExcluded' : 'documents.blockIncluded')}
          </Tag>
          {row.exclusionReason && <span>{t(`documents.warning.${row.exclusionReason}`)}</span>}
        </div>
      ),
    },
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
          <Select value={status} onChange={(value: SelectValue) => setStatus(String(value ?? '') as DocumentStatus | '')} options={statusOptions} className="app-filter-select" />
          <Select value={activeFilter} onChange={(value: SelectValue) => setActiveFilter(String(value ?? '') as '' | 'true' | 'false')} options={activeOptions} className="app-filter-select" />
          <Button theme="primary" icon={<SearchIcon />} onClick={handleSearch}>{t('common.search')}</Button>
          <Button variant="outline" icon={<FilterClearIcon />} onClick={handleReset} data-testid="document-filter-reset">{t('common.reset')}</Button>
          <div className="app-toolbar-spacer" />
          <div className="app-toolbar-actions">
            <Upload
              action="#"
              theme="file"
              accept=".txt,.md,.pdf,.docx,.png,.jpg,.jpeg,.webp"
              autoUpload={false}
              disabled={uploading}
              files={uploadFiles}
              onChange={(files: UploadFile | UploadFile[]) => {
                const nextFiles = Array.isArray(files) ? files : [files];
                setUploadFiles(nextFiles);
                const file = nextFiles[0];
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
        closeBtn={<Button data-testid="document-detail-close" variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        footer={false}
        width="min(1040px, calc(100vw - 32px))"
        onClose={() => {
          detailRequestIdRef.current += 1;
          setSelected(null);
          setSelectedChunk(null);
          setBlocks([]);
          setChunks([]);
          setDetailsLoading(false);
          setBlocksLoading(false);
          setChunksLoading(false);
        }}
      >
        {selected && (
          <div className="app-document-detail" data-testid="document-detail" aria-busy={detailsLoading}>
            <div className="app-document-meta">
              <span><strong>{t('documents.fileName')}</strong>{selected.fileName}</span>
              <span><strong>{t('documents.format')}</strong>{selected.format.toUpperCase()}</span>
              <span><strong>{t('documents.size')}</strong>{formatBytes(selected.sizeBytes)}</span>
              <span>
                <strong>{t('common.status')}</strong>
                <Tag
                  theme={selected.failureCode === 'ocr_review_required' ? 'warning' : STATUS_THEMES[selected.status]}
                  variant="light"
                >
                  {t(selected.failureCode === 'ocr_review_required'
                    ? 'documents.status.review_required'
                    : `documents.status.${selected.status}`)}
                </Tag>
              </span>
              <span>
                <strong>{t('documents.qualityDecision')}</strong>
                {selected.qualityDecision
                  ? (
                    <Tag theme={QUALITY_THEMES[selected.qualityDecision]} variant="light" data-testid="document-quality-decision">
                      {t(`documents.quality.${selected.qualityDecision}`)}
                    </Tag>
                  )
                  : '—'}
              </span>
              <span>
                <strong>{t('documents.indexStatus')}</strong>
                {selected.indexStatus ? t(`documents.index.${selected.indexStatus}`) : '—'}
              </span>
              <span><strong>{t('documents.characters')}</strong>{selected.characterCount}</span>
              <span><strong>{t('documents.chunkCount')}</strong>{selected.chunkCount}</span>
              <span><strong>{t('documents.representationVersion')}</strong>{selected.representationVersion ?? '—'}</span>
              <span><strong>{t('documents.parserVersion')}</strong>{selected.parserVersion || '—'}</span>
              <span><strong>{t('documents.cleanerVersion')}</strong>{selected.cleanerVersion ?? '—'}</span>
              <span><strong>{t('documents.chunkerVersion')}</strong>{selected.chunkerVersion || '—'}</span>
              {selected.qualityReasons && selected.qualityReasons.length > 0 && (
                <div className="app-document-quality-reasons" role="status">
                  <strong>{t('documents.qualityReasons')}</strong>
                  <div>
                    {selected.qualityReasons.map((reason) => (
                      <Tag key={reason} theme="warning" variant="light">
                        {t(`documents.qualityReason.${reason}`)}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
              {selected.failureCode && (
                <div className="app-document-failure" role="status">
                  <strong>{t('documents.failureCode')}</strong>
                  <span className="app-document-failure__reason">
                    {t(`documents.failure.${selected.failureCode}`)}
                  </span>
                  <span className="app-document-failure__code">
                    {t('documents.failureCodeValue')}: <code>{selected.failureCode}</code>
                  </span>
                  <span className="app-document-failure__advice">
                    <b>{t('documents.failureAdviceLabel')}</b>
                    {t(selected.failureCode === 'embedding_failed'
                      ? 'documents.failureAdvice.embedding_failed'
                      : selected.failureCode === 'processing_failed'
                        ? 'documents.failureAdvice.processing_failed'
                        : selected.failureCode === 'ocr_review_required'
                          ? 'documents.failureAdvice.ocr_review_required'
                        : 'documents.failureAdvice.default')}
                  </span>
                </div>
              )}
            </div>

            {selected.reviewDraftSummary?.status === 'open' && (
              <div className="app-document-review-callout" role="status">
                <div>
                  <strong>{t('documents.reviewCalloutTitle')}</strong>
                  <span>
                    {t('documents.reviewCalloutDescription', {
                      engine: selected.extractionSummary?.engine ?? 'OCR',
                      count: selected.reviewDraftSummary.blockCount,
                      revision: selected.reviewDraftSummary.revision,
                    })}
                  </span>
                </div>
                <Button
                  theme="primary"
                  onClick={() => {
                    setSelected(null);
                    setReviewDocument(selected);
                  }}
                  data-testid="document-detail-review"
                >
                  {t('documents.review')}
                </Button>
              </div>
            )}

            {selected.status === 'ready' && selected.representationVersion !== 'document-ir-v1' && (
              <div className="app-document-upgrade" role="status">
                <div>
                  <strong>{t('documents.legacyTitle')}</strong>
                  <span>{t('documents.legacyDescription')}</span>
                </div>
                <Button
                  theme="primary"
                  variant="outline"
                  icon={<RefreshIcon />}
                  loading={busyId === selected.id}
                  onClick={() => handleReprocess(selected)}
                  data-testid="document-detail-reprocess"
                >
                  {t('documents.reprocess')}
                </Button>
              </div>
            )}

            <section className="app-document-section" aria-labelledby="document-structure-title">
              <div className="app-document-section__header">
                <div>
                  <h3 id="document-structure-title">{t('documents.structureTitle')}</h3>
                  <p>{t('documents.structureDescription')}</p>
                </div>
              </div>
              {selected.representationSummary ? (
                <>
                  <div className="app-document-stats">
                    <span><strong>{selected.representationSummary.blockCount}</strong>{t('documents.blocks')}</span>
                    <span><strong>{selected.representationSummary.metrics.includedBlockCount ?? 0}</strong>{t('documents.includedBlocks')}</span>
                    <span><strong>{selected.representationSummary.metrics.excludedBlockCount ?? 0}</strong>{t('documents.excludedBlocks')}</span>
                    <span><strong>{selected.representationSummary.metrics.pageCount ?? 0}</strong>{t('documents.pageCount')}</span>
                  </div>
                  {selected.representationSummary.warningCodes.length > 0 && (
                    <div className="app-document-warnings" role="status">
                      <strong>{t('documents.warnings')}</strong>
                      <div>
                        {selected.representationSummary.warningCodes.map((warning) => (
                          <Tag key={warning} theme="warning" variant="light">
                            {t(`documents.warning.${warning}`)}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="app-document-table-scroll">
                    <Table
                      rowKey="id"
                      data={blocks}
                      columns={blockColumns}
                      loading={blocksLoading}
                      empty={t('documents.blocksEmpty')}
                      tableLayout="fixed"
                      pagination={{ current: blockPage, pageSize: blockPageSize, total: blockTotal, showJumper: true }}
                      onPageChange={(info) => {
                        setBlockPage(info.current);
                        setBlockPageSize(info.pageSize);
                        fetchBlocks(selected.id, info.current, info.pageSize);
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="app-document-empty-note">{t('documents.noRepresentation')}</div>
              )}
            </section>

            <section className="app-document-section" aria-labelledby="document-processing-title">
              <div className="app-document-section__header">
                <div>
                  <h3 id="document-processing-title">{t('documents.processingTitle')}</h3>
                  <p>{t('documents.processingDescription')}</p>
                </div>
                {selected.processingSummary && (
                  <Tag
                    theme={selected.processingSummary.status === 'succeeded'
                      ? 'success'
                      : selected.processingSummary.status === 'failed' ? 'danger' : 'default'}
                    variant="light"
                  >
                    {t(`documents.processing.${selected.processingSummary.status}`)}
                  </Tag>
                )}
              </div>
              {selected.processingSummary ? (
                <ol className="app-document-timeline" data-testid="document-processing-timeline">
                  {selected.processingSummary.stages.map((stage) => (
                    <li key={`${stage.order}-${stage.name}`} data-status={stage.status}>
                      <span className="app-document-timeline__marker" aria-hidden="true" />
                      <div>
                        <strong>{t(`documents.stage.${stage.name}`)}</strong>
                        <span>
                          {t(`documents.processing.${stage.status}`)}
                          {' · '}
                          {formatStageDuration(stage.startedAt, stage.completedAt)}
                        </span>
                        {(stage.inputCount !== null || stage.outputCount !== null) && (
                          <small>
                            {t('documents.stageCounts', {
                              input: stage.inputCount ?? '—',
                              output: stage.outputCount ?? '—',
                            })}
                          </small>
                        )}
                        {stage.errorCode && <code>{stage.errorCode}</code>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="app-document-empty-note">{t('documents.noProcessingRecord')}</div>
              )}
            </section>

            <section className="app-document-section" aria-labelledby="document-chunks-title">
              <div className="app-document-section__header">
                <div>
                  <h3 id="document-chunks-title">{t('documents.chunksTitle')}</h3>
                  <p>{t('documents.chunksDescription')}</p>
                </div>
              </div>
              <div className="app-document-table-scroll">
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
            </section>
          </div>
        )}
      </Dialog>

      <Dialog
        visible={Boolean(selectedChunk)}
        header={t('documents.chunkContentTitle')}
        className="app-document-chunk-dialog"
        closeBtn={<Button data-testid="document-chunk-content-close" variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        footer={false}
        width="min(680px, calc(100vw - 32px))"
        onClose={() => setSelectedChunk(null)}
      >
        {selectedChunk && (
          <div className="app-document-chunk-content" data-testid="document-chunk-content">
            {selectedChunk.content}
          </div>
        )}
      </Dialog>

      <DocumentReviewDialog
        document={reviewDocument}
        onClose={() => setReviewDocument(null)}
        onPublished={handleReviewPublished}
      />
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

function formatBlockPreview(block: DocumentBlock): string {
  if (block.text) return block.text;
  if (block.items) return block.items.map((item) => item.text).join(' · ');
  if (block.cells) {
    return block.cells
      .slice()
      .sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex)
      .map((cell) => cell.text)
      .filter(Boolean)
      .join(' | ');
  }
  if (block.pairs) return block.pairs.map((pair) => `${pair.key}: ${pair.value}`).join(' · ');
  return block.altText || block.relationshipId || '—';
}

function formatStageDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '—';
  const milliseconds = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(2)} s`;
}

export default DocumentManagementPage;
