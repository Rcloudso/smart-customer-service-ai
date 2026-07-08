import React, { useState, useEffect, useCallback } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Input,
  Select,
  Tag,
  Dialog,
  MessagePlugin,
  Form,
  Textarea,
  Popconfirm,
  Upload,
} from 'tdesign-react';
import type { SelectValue } from 'tdesign-react';
import type { UploadFile } from 'tdesign-react';
import {
  AddIcon,
  DownloadIcon,
  RefreshIcon,
  SearchIcon,
  UploadIcon,
} from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type { FaqDebugResult, FaqEntry, FaqIndexStatus, IntentCategory } from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

/** Simplified column definition to avoid depending on TDesign's internal TableColumn type. */
interface SimpleColumn {
  colKey: string;
  title: string;
  width?: number;
  ellipsis?: boolean;
  cell?: (params: { row: FaqEntry }) => React.ReactNode;
}

const { FormItem } = Form;

const CATEGORY_OPTION_KEYS = [
  { labelKey: 'common.all', value: '' },
  { labelKey: 'intent.refund', value: 'refund' },
  { labelKey: 'intent.order', value: 'order' },
  { labelKey: 'intent.technical', value: 'technical' },
  { labelKey: 'intent.general', value: 'general' },
];

const CATEGORY_TAG_THEMES: Record<string, 'danger' | 'primary' | 'warning' | 'default'> = {
  refund: 'danger',
  order: 'primary',
  technical: 'warning',
  general: 'default',
};

const DEBUG_SOURCE_THEMES: Record<string, 'success' | 'primary' | 'warning' | 'default'> = {
  hybrid: 'success',
  vector: 'primary',
  keyword: 'warning',
};

interface FaqFormValues {
  question: string;
  answer: string;
  category: string;
  keywords: string;
}

const EMPTY_FAQ_FORM: FaqFormValues = {
  question: '',
  answer: '',
  category: 'general',
  keywords: '',
};

/**
 * FAQ management page with CRUD operations, import/export, and search.
 */
export function FaqManagementPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FaqEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [category, setCategory] = useState('');
  const [keyword, setKeyword] = useState('');
  const [indexStatus, setIndexStatus] = useState<FaqIndexStatus | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const [debugQuery, setDebugQuery] = useState('');
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugResult, setDebugResult] = useState<FaqDebugResult | null>(null);

  // Dialog state
  const [dialogVisible, setDialogVisible] = useState(false);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogFormValues, setDialogFormValues] = useState<FaqFormValues>(EMPTY_FAQ_FORM);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const categoryOptions = CATEGORY_OPTION_KEYS.map((option) => ({
    label: option.value === '' ? `${t('common.all')} ${t('faq.category')}` : t(option.labelKey),
    value: option.value,
  }));

  const fetchFaqs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listFaq({
        category: category || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      });
      setData(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('faq.listLoadFailed');
      MessagePlugin.error(message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, category, keyword, language]);

  useEffect(() => {
    fetchFaqs();
  }, [fetchFaqs]);

  const fetchIndexStatus = useCallback(async () => {
    setIndexLoading(true);
    try {
      const status = await adminApi.getFaqIndexStatus();
      setIndexStatus(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('faq.indexStatusLoadFailed');
      MessagePlugin.error(message);
    } finally {
      setIndexLoading(false);
    }
  }, [language]);

  useEffect(() => {
    fetchIndexStatus();
  }, [fetchIndexStatus]);

  const handleSearch = () => {
    setPage(1);
    fetchFaqs();
  };

  const handleCreate = () => {
    setDialogMode('create');
    setEditingId(null);
    setDialogFormValues({ ...EMPTY_FAQ_FORM });
    setDialogVisible(true);
  };

  const handleEdit = (entry: FaqEntry) => {
    setDialogMode('edit');
    setEditingId(entry.id);
    setDialogFormValues({
      question: entry.question,
      answer: entry.answer,
      category: entry.category,
      keywords: (entry.keywords ?? []).join(', '),
    });
    setDialogVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await adminApi.deleteFaq(id);
      MessagePlugin.success(t('faq.deleted'));
      fetchFaqs();
      fetchIndexStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.deleteFailed');
      MessagePlugin.error(message);
    }
  };

  const handleDialogSubmit = async () => {
    const validateResult = await form.validate();
    if (validateResult !== true) return;

    const values = form.getFieldsValue(['question', 'answer', 'category', 'keywords']);
    const question = (values.question as string || '').trim();
    const answer = (values.answer as string || '').trim();
    const categoryVal = (values.category as string || 'general').trim();
    const keywordsStr = (values.keywords as string || '').trim();

    if (!question || !answer) {
      MessagePlugin.warning(t('faq.emptyWarning'));
      return;
    }

    const keywords = keywordsStr
      ? keywordsStr.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    setSubmitting(true);
    try {
      if (dialogMode === 'create') {
        await adminApi.createFaq({ question, answer, category: categoryVal, keywords });
        MessagePlugin.success(t('faq.created'));
      } else if (editingId) {
        await adminApi.updateFaq(editingId, {
          question,
          answer,
          category: categoryVal,
          keywords,
        });
        MessagePlugin.success(t('faq.updated'));
      }
      setDialogVisible(false);
      fetchFaqs();
      fetchIndexStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.operationFailed');
      MessagePlugin.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      await adminApi.exportFaq();
      MessagePlugin.success(t('common.exportSuccess'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.exportFailed');
      MessagePlugin.error(message);
    }
  };

  const handleImport = async (file: File) => {
    try {
      const result = await adminApi.importFaq(file);
      MessagePlugin.success(t('faq.imported', { imported: result.imported, total: result.total }));
      fetchFaqs();
      fetchIndexStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('faq.importFailed');
      MessagePlugin.error(message);
    }
  };

  const handleRebuildIndex = async () => {
    setRebuildingIndex(true);
    try {
      const status = await adminApi.rebuildFaqIndex();
      setIndexStatus(status);
      MessagePlugin.success(t('faq.indexRebuilt'));
      fetchFaqs();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('faq.indexRebuildFailed');
      MessagePlugin.error(message);
    } finally {
      setRebuildingIndex(false);
    }
  };

  const handleDebugSearch = async () => {
    const query = debugQuery.trim();
    if (!query) {
      MessagePlugin.warning(t('faq.debugEmptyWarning'));
      return;
    }

    setDebugLoading(true);
    try {
      const result = await adminApi.debugFaqSearch({ query, topK: 5 });
      setDebugResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('faq.debugFailed');
      MessagePlugin.error(message);
    } finally {
      setDebugLoading(false);
    }
  };

  const handlePageChange = (pageInfo: { current: number; pageSize: number }) => {
    setPage(pageInfo.current);
    setPageSize(pageInfo.pageSize);
  };

  const columns: SimpleColumn[] = [
    {
      colKey: 'question',
      title: t('faq.question'),
      width: 220,
      ellipsis: true,
      cell: ({ row }: { row: FaqEntry }) => (
        <span style={{ fontWeight: 500 }}>{row.question}</span>
      ),
    },
    {
      colKey: 'answer',
      title: t('faq.answer'),
      ellipsis: true,
      cell: ({ row }: { row: FaqEntry }) => (
        <span style={{ color: 'var(--app-text-secondary)', fontSize: '13px' }}>
          {row.answer.length > 80
            ? row.answer.slice(0, 80) + '...'
            : row.answer}
        </span>
      ),
    },
    {
      colKey: 'category',
      title: t('faq.category'),
      width: 80,
      cell: ({ row }: { row: FaqEntry }) => {
        return (
          <Tag
            theme={CATEGORY_TAG_THEMES[row.category] || 'default'}
            variant="light"
            size="small"
          >
            {t(`intent.${row.category}`) || row.category}
          </Tag>
        );
      },
    },
    {
      colKey: 'isActive',
      title: t('common.status'),
      width: 72,
      cell: ({ row }: { row: FaqEntry }) => {
        return (
          <Tag
            theme={row.isActive ? 'success' : 'default'}
            variant="light"
            size="small"
          >
            {row.isActive ? t('faq.active') : t('faq.inactive')}
          </Tag>
        );
      },
    },
    {
      colKey: 'updatedAt',
      title: t('faq.updatedAt'),
      width: 150,
      cell: ({ row }: { row: FaqEntry }) => (
        <span style={{ fontSize: '12px', color: 'var(--app-text-muted)' }}>
          {new Date(row.updatedAt).toLocaleString(dateLocale)}
        </span>
      ),
    },
    {
      colKey: 'actions',
      title: t('common.actions'),
      width: 140,
      cell: ({ row }: { row: FaqEntry }) => {
        return (
          <Space size="small">
            <Button
              theme="primary"
              variant="text"
              size="small"
              className="app-table-action-button"
              onClick={() => handleEdit(row)}
            >
              {t('common.edit')}
            </Button>
            <Popconfirm
              content={t('faq.deleteConfirm')}
              onConfirm={() => handleDelete(row.id)}
            >
              <Button theme="danger" variant="text" size="small" className="app-table-action-button">
                {t('common.delete')}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="app-page-container">
      <div className="app-page-header">
        <h2 className="app-page-title">
          {t('faq.title')}
        </h2>
      </div>

      {/* Filters & actions */}
      <Card bordered className="app-toolbar-card">
        <div className="app-toolbar-row">
          <Input
            placeholder={t('faq.searchPlaceholder')}
            value={keyword}
            onChange={(val: string) => setKeyword(val)}
            onEnter={handleSearch}
            prefixIcon={<SearchIcon />}
            className="app-filter-input"
            clearable
          />
          <Select
            value={category}
            onChange={(val: SelectValue) => setCategory(String(val ?? ''))}
            options={categoryOptions}
            className="app-filter-select"
          />
          <Button theme="primary" onClick={handleSearch} icon={<SearchIcon />}>
            {t('common.search')}
          </Button>
          <div className="app-toolbar-spacer" />
          <div className="app-toolbar-actions">
            <Button theme="primary" onClick={handleCreate} icon={<AddIcon />}>
              {t('faq.add')}
            </Button>
            <Upload
              action="#"
              theme="file"
              accept=".csv,.json"
              autoUpload={false}
              onChange={(files: UploadFile | UploadFile[]) => {
                const file = (Array.isArray(files) ? files[0] : files) as UploadFile;
                if (file?.raw) {
                  handleImport(file.raw as File);
                }
              }}
            >
              <Button variant="outline" icon={<UploadIcon />}>
                {t('faq.import')}
              </Button>
            </Upload>
            <Button variant="outline" onClick={handleExport} icon={<DownloadIcon />}>
              {t('common.exportCsv')}
            </Button>
            <Button variant="outline" onClick={fetchFaqs} icon={<RefreshIcon />}>
              {t('common.refresh')}
            </Button>
          </div>
          <div className="app-index-status" data-testid="faq-index-status">
            <span className="app-index-status__label">{t('faq.indexStatus')}</span>
            <Tag
              theme={indexStatus?.initialized ? 'success' : 'warning'}
              variant="light"
              size="small"
            >
              {indexStatus?.initialized ? t('faq.indexInitialized') : t('faq.indexNotInitialized')}
            </Tag>
            <span className="app-index-status__summary">
              {indexLoading || !indexStatus
                ? t('common.loading')
                : t('faq.indexSummary', {
                  indexed: indexStatus.indexedCount,
                  active: indexStatus.activeCount,
                  missing: indexStatus.missingEmbeddingCount,
                })}
            </span>
            {indexStatus?.embeddingDimensions ? (
              <Tag variant="outline" size="small">
                {t('faq.embeddingDimensions', { count: indexStatus.embeddingDimensions })}
              </Tag>
            ) : null}
            <span className="app-index-status__meta">
              {indexStatus?.lastRebuiltAt
                ? t('faq.lastRebuiltAt', {
                  time: new Date(indexStatus.lastRebuiltAt).toLocaleString(dateLocale),
                })
                : t('faq.lastRebuiltNever')}
            </span>
            {indexStatus?.lastError ? (
              <span className="app-index-status__error">
                {t('faq.indexError')}: {indexStatus.lastError}
              </span>
            ) : null}
            <div className="app-toolbar-spacer" />
            <Button
              variant="outline"
              loading={rebuildingIndex}
              onClick={handleRebuildIndex}
              icon={<RefreshIcon />}
              data-testid="faq-rebuild-index-button"
            >
              {t('faq.rebuildIndex')}
            </Button>
          </div>
        </div>
      </Card>

      <div data-testid="faq-debug-panel">
        <Card bordered className="app-debug-card">
          <div className="app-debug-header">
            <h3>{t('faq.debugTitle')}</h3>
            <span>{t('faq.debugSubtitle')}</span>
          </div>
          <div className="app-debug-search">
            <Input
              value={debugQuery}
              onChange={(val: string) => setDebugQuery(val)}
              onEnter={handleDebugSearch}
              placeholder={t('faq.debugPlaceholder')}
              prefixIcon={<SearchIcon />}
              clearable
              data-testid="faq-debug-query"
            />
            <Button
              theme="primary"
              onClick={handleDebugSearch}
              loading={debugLoading}
              icon={<SearchIcon />}
              data-testid="faq-debug-submit"
            >
              {t('faq.debugSubmit')}
            </Button>
          </div>
          {debugResult ? (
            <div className="app-debug-results" data-testid="faq-debug-results">
              <div className="app-debug-meta">
                <span>{t('faq.debugQuery')}: {debugResult.query}</span>
                <span>{t('faq.debugGeneratedAt')}: {new Date(debugResult.generatedAt).toLocaleString(dateLocale)}</span>
              </div>
              {debugResult.matches.length === 0 ? (
                <div className="app-debug-empty">{t('faq.debugNoResults')}</div>
              ) : (
                <div className="app-debug-list">
                  {debugResult.matches.map((match) => (
                    <div className="app-debug-item" key={match.id}>
                      <div className="app-debug-item__main">
                        <span className="app-debug-rank">#{match.rank}</span>
                        <span className="app-debug-question">{match.question}</span>
                        <Tag
                          theme={DEBUG_SOURCE_THEMES[match.source ?? 'keyword'] ?? 'default'}
                          variant="light"
                          size="small"
                        >
                          {match.source ?? 'keyword'}
                        </Tag>
                      </div>
                      <div className="app-debug-scores">
                        <span>{t('faq.debugBestScore')}: {match.bestScore.toFixed(3)}</span>
                        <span>{t('faq.debugSimilarity')}: {match.similarity.toFixed(3)}</span>
                        <span>{t('faq.debugKeywordScore')}: {(match.keywordScore ?? 0).toFixed(3)}</span>
                        <span>{t('faq.debugVectorScore')}: {(match.vectorScore ?? 0).toFixed(3)}</span>
                      </div>
                      <div className="app-debug-reason">{match.rankingReason}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </Card>
      </div>

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

      {/* Create/Edit Dialog */}
      <Dialog
        header={dialogMode === 'create' ? t('faq.createTitle') : t('faq.editTitle')}
        visible={dialogVisible}
        onClose={() => setDialogVisible(false)}
        onConfirm={handleDialogSubmit}
        confirmBtn={{ content: dialogMode === 'create' ? t('common.create') : t('common.save'), loading: submitting }}
        cancelBtn={t('common.cancel')}
        width="600px"
        destroyOnClose
      >
        <Form
          key={`faq-dialog-${dialogMode}-${editingId ?? 'new'}`}
          form={form}
          initialData={dialogFormValues}
          labelAlign="top"
          resetType="initial"
        >
          <FormItem
            label={t('faq.question')}
            name="question"
            rules={[{ required: true, message: t('faq.requiredQuestion') }]}
          >
            <Input placeholder={t('faq.questionPlaceholder')} maxlength={500} />
          </FormItem>
          <FormItem
            label={t('faq.answer')}
            name="answer"
            rules={[{ required: true, message: t('faq.requiredAnswer') }]}
          >
            <Textarea
              placeholder={t('faq.answerPlaceholder')}
              autosize={{ minRows: 3, maxRows: 8 }}
              maxlength={2000}
            />
          </FormItem>
          <FormItem
            label={t('faq.category')}
            name="category"
            rules={[{ required: true, message: t('faq.requiredCategory') }]}
          >
            <Select
              options={categoryOptions.filter((o) => o.value !== '')}
            />
          </FormItem>
          <FormItem
            label={t('faq.keywords')}
            name="keywords"
            help={t('faq.keywordsHelp')}
          >
            <Input placeholder={t('faq.keywordsPlaceholder')} />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
}

export default FaqManagementPage;
