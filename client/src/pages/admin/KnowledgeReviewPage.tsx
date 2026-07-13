import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Form,
  Input,
  MessagePlugin,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import type { SelectValue } from 'tdesign-react';
import { CloseIcon, SearchIcon } from 'tdesign-icons-react';
import * as adminApi from '../../api/admin';
import type {
  IntentCategory,
  KnowledgeReviewItem,
  KnowledgeReviewStats,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
} from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

const { FormItem } = Form;

interface ConvertFormValues {
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string;
}

const EMPTY_STATS: KnowledgeReviewStats = {
  pending: 0,
  converted: 0,
  dismissed: 0,
  total: 0,
};

const STATUS_THEMES: Record<KnowledgeReviewStatus, 'warning' | 'success' | 'default'> = {
  pending: 'warning',
  converted: 'success',
  dismissed: 'default',
};

export function KnowledgeReviewPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [items, setItems] = useState<KnowledgeReviewItem[]>([]);
  const [stats, setStats] = useState<KnowledgeReviewStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<KnowledgeReviewStatus | ''>('pending');
  const [triggerReason, setTriggerReason] = useState<KnowledgeReviewTriggerReason | ''>('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<KnowledgeReviewItem | null>(null);
  const [convertItem, setConvertItem] = useState<KnowledgeReviewItem | null>(null);
  const [dismissItem, setDismissItem] = useState<KnowledgeReviewItem | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [convertInitial, setConvertInitial] = useState<ConvertFormValues | null>(null);
  const [convertForm] = Form.useForm();

  const statusOptions = useMemo(() => [
    { label: t('common.all'), value: '' },
    { label: t('knowledgeReview.status.pending'), value: 'pending' },
    { label: t('knowledgeReview.status.converted'), value: 'converted' },
    { label: t('knowledgeReview.status.dismissed'), value: 'dismissed' },
  ], [language]);

  const reasonOptions = useMemo(() => [
    { label: t('common.all'), value: '' },
    { label: t('knowledgeReview.reason.no_match'), value: 'no_match' },
    { label: t('knowledgeReview.reason.low_retrieval_score'), value: 'low_retrieval_score' },
    { label: t('knowledgeReview.reason.negative_feedback'), value: 'negative_feedback' },
  ], [language]);

  const categoryOptions = useMemo(() => ['refund', 'order', 'technical', 'general'].map((value) => ({
    label: t(`intent.${value}`),
    value,
  })), [language]);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listKnowledgeReviews({
        status: status || undefined,
        triggerReason: triggerReason || undefined,
        keyword: keyword.trim() || undefined,
        page,
        pageSize,
      });
      setItems(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : t('knowledgeReview.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [status, triggerReason, keyword, page, pageSize, language]);

  const fetchStats = useCallback(async () => {
    try {
      setStats(await adminApi.getKnowledgeReviewStats());
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : t('knowledgeReview.statsLoadFailed'));
    }
  }, [language]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const refresh = async () => {
    await Promise.all([fetchReviews(), fetchStats()]);
  };

  const openConvert = (item: KnowledgeReviewItem) => {
    const initial = {
      question: item.question,
      answer: item.answer,
      category: item.intent ?? 'general',
      keywords: '',
    } as ConvertFormValues;
    setConvertInitial(initial);
    setConvertItem(item);
  };

  const submitConvert = async () => {
    const validation = await convertForm.validate();
    if (validation !== true || !convertItem) return;
    const values = convertForm.getFieldsValue(['question', 'answer', 'category', 'keywords']);
    setSubmitting(true);
    try {
      await adminApi.convertKnowledgeReview(convertItem.id, {
        question: String(values.question ?? '').trim(),
        answer: String(values.answer ?? '').trim(),
        category: String(values.category ?? 'general') as IntentCategory,
        keywords: String(values.keywords ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      });
      MessagePlugin.success(t('knowledgeReview.converted'));
      setConvertItem(null);
      await refresh();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : t('knowledgeReview.convertFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDismiss = async () => {
    if (!dismissItem) return;
    setSubmitting(true);
    try {
      await adminApi.dismissKnowledgeReview(dismissItem.id, dismissReason.trim() || undefined);
      MessagePlugin.success(t('knowledgeReview.dismissed'));
      setDismissItem(null);
      setDismissReason('');
      await refresh();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : t('knowledgeReview.dismissFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      colKey: 'question',
      title: t('knowledgeReview.question'),
      width: 260,
      ellipsis: true,
      cell: ({ row }: { row: KnowledgeReviewItem }) => <strong>{row.question}</strong>,
    },
    {
      colKey: 'triggerReason',
      title: t('knowledgeReview.triggerReason'),
      width: 150,
      cell: ({ row }: { row: KnowledgeReviewItem }) => t(`knowledgeReview.reason.${row.triggerReason}`),
    },
    {
      colKey: 'topScore',
      title: t('knowledgeReview.topScore'),
      width: 100,
      cell: ({ row }: { row: KnowledgeReviewItem }) => row.retrievalSnapshot[0]
        ? row.retrievalSnapshot[0].similarity.toFixed(3)
        : '—',
    },
    {
      colKey: 'rating',
      title: t('knowledgeReview.rating'),
      width: 80,
      cell: ({ row }: { row: KnowledgeReviewItem }) => row.rating ? `${row.rating}/5` : '—',
    },
    {
      colKey: 'status',
      title: t('common.status'),
      width: 100,
      cell: ({ row }: { row: KnowledgeReviewItem }) => (
        <Tag theme={STATUS_THEMES[row.status]} variant="light">
          {t(`knowledgeReview.status.${row.status}`)}
        </Tag>
      ),
    },
    {
      colKey: 'createdAt',
      title: t('knowledgeReview.createdAt'),
      width: 170,
      cell: ({ row }: { row: KnowledgeReviewItem }) => new Date(row.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'),
    },
    {
      colKey: 'actions',
      title: t('common.actions'),
      width: 220,
      fixed: 'right' as const,
      cell: ({ row }: { row: KnowledgeReviewItem }) => (
        <Space size="small">
          <Button variant="text" size="small" onClick={() => setSelected(row)} data-testid="knowledge-review-view">
            {t('knowledgeReview.view')}
          </Button>
          {row.status === 'pending' && (
            <>
              <Button theme="primary" variant="text" size="small" onClick={() => openConvert(row)} data-testid="knowledge-review-convert">
                {t('knowledgeReview.convert')}
              </Button>
              <Button theme="danger" variant="text" size="small" onClick={() => setDismissItem(row)} data-testid="knowledge-review-dismiss">
                {t('knowledgeReview.dismiss')}
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="app-page-container" data-testid="knowledge-review-page">
      <div className="app-page-header">
        <div>
          <h2 className="app-page-title">{t('knowledgeReview.title')}</h2>
          <p className="app-page-description">{t('knowledgeReview.description')}</p>
        </div>
      </div>

      <div className="app-knowledge-stats" data-testid="knowledge-review-stats">
        {(['pending', 'converted', 'dismissed', 'total'] as const).map((key) => (
          <Card key={key} bordered className="app-knowledge-stat-card">
            <span>{t(`knowledgeReview.stats.${key}`)}</span>
            <strong>{stats[key]}</strong>
          </Card>
        ))}
      </div>

      <Card bordered className="app-toolbar-card">
        <div className="app-toolbar-row">
          <Input
            value={keyword}
            onChange={(value: string) => setKeyword(value)}
            onEnter={() => { setPage(1); fetchReviews(); }}
            placeholder={t('knowledgeReview.searchPlaceholder')}
            prefixIcon={<SearchIcon />}
            clearable
            className="app-filter-input"
            data-testid="knowledge-review-keyword"
          />
          <Select
            value={status}
            onChange={(value: SelectValue) => { setStatus(String(value ?? '') as KnowledgeReviewStatus | ''); setPage(1); }}
            options={statusOptions}
            className="app-filter-select"
          />
          <Select
            value={triggerReason}
            onChange={(value: SelectValue) => { setTriggerReason(String(value ?? '') as KnowledgeReviewTriggerReason | ''); setPage(1); }}
            options={reasonOptions}
            className="app-filter-select"
          />
          <Button theme="primary" icon={<SearchIcon />} onClick={() => { setPage(1); fetchReviews(); }}>
            {t('common.search')}
          </Button>
        </div>
      </Card>

      <Card bordered className="app-table-card">
        <div data-testid="knowledge-review-table">
          <Table
            rowKey="id"
            data={items}
            columns={columns}
            loading={loading}
            empty={t('knowledgeReview.empty')}
            tableLayout="fixed"
            pagination={{ current: page, pageSize, total, showJumper: true }}
            onPageChange={(info) => { setPage(info.current); setPageSize(info.pageSize); }}
          />
        </div>
      </Card>

      <Dialog
        visible={Boolean(selected)}
        header={t('knowledgeReview.detailTitle')}
        closeBtn={<Button variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        footer={false}
        width="720px"
        onClose={() => setSelected(null)}
      >
        {selected && (
          <div className="app-knowledge-detail" data-testid="knowledge-review-detail">
            <section><h4>{t('knowledgeReview.userQuestion')}</h4><p>{selected.question}</p></section>
            <section><h4>{t('knowledgeReview.aiAnswer')}</h4><p>{selected.answer}</p></section>
            <section>
              <h4>{t('knowledgeReview.intent')}</h4>
              <p>{t(`intent.${selected.intent ?? 'general'}`)} · {selected.intentConf?.toFixed(3) ?? '—'}</p>
            </section>
            <section>
              <h4>{t('knowledgeReview.retrievalSnapshot')}</h4>
              {selected.retrievalSnapshot.length === 0 ? <p>{t('knowledgeReview.noRetrieval')}</p> : (
                <div className="app-knowledge-snapshot-list">
                  {selected.retrievalSnapshot.map((snapshot) => (
                    <div key={snapshot.knowledgeId} className="app-knowledge-snapshot">
                      <strong>{snapshot.title}</strong>
                      <span>{snapshot.source ?? '—'} · {snapshot.similarity.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </Dialog>

      <Dialog
        visible={Boolean(convertItem)}
        header={t('knowledgeReview.convertTitle')}
        closeBtn={<Button variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        confirmBtn={{ content: t('knowledgeReview.convert'), loading: submitting }}
        onConfirm={submitConvert}
        onClose={() => setConvertItem(null)}
        destroyOnClose
        width="680px"
      >
        {convertInitial && (
          <Form
            key={`knowledge-convert-${convertItem?.id}`}
            form={convertForm}
            initialData={convertInitial}
            labelAlign="top"
          >
            <FormItem label={t('knowledgeReview.question')} name="question" rules={[{ required: true }]}>
              <Input data-testid="knowledge-convert-question" />
            </FormItem>
            <FormItem label={t('knowledgeReview.answer')} name="answer" rules={[{ required: true }]}>
              <Textarea autosize={{ minRows: 4, maxRows: 8 }} data-testid="knowledge-convert-answer" />
            </FormItem>
            <FormItem label={t('faq.category')} name="category" rules={[{ required: true }]}>
              <Select options={categoryOptions} />
            </FormItem>
            <FormItem label={t('faq.keywords')} name="keywords">
              <Input placeholder={t('faq.keywordsPlaceholder')} />
            </FormItem>
          </Form>
        )}
      </Dialog>

      <Dialog
        visible={Boolean(dismissItem)}
        header={t('knowledgeReview.dismissTitle')}
        closeBtn={<Button variant="text" shape="square" aria-label={t('common.close')} icon={<CloseIcon />} />}
        confirmBtn={{ content: t('knowledgeReview.dismiss'), theme: 'danger', loading: submitting }}
        onConfirm={submitDismiss}
        onClose={() => { setDismissItem(null); setDismissReason(''); }}
      >
        <Textarea
          value={dismissReason}
          onChange={(value: string) => setDismissReason(value)}
          maxlength={500}
          placeholder={t('knowledgeReview.dismissPlaceholder')}
          data-testid="knowledge-dismiss-reason"
        />
      </Dialog>
    </div>
  );
}

export default KnowledgeReviewPage;
