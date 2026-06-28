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
import type { FaqEntry, IntentCategory } from '../../api/admin';
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
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FaqEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [category, setCategory] = useState('');
  const [keyword, setKeyword] = useState('');

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
      const message = err instanceof Error ? err.message : '加载FAQ列表失败';
      MessagePlugin.error(message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, category, keyword]);

  useEffect(() => {
    fetchFaqs();
  }, [fetchFaqs]);

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
      MessagePlugin.success('FAQ已删除');
      fetchFaqs();
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败';
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
        MessagePlugin.success('FAQ创建成功');
      } else if (editingId) {
        await adminApi.updateFaq(editingId, {
          question,
          answer,
          category: categoryVal,
          keywords,
        });
        MessagePlugin.success('FAQ更新成功');
      }
      setDialogVisible(false);
      fetchFaqs();
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      MessagePlugin.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      await adminApi.exportFaq();
      MessagePlugin.success('导出成功');
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      MessagePlugin.error(message);
    }
  };

  const handleImport = async (file: File) => {
    try {
      const result = await adminApi.importFaq(file);
      MessagePlugin.success(`成功导入 ${result.imported}/${result.total} 条FAQ`);
      fetchFaqs();
    } catch (err) {
      const message = err instanceof Error ? err.message : '导入失败';
      MessagePlugin.error(message);
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
          {new Date(row.updatedAt).toLocaleString('zh-CN')}
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
              onClick={() => handleEdit(row)}
            >
              {t('common.edit')}
            </Button>
            <Popconfirm
              content={t('faq.deleteConfirm')}
              onConfirm={() => handleDelete(row.id)}
            >
              <Button theme="danger" variant="text" size="small">
                {t('common.delete')}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', color: 'var(--app-text)' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 16px 0', color: 'var(--app-text)' }}>
        {t('faq.title')}
      </h2>

      {/* Filters & actions */}
      <Card bordered style={{ marginBottom: '16px' }}>
        <Space direction="horizontal" size="medium" style={{ width: '100%', flexWrap: 'wrap' }}>
          <Input
            placeholder={t('faq.searchPlaceholder')}
            value={keyword}
            onChange={(val: string) => setKeyword(val)}
            onEnter={handleSearch}
            prefixIcon={<SearchIcon />}
            style={{ width: '220px' }}
            clearable
          />
          <Select
            value={category}
            onChange={(val: SelectValue) => setCategory(String(val ?? ''))}
            options={categoryOptions}
            style={{ width: '120px' }}
          />
          <Button theme="primary" onClick={handleSearch} icon={<SearchIcon />}>
            {t('common.search')}
          </Button>
          <div style={{ flex: 1 }} />
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
        </Space>
      </Card>

      {/* Table */}
      <Card bordered>
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
