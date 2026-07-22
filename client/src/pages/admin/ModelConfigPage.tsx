import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Form,
  Input,
  Select,
  Button,
  MessagePlugin,
  Tag,
} from 'tdesign-react';
import * as adminApi from '../../api/admin';
import type { ModelConfigResponseDTO, ModelConfigDTO } from '../../api/admin';
import type { ModelProvider } from '../../types';
import { useTranslation } from '../../hooks/usePreferences';

const { FormItem } = Form;

/**
 * Model configuration page — display and edit LLM / Embedding model settings.
 */
export function ModelConfigPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [config, setConfig] = useState<ModelConfigResponseDTO | null>(null);

  // Track which fields the user has actually modified (to avoid accidental resets)
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());

  // Form state — mirrors the editable fields
  const [form, setForm] = useState<ModelConfigDTO>({
    llmProvider: 'openai',
    llmApiBase: '',
    llmModel: '',
    embedProvider: 'openai',
    embedApiBase: '',
    embedModel: '',
  });

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getModelConfig();
      setConfig(data);
      setModifiedFields(new Set()); // reset dirty tracking on fresh load
      setForm({
        llmProvider: data.llmProvider,
        llmApiBase: data.llmApiBase,
        llmModel: data.llmModel,
        embedProvider: data.embedProvider,
        embedApiBase: data.embedApiBase,
        embedModel: data.embedModel,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.loadFailed');
      MessagePlugin.error(message);
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleFieldChange = (field: keyof ModelConfigDTO, value: string): void => {
    setModifiedFields((prev) => new Set(prev).add(field));
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const providerOptions = [
    { label: 'OpenAI', value: 'openai' },
    { label: 'OpenAI Compatible', value: 'openai-compatible' },
    { label: t('config.otherProvider'), value: 'other' },
  ];

  const handleSave = async (): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const updates: Partial<ModelConfigDTO> = {};
      for (const [key, value] of Object.entries(form)) {
        if (value === '') continue;
        if (!modifiedFields.has(key)) continue;
        (updates as Record<string, string>)[key] = value;
      }

      const resetKeys: string[] = [];
      for (const key of Object.keys(form) as Array<keyof ModelConfigDTO>) {
        if (form[key] === '' && modifiedFields.has(key) && config?.[key] !== '') {
          resetKeys.push(key);
        }
      }

      await adminApi.updateModelConfig(updates, resetKeys);
      MessagePlugin.success(t('config.saved'));
      await fetchConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.saveFailed');
      MessagePlugin.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="app-page-container app-page-container--narrow">
      {/* Page header */}
      <div className="app-page-header">
        <h2 className="app-page-title">
          {t('config.title')}
        </h2>
        <div className="app-page-actions">
          <Button theme="primary" onClick={handleSave} loading={saving}>
            {t('config.save')}
          </Button>
        </div>
      </div>

      {/* LLM Configuration Card */}
      <Card
        title={t('config.llmTitle')}
        bordered
        className="app-panel-card"
        style={{ marginBottom: '16px' }}
        bodyStyle={{ padding: '24px' }}
      >
        <Form layout="vertical" labelWidth={120}>
          <FormItem label={t('config.provider')} help={t('config.providerHelp')}>
            <div data-testid="llm-provider-select">
              <Select
                value={form.llmProvider}
                onChange={(val) => handleFieldChange('llmProvider', val as ModelProvider)}
                options={providerOptions}
                style={{ width: '100%' }}
                disabled={loading}
              />
            </div>
          </FormItem>

          {form.llmProvider !== 'openai' && (
            <FormItem label={t('config.apiBaseUrl')}>
              <div data-testid="llm-api-base-field">
                <Input
                  value={form.llmApiBase}
                  placeholder={config?.llmApiBase || ''}
                  onChange={(val) => handleFieldChange('llmApiBase', val as string)}
                  disabled={loading}
                />
              </div>
            </FormItem>
          )}

          <FormItem label={t('config.model')}>
            <Input
              value={form.llmModel}
              placeholder={config?.llmModel || 'gpt-4o-mini'}
              onChange={(val) => handleFieldChange('llmModel', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.apiKey')}>
            <div className="app-config-secret-status" data-testid="llm-api-key-status">
              <Tag theme={config?.llmApiKeyConfigured ? 'success' : 'default'} variant="light">
                {t(config?.llmApiKeyConfigured ? 'config.apiKeyConfigured' : 'config.apiKeyNotConfigured')}
              </Tag>
              <span>
                {t('config.apiKeyEnvironmentHelp', { variable: 'LLM_API_KEY / OPENAI_API_KEY' })}
              </span>
            </div>
          </FormItem>
        </Form>
      </Card>

      {/* Embedding Configuration Card */}
      <Card
        title={t('config.embeddingTitle')}
        bordered
        className="app-panel-card"
        style={{ marginBottom: '16px' }}
        bodyStyle={{ padding: '24px' }}
      >
        <Form layout="vertical" labelWidth={120}>
          <FormItem label={t('config.provider')} help={t('config.providerHelp')}>
            <div data-testid="embed-provider-select">
              <Select
                value={form.embedProvider}
                onChange={(val) => handleFieldChange('embedProvider', val as ModelProvider)}
                options={providerOptions}
                style={{ width: '100%' }}
                disabled={loading}
              />
            </div>
          </FormItem>

          {form.embedProvider !== 'openai' && (
            <FormItem label={t('config.apiBaseUrl')}>
              <div data-testid="embed-api-base-field">
                <Input
                  value={form.embedApiBase}
                  placeholder={config?.embedApiBase || ''}
                  onChange={(val) => handleFieldChange('embedApiBase', val as string)}
                  disabled={loading}
                />
              </div>
            </FormItem>
          )}

          <FormItem label={t('config.model')}>
            <Input
              value={form.embedModel}
              placeholder={config?.embedModel || 'text-embedding-3-small'}
              onChange={(val) => handleFieldChange('embedModel', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.apiKey')}>
            <div className="app-config-secret-status" data-testid="embed-api-key-status">
              <Tag theme={config?.embedApiKeyConfigured ? 'success' : 'default'} variant="light">
                {t(config?.embedApiKeyConfigured ? 'config.apiKeyConfigured' : 'config.apiKeyNotConfigured')}
              </Tag>
              <span>
                {t('config.apiKeyEnvironmentHelp', { variable: 'EMBED_API_KEY' })}
              </span>
            </div>
          </FormItem>
        </Form>
      </Card>
    </div>
  );
}

export default ModelConfigPage;
