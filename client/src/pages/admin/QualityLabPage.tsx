import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Dialog,
  Input,
  MessagePlugin,
  Progress,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'tdesign-react';
import * as adminApi from '../../api/admin';
import type {
  PolicyGateResult,
  QualityCase,
  QualityDatasetVersion,
  QualityRun,
  RetrievalPolicy,
  RetrievalPolicyConfig,
} from '../../types';
import { useTranslation } from '../../hooks/usePreferences';
import './QualityLabPage.css';

const DEFAULT_MATRIX: RetrievalPolicyConfig[] = [0.75, 0.8, 0.85].flatMap(
  (directFaqThreshold) => [0.5, 0.55, 0.6].flatMap(
    (generationEvidenceThreshold) => ['none', 'local_overlap_v1'].map(
      (rerankerMode) => ({
        directFaqThreshold,
        generationEvidenceThreshold,
        sourceDiversityRatio: 0.6,
        rerankerMode: rerankerMode as RetrievalPolicyConfig['rerankerMode'],
      }),
    ),
  ),
);

type CaseDraft = Omit<QualityCase, 'id' | 'versionId' | 'createdAt'>;

const emptyCase: CaseDraft = {
  query: '',
  expectedAnswerMode: 'direct_faq' as const,
  expectedGroundingStatus: 'sufficient' as const,
  expectedSources: [{ knowledgeType: 'faq' as const, knowledgeId: '' }],
  language: 'zh' as const,
  tags: [] as string[],
};

export function QualityLabPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [datasets, setDatasets] = useState<QualityDatasetVersion[]>([]);
  const [cases, setCases] = useState<QualityCase[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [runs, setRuns] = useState<QualityRun[]>([]);
  const [currentPolicy, setCurrentPolicy] = useState<RetrievalPolicy | null>(null);
  const [policyHistory, setPolicyHistory] = useState<RetrievalPolicy[]>([]);
  const [promotionGates, setPromotionGates] = useState<Record<string, PolicyGateResult>>({});
  const [selectedDatasets, setSelectedDatasets] = useState<Array<string | number>>([]);
  const [loading, setLoading] = useState(false);
  const [datasetDialog, setDatasetDialog] = useState(false);
  const [caseDialog, setCaseDialog] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [datasetName, setDatasetName] = useState('');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [caseDraft, setCaseDraft] = useState<CaseDraft>({ ...emptyCase });
  const [caseTags, setCaseTags] = useState('');
  const [failureDetail, setFailureDetail] = useState<Array<{
    caseId: string;
    failureReason: string | null;
  }> | null>(null);
  const pollRef = useRef<number | null>(null);
  const selectedVersion = datasets.find((item) => item.id === selectedVersionId);
  const coverage = {
    answerable: cases.filter((item) => item.expectedGroundingStatus === 'sufficient').length,
    insufficient: cases.filter((item) => item.expectedGroundingStatus === 'insufficient').length,
    highRisk: cases.filter((item) => ['high_risk', 'escalated'].includes(item.expectedGroundingStatus)).length,
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [datasetItems, runPage, policyData] = await Promise.all([
        adminApi.listQualityDatasets(),
        adminApi.listQualityRuns(),
        adminApi.getQualityPolicies(),
      ]);
      setDatasets(datasetItems);
      setRuns(runPage.items);
      setCurrentPolicy(policyData.current);
      setPolicyHistory(policyData.history);
      const latestCompleted = runPage.items.find((run) => run.status === 'completed');
      if (latestCompleted) {
        const checks = await Promise.all(latestCompleted.candidates.map(async (candidate) => [
          `${latestCompleted.id}:${candidate.key}`,
          await adminApi.checkQualityPromotion(latestCompleted.id, candidate.key),
        ] as const));
        setPromotionGates(Object.fromEntries(checks));
      } else {
        setPromotionGates({});
      }
      if (!selectedVersionId && datasetItems.length > 0) {
        setSelectedVersionId(datasetItems[0].id);
      }
    } catch {
      MessagePlugin.error(t('quality.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [language, selectedVersionId, t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selectedVersionId) return;
    void adminApi.listQualityCases(selectedVersionId)
      .then(setCases)
      .catch(() => MessagePlugin.error(t('quality.loadFailed')));
  }, [selectedVersionId, language, t]);
  useEffect(() => {
    const active = runs.some((run) => run.status === 'queued' || run.status === 'running');
    if (active && pollRef.current === null) {
      pollRef.current = window.setInterval(() => void refresh(), 1500);
    }
    if (!active && pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [runs, refresh]);

  const datasetOptions = useMemo(() => datasets
    .filter((item) => item.status === 'published')
    .map((item) => ({ label: `${item.name} v${item.version}`, value: item.id })), [datasets]);

  const createDataset = async () => {
    try {
      const created = await adminApi.createQualityDataset({
        name: datasetName,
        description: datasetDescription,
      });
      setDatasetDialog(false);
      setDatasetName('');
      setDatasetDescription('');
      setSelectedVersionId(created.id);
      await refresh();
    } catch {
      MessagePlugin.error(t('quality.saveFailed'));
    }
  };

  const saveCase = async () => {
    if (!selectedVersion) return;
    try {
      await adminApi.saveQualityCase(selectedVersion.id, {
        id: editingCaseId ?? crypto.randomUUID(),
        ...caseDraft,
        tags: caseTags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
      });
      setCaseDialog(false);
      setEditingCaseId(null);
      setCaseDraft({ ...emptyCase });
      setCases(await adminApi.listQualityCases(selectedVersion.id));
      await refresh();
    } catch {
      MessagePlugin.error(t('quality.saveFailed'));
    }
  };

  const importJson = async (file: File) => {
    if (!selectedVersion || file.size > 1024 * 1024) {
      MessagePlugin.error(t('quality.importInvalid'));
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as { cases?: unknown[] } | unknown[];
      const importedCases = Array.isArray(parsed) ? parsed : parsed.cases;
      if (!Array.isArray(importedCases)) throw new Error('invalid');
      await adminApi.importQualityCases(
        selectedVersion.id,
        importedCases as Array<Omit<QualityCase, 'id' | 'versionId' | 'createdAt'>>,
      );
      setCases(await adminApi.listQualityCases(selectedVersion.id));
      await refresh();
      MessagePlugin.success(t('quality.imported'));
    } catch {
      MessagePlugin.error(t('quality.importInvalid'));
    }
  };

  const startRun = async () => {
    try {
      await adminApi.createQualityRun({
        datasetVersionIds: selectedDatasets.map(String),
        policies: DEFAULT_MATRIX,
      });
      MessagePlugin.success(t('quality.runQueued'));
      await refresh();
    } catch {
      MessagePlugin.error(t('quality.runFailed'));
    }
  };

  const activate = async (run: QualityRun, candidateKey: string) => {
    if (!currentPolicy) return;
    let gate: PolicyGateResult;
    try {
      gate = await adminApi.checkQualityPromotion(run.id, candidateKey);
    } catch {
      MessagePlugin.error(t('quality.gateFailed'));
      return;
    }
    if (!gate.eligible) {
      MessagePlugin.warning(`${t('quality.gateFailed')}: ${gate.reasons.join(', ')}`);
      return;
    }
    if (!window.confirm(t('quality.confirmActivate'))) return;
    try {
      await adminApi.activateQualityPolicy({
        runId: run.id,
        candidateKey,
        expectedCurrentPolicyId: currentPolicy.id,
        confirmed: true,
      });
      await refresh();
      MessagePlugin.success(t('quality.activated'));
    } catch {
      MessagePlugin.error(t('quality.gateFailed'));
    }
  };

  const rollback = async (policy: RetrievalPolicy) => {
    if (!currentPolicy || !window.confirm(t('quality.confirmRollback'))) return;
    try {
      await adminApi.rollbackQualityPolicy({
        targetPolicyId: policy.id,
        expectedCurrentPolicyId: currentPolicy.id,
        confirmed: true,
      });
      await refresh();
      MessagePlugin.success(t('quality.rolledBack'));
    } catch {
      MessagePlugin.error(t('quality.saveFailed'));
    }
  };

  return (
    <div className="app-page-container app-quality-lab" data-testid="quality-lab-page">
      <div className="app-page-header">
        <div>
          <h2 className="app-page-title">{t('quality.title')}</h2>
          <p className="app-page-description">{t('quality.description')}</p>
        </div>
      </div>
      <Tabs defaultValue="datasets">
        <Tabs.TabPanel value="datasets" label={t('quality.datasets')}>
          <div className="app-quality-toolbar">
            <Select
              value={selectedVersionId}
              options={datasets.map((item) => ({
                label: `${item.name} · v${item.version} · ${item.status}`,
                value: item.id,
              }))}
              onChange={(value) => setSelectedVersionId(String(value))}
              className="app-quality-select"
            />
            <Space>
              <Button onClick={() => setDatasetDialog(true)}>{t('quality.newDataset')}</Button>
              <Button
                variant="outline"
                disabled={!selectedVersion || selectedVersion.status !== 'draft'}
                onClick={() => {
                  setEditingCaseId(null);
                  setCaseDraft({ ...emptyCase });
                  setCaseTags('');
                  setCaseDialog(true);
                }}
              >{t('quality.addCase')}</Button>
              <label className="app-quality-file-button">
                {t('quality.importJson')}
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={!selectedVersion || selectedVersion.status !== 'draft'}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importJson(file);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <Button
                theme="primary"
                disabled={!selectedVersion || selectedVersion.status !== 'draft' || cases.length === 0}
                onClick={() => selectedVersion && adminApi.publishQualityVersion(selectedVersion.id)
                  .then(refresh).catch(() => MessagePlugin.error(t('quality.saveFailed')))}
              >{t('quality.publishDataset')}</Button>
              <Button
                variant="outline"
                disabled={!selectedVersion || selectedVersion.origin === 'builtin' || selectedVersion.status !== 'published'}
                onClick={() => selectedVersion && adminApi.deriveQualityVersion(selectedVersion.id)
                  .then((version) => { setSelectedVersionId(version.id); return refresh(); })
                  .catch(() => MessagePlugin.error(t('quality.saveFailed')))}
              >{t('quality.derive')}</Button>
            </Space>
          </div>
          {selectedVersion && (
            <Alert
              theme={selectedVersion.origin === 'builtin' ? 'info' : 'success'}
              message={`${selectedVersion.origin} · ${selectedVersion.status} · ${selectedVersion.caseCount} ${t('quality.cases')} · ${t('quality.coverage')}: ${coverage.answerable}/6 · ${coverage.insufficient}/4 · ${coverage.highRisk}/2`}
            />
          )}
          <div className="app-quality-table-scroll">
            <Table
            rowKey="id"
            loading={loading}
            data={cases}
            columns={[
              { colKey: 'query', title: t('quality.query'), ellipsis: true },
              { colKey: 'expectedAnswerMode', title: t('quality.answerMode') },
              { colKey: 'expectedGroundingStatus', title: t('quality.grounding') },
              { colKey: 'language', title: t('quality.language'), width: 90 },
              { colKey: 'tags', title: t('quality.tags'), cell: ({ row }) => row.tags.join(', ') || '—' },
              { colKey: 'action', title: t('common.actions'), width: 100,
                cell: ({ row }) => <Button
                  size="small"
                  variant="text"
                  disabled={selectedVersion?.status !== 'draft'}
                  onClick={() => {
                    setEditingCaseId(row.id);
                    setCaseDraft({
                      query: row.query,
                      expectedAnswerMode: row.expectedAnswerMode,
                      expectedGroundingStatus: row.expectedGroundingStatus,
                      expectedSources: row.expectedSources,
                      language: row.language,
                      tags: row.tags,
                    });
                    setCaseTags(row.tags.join(', '));
                    setCaseDialog(true);
                  }}
                >{t('common.edit')}</Button> },
            ]}
            />
          </div>
        </Tabs.TabPanel>
        <Tabs.TabPanel value="runs" label={t('quality.runs')}>
          <Card className="app-quality-control">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                value={selectedDatasets}
                options={datasetOptions}
                multiple
                clearable
                placeholder={t('quality.selectDatasets')}
                onChange={(value) => setSelectedDatasets(value as Array<string | number>)}
              />
              <div className="app-quality-run-actions">
                <span>{t('quality.matrixSummary')}</span>
                <Button theme="primary" disabled={selectedDatasets.length === 0} onClick={startRun}>
                  {t('quality.startRun')}
                </Button>
              </div>
            </Space>
          </Card>
          <div className="app-quality-run-list">
            {runs.map((run) => (
              <Card key={run.id} title={`${t('quality.run')} ${run.id.slice(0, 8)}`}>
                <div className="app-quality-run-meta">
                  <Tag>{run.status}</Tag>
                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                </div>
                <Progress percentage={Math.round((run.progress / Math.max(run.totalCases, 1)) * 100)} />
                {run.candidates.length > 0 && (
                  <div className="app-quality-table-scroll">
                    <Table
                    rowKey="key"
                    data={run.candidates}
                    columns={[
                      { colKey: 'recommended', title: t('quality.recommended'), width: 110,
                        cell: ({ row }) => row.recommended ? <Tag theme="success">✓</Tag> : '—' },
                      { colKey: 'policy', title: t('quality.strategy'),
                        cell: ({ row }) => `${row.policy.directFaqThreshold}/${row.policy.generationEvidenceThreshold}/${row.policy.sourceDiversityRatio}/${row.policy.rerankerMode}` },
                      { colKey: 'metrics', title: 'Recall@3 / MRR / Decision',
                        cell: ({ row }) => `${percent(row.metrics.recallAt3)} / ${percent(row.metrics.mrr)} / ${percent(row.metrics.decisionAccuracy)}` },
                      { colKey: 'recall1', title: 'Recall@1',
                        cell: ({ row }) => percent(row.metrics.recallAt1) },
                      { colKey: 'unsafe', title: t('quality.unsafe'), width: 90,
                        cell: ({ row }) => row.metrics.unsafeAnswerCount },
                      { colKey: 'refusal', title: t('quality.overRefusal'), width: 90,
                        cell: ({ row }) => row.metrics.overRefusalCount },
                      { colKey: 'latency', title: 'P50 / P95',
                        cell: ({ row }) => `${row.metrics.p50LatencyMs.toFixed(1)} / ${row.metrics.p95LatencyMs.toFixed(1)} ms` },
                      { colKey: 'usage', title: t('quality.usage'),
                        cell: ({ row }) => `${row.metrics.embeddingCallCount} / ${row.metrics.estimatedTokenCount} / ${t('quality.costUnknown')}` },
                      { colKey: 'sources', title: t('quality.sources'),
                        cell: ({ row }) => JSON.stringify(row.metrics.sourceDistribution) },
                      { colKey: 'failures', title: t('quality.failures'), width: 90,
                        cell: ({ row }) => row.metrics.failureCount },
                      { colKey: 'action', title: t('common.actions'), width: 190,
                        cell: ({ row }) => <Space>
                          <Button
                            size="small"
                            variant="outline"
                            disabled={row.metrics.failureCount === 0}
                            onClick={() => adminApi.getQualityRun(run.id).then((detail) => {
                              const candidate = detail.candidates.find((item) => item.key === row.key);
                              setFailureDetail(candidate?.cases.filter((item) => !item.passed) ?? []);
                            })}
                          >{t('quality.viewFailures')}</Button>
                          <Button
                            size="small"
                            disabled={!promotionGates[`${run.id}:${row.key}`]?.eligible}
                            title={promotionGates[`${run.id}:${row.key}`]?.reasons.join(', ')}
                            onClick={() => void activate(run, row.key)}
                          >{t('quality.activate')}</Button>
                        </Space> },
                    ]}
                    />
                  </div>
                )}
                {run.candidates.filter((candidate) => candidate.recommended).map((candidate) => {
                  const gate = promotionGates[`${run.id}:${candidate.key}`];
                  if (!gate || gate.eligible) return null;
                  return (
                    <Alert
                      key={candidate.key}
                      theme="warning"
                      message={`${t('quality.gateFailed')}: ${gate.reasons.join(', ')}`}
                    />
                  );
                })}
                {(run.status === 'queued' || run.status === 'running') && (
                  <Button variant="outline" onClick={() => adminApi.cancelQualityRun(run.id).then(refresh)}>
                    {t('quality.cancel')}
                  </Button>
                )}
              </Card>
            ))}
          </div>
        </Tabs.TabPanel>
        <Tabs.TabPanel value="policies" label={t('quality.policies')}>
          {currentPolicy && (
            <Card title={t('quality.currentPolicy')} className="app-quality-current">
              <strong>v{currentPolicy.version}</strong>
              <code>{JSON.stringify(currentPolicy.config)}</code>
            </Card>
          )}
          <div className="app-quality-table-scroll">
            <Table
            rowKey="id"
            data={policyHistory}
            columns={[
              { colKey: 'version', title: t('quality.version'), width: 90, cell: ({ row }) => `v${row.version}` },
              { colKey: 'config', title: t('quality.strategy'), cell: ({ row }) => JSON.stringify(row.config) },
              { colKey: 'sourceRunId', title: t('quality.sourceRun'), ellipsis: true },
              { colKey: 'createdBy', title: t('quality.actor'), width: 120 },
              { colKey: 'action', title: t('common.actions'), width: 120,
                cell: ({ row }) => <Button
                  size="small"
                  variant="outline"
                  disabled={row.id === currentPolicy?.id}
                  onClick={() => void rollback(row)}
                >{t('quality.rollback')}</Button> },
            ]}
            />
          </div>
        </Tabs.TabPanel>
      </Tabs>

      <Dialog
        visible={datasetDialog}
        header={t('quality.newDataset')}
        onClose={() => setDatasetDialog(false)}
        onConfirm={() => void createDataset()}
        confirmBtn={{ disabled: !datasetName.trim() }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input value={datasetName} onChange={setDatasetName} placeholder={t('quality.datasetName')} />
          <Input value={datasetDescription} onChange={setDatasetDescription} placeholder={t('quality.datasetDescription')} />
        </Space>
      </Dialog>
      <Dialog
        visible={failureDetail !== null}
        header={t('quality.failures')}
        footer={false}
        onClose={() => setFailureDetail(null)}
      >
        {failureDetail?.length ? failureDetail.map((item) => (
          <div key={item.caseId} className="app-quality-failure">
            <code>{item.caseId}</code>
            <span>{item.failureReason}</span>
          </div>
        )) : <span>—</span>}
      </Dialog>
      <Dialog
        visible={caseDialog}
        header={t('quality.addCase')}
        onClose={() => {
          setCaseDialog(false);
          setEditingCaseId(null);
        }}
        onConfirm={() => void saveCase()}
        confirmBtn={{
          disabled: !caseDraft.query.trim()
            || (caseDraft.expectedGroundingStatus === 'sufficient'
              && !caseDraft.expectedSources[0]?.knowledgeId.trim()),
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input value={caseDraft.query} onChange={(query) => setCaseDraft({ ...caseDraft, query })} placeholder={t('quality.query')} />
          <Select
            value={caseDraft.expectedAnswerMode}
            options={['direct_faq', 'grounded_generation', 'refusal'].map((value) => ({ label: value, value }))}
            onChange={(value) => setCaseDraft({ ...caseDraft, expectedAnswerMode: String(value) as QualityCase['expectedAnswerMode'] })}
          />
          <Select
            value={caseDraft.expectedGroundingStatus}
            options={['sufficient', 'insufficient', 'high_risk', 'escalated'].map((value) => ({ label: value, value }))}
            onChange={(value) => setCaseDraft({
              ...caseDraft,
              expectedGroundingStatus: String(value) as QualityCase['expectedGroundingStatus'],
              expectedAnswerMode: value === 'sufficient' ? caseDraft.expectedAnswerMode : 'refusal',
              expectedSources: value === 'sufficient' ? caseDraft.expectedSources : [],
            })}
          />
          {caseDraft.expectedGroundingStatus === 'sufficient' && (
            <>
              <Select
                value={caseDraft.expectedSources[0]?.knowledgeType ?? 'faq'}
                options={[
                  { label: 'FAQ', value: 'faq' },
                  { label: t('nav.documents'), value: 'document' },
                ]}
                onChange={(value) => setCaseDraft({
                  ...caseDraft,
                  expectedSources: [{
                    knowledgeType: String(value) as 'faq' | 'document',
                    knowledgeId: caseDraft.expectedSources[0]?.knowledgeId ?? '',
                  }],
                })}
              />
              <Input
                value={caseDraft.expectedSources[0]?.knowledgeId ?? ''}
                onChange={(knowledgeId) => setCaseDraft({
                  ...caseDraft,
                  expectedSources: [{
                    knowledgeType: caseDraft.expectedSources[0]?.knowledgeType ?? 'faq',
                    knowledgeId,
                  }],
                })}
                placeholder={t('quality.sourceId')}
              />
            </>
          )}
          <Select
            value={caseDraft.language}
            options={[{ label: '中文', value: 'zh' }, { label: 'English', value: 'en' }]}
            onChange={(value) => setCaseDraft({ ...caseDraft, language: String(value) as 'zh' | 'en' })}
          />
          <Input
            value={caseTags}
            onChange={setCaseTags}
            placeholder={t('quality.tags')}
          />
        </Space>
      </Dialog>
    </div>
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default QualityLabPage;
