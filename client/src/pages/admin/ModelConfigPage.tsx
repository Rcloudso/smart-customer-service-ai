import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Form,
  Input,
  Select,
  Button,
  MessagePlugin,
} from 'tdesign-react';
import * as adminApi from '../../api/admin';
import type { ModelConfigResponseDTO, ModelConfigDTO } from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

const { FormItem } = Form;

/** Fields that represent API keys — special masking/password handling. */
const API_KEY_FIELDS: (keyof ModelConfigDTO)[] = ['llmApiKey', 'embedApiKey'];

/** Placeholder shown when the API key is unchanged from env/current. */
const API_KEY_PLACEHOLDER = '********';

/**
 * Model configuration page — display and edit LLM / Embedding model settings.
 */
export function ModelConfigPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ModelConfigResponseDTO | null>(null);

  // Track which fields the user has actually modified (to avoid accidental resets)
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());

  // Form state — mirrors the editable fields
  const [form, setForm] = useState<Record<string, string>>({
    llmApiBase: '',
    llmModel: '',
    llmApiKey: '',
    embedProvider: 'openai',
    embedApiBase: '',
    embedModel: '',
    embedApiKey: '',
  });

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getModelConfig();
      setConfig(data);
      setModifiedFields(new Set()); // reset dirty tracking on fresh load
      setForm({
        llmApiBase: data.llmApiBase,
        llmModel: data.llmModel,
        // For API keys: if overridden, show masked value as placeholder (don't prefill)
        llmApiKey: '',
        embedProvider: data.embedProvider,
        embedApiBase: data.embedApiBase,
        embedModel: data.embedModel,
        embedApiKey: '',
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

  /** Get the placeholder for an API key field based on override status. */
  const getApiKeyPlaceholder = (field: keyof ModelConfigDTO): string => {
    if (!config) return API_KEY_PLACEHOLDER;
    const overridden = field === 'llmApiKey'
      ? config.llmApiKeyOverridden
      : config.embedApiKeyOverridden;
    return overridden ? config[field] : API_KEY_PLACEHOLDER;
  };

  const handleFieldChange = (field: string, value: string): void => {
    setModifiedFields((prev) => new Set(prev).add(field));
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      // Build update payload — filter out empty strings.
      // Non-key fields: only include if the user actually modified them.
      const updates: Partial<ModelConfigDTO> = {};
      for (const [key, value] of Object.entries(form)) {
        if (value === '') continue;
        // Non-key fields: skip if not explicitly modified by the user
        if (!API_KEY_FIELDS.includes(key as keyof ModelConfigDTO) && !modifiedFields.has(key)) continue;
        (updates as Record<string, string>)[key] = value;
      }

      // Collect reset keys — fields explicitly cleared by user
      const resetKeys: string[] = [];
      for (const key of API_KEY_FIELDS) {
        // Only reset API key if user explicitly modified the field AND left it empty
        if (form[key] === '' && modifiedFields.has(key) && config) {
          const overridden = key === 'llmApiKey'
            ? config.llmApiKeyOverridden
            : config.embedApiKeyOverridden;
          if (overridden) {
            resetKeys.push(key);
          }
        }
      }
      // Also allow resetting non-key fields if explicitly cleared
      const nonKeyFields: (keyof ModelConfigDTO)[] = ['llmApiBase', 'llmModel', 'embedProvider', 'embedApiBase', 'embedModel'];
      for (const key of nonKeyFields) {
        if (form[key] === '' && config && config[key as keyof ModelConfigResponseDTO] !== '') {
          // Field was cleared — reset to env default
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
            <Select
              value="openai"
              disabled
              options={[{ label: 'OpenAI', value: 'openai' }]}
              style={{ width: '100%' }}
            />
          </FormItem>

          <FormItem label={t('config.apiBaseUrl')}>
            <Input
              value={form.llmApiBase}
              placeholder={config?.llmApiBase || 'https://api.openai.com/v1'}
              onChange={(val) => handleFieldChange('llmApiBase', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.model')}>
            <Input
              value={form.llmModel}
              placeholder={config?.llmModel || 'gpt-4o-mini'}
              onChange={(val) => handleFieldChange('llmModel', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.apiKey')}>
            <Input
              type="password"
              value={form.llmApiKey}
              placeholder={getApiKeyPlaceholder('llmApiKey')}
              onChange={(val) => handleFieldChange('llmApiKey', val as string)}
              disabled={loading}
            />
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
          <FormItem label={t('config.provider')}>
            <Select
              value={form.embedProvider}
              onChange={(val) => handleFieldChange('embedProvider', val as string)}
              options={[
                { label: 'OpenAI', value: 'openai' },
                { label: t('config.otherProvider'), value: 'other' },
              ]}
              style={{ width: '100%' }}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.apiBaseUrl')}>
            <Input
              value={form.embedApiBase}
              placeholder={config?.embedApiBase || ''}
              onChange={(val) => handleFieldChange('embedApiBase', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.model')}>
            <Input
              value={form.embedModel}
              placeholder={config?.embedModel || 'text-embedding-3-small'}
              onChange={(val) => handleFieldChange('embedModel', val as string)}
              disabled={loading}
            />
          </FormItem>

          <FormItem label={t('config.apiKey')}>
            <Input
              type="password"
              value={form.embedApiKey}
              placeholder={getApiKeyPlaceholder('embedApiKey')}
              onChange={(val) => handleFieldChange('embedApiKey', val as string)}
              disabled={loading}
            />
          </FormItem>
        </Form>
      </Card>
    </div>
  );
}

export default ModelConfigPage;
