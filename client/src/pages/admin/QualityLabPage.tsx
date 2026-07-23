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
  RetrievalPolicyEvent,
  RetrievalPolicyConfig,
} from '../../types';
import { useTranslation } from '../../hooks/usePreferences';
import './QualityLabPage.css';

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
  const [policyEvents, setPolicyEvents] = useState<RetrievalPolicyEvent[]>([]);
  const [promotionGates, setPromotionGates] = useState<Record<string, PolicyGateResult>>({});
  const [selectedDatasets, setSelectedDatasets] = useState<Array<string | number>>([]);
  const [directThresholds, setDirectThresholds] = useState<Array<string | number>>([0.75, 0.8, 0.85]);
  const [generationThresholds, setGenerationThresholds] = useState<Array<string | number>>([0.5, 0.55, 0.6]);
  const [rerankerModes, setRerankerModes] = useState<Array<string | number>>([
    'none',
    'local_overlap_v1',
  ]);
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
  const translationRef = useRef(t);
  translationRef.current = t;
  const selectedVersion = datasets.find((item) => item.id === selectedVersionId);
  const coverage = {
    answerable: cases.filter((item) => item.expectedGroundingStatus === 'sufficient').length,
    insufficient: cases.filter((item) => item.expectedGroundingStatus === 'insufficient').length,
    highRisk: cases.filter((item) => ['high_risk', 'escalated'].includes(item.expectedGroundingStatus)).length,
  };
  const matrixPolicies = useMemo(() => directThresholds.flatMap(
    (directValue) => generationThresholds.flatMap((generationValue) => (
      rerankerModes.map((mode) => ({
        directFaqThreshold: Number(directValue),
        generationEvidenceThreshold: Number(generationValue),
        sourceDiversityRatio: 0.6,
        rerankerMode: String(mode) as RetrievalPolicyConfig['rerankerMode'],
      })).filter((policy) => (
        policy.generationEvidenceThreshold <= policy.directFaqThreshold
      ))
    )),
  ), [directThresholds, generationThresholds, rerankerModes]);
  const formatPolicy = (policy: RetrievalPolicyConfig): string => (
    `${t('quality.directShort')} ${policy.directFaqThreshold} · `
    + `${t('quality.generationShort')} ${policy.generationEvidenceThreshold} · `
    + `${t('quality.diversityShort')} ${policy.sourceDiversityRatio} · `
    + t(`quality.reranker.${policy.rerankerMode}`)
  );
  const formatSourceDistribution = (distribution: Record<string, number>): string => (
    Object.entries(distribution)
      .map(([source, count]) => `${t(`quality.sourceMode.${source}`)}: ${count}`)
      .join(' · ')
  );

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
      setPolicyEvents(policyData.events);
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
      MessagePlugin.error(translationRef.current('quality.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectedVersionId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selectedVersionId) return;
    void adminApi.listQualityCases(selectedVersionId)
      .then(setCases)
      .catch(() => MessagePlugin.error(translationRef.current('quality.loadFailed')));
  }, [selectedVersionId, language]);
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
        id: editingCaseId ?? undefined,
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
        policies: matrixPolicies,
      });
      MessagePlugin.success(t('quality.runQueued'));
      await refresh();
    } catch {
      MessagePlugin.error(t('quality.runFailed'));
    }
  };

  const loadGates = async (run: QualityRun) => {
    const checks = await Promise.all(run.candidates.map(async (candidate) => [
      `${run.id}:${candidate.key}`,
      await adminApi.checkQualityPromotion(run.id, candidate.key),
    ] as const));
    setPromotionGates((current) => ({ ...current, ...Object.fromEntries(checks) }));
  };

  const rerun = async (run: QualityRun) => {
    try {
      await adminApi.createQualityRun({
        datasetVersionIds: run.datasetVersionIds,
        policies: run.policies,
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
                label: `${item.name} · v${item.version} · ${t(`quality.status.${item.status}`)}`,
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
              message={`${t(`quality.origin.${selectedVersion.origin}`)} · ${t(`quality.status.${selectedVersion.status}`)} · ${selectedVersion.caseCount} ${t('quality.cases')} · ${t('quality.coverage')}: ${coverage.answerable}/6 · ${coverage.insufficient}/4 · ${coverage.highRisk}/2`}
            />
          )}
          <div className="app-quality-table-scroll">
            <Table
            rowKey="id"
            loading={loading}
            data={cases}
            columns={[
              { colKey: 'query', title: t('quality.query'), ellipsis: true },
              { colKey: 'expectedAnswerMode', title: t('quality.answerMode'),
                cell: ({ row }) => t(`quality.answerMode.${row.expectedAnswerMode}`) },
              { colKey: 'expectedGroundingStatus', title: t('quality.grounding'),
                cell: ({ row }) => t(`quality.grounding.${row.expectedGroundingStatus}`) },
              { colKey: 'language', title: t('quality.language'), width: 90,
                cell: ({ row }) => t(`quality.language.${row.language}`) },
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
              <div className="app-quality-matrix">
                <Select
                  value={directThresholds}
                  options={[0.75, 0.8, 0.85].map((value) => ({ label: String(value), value }))}
                  multiple
                  placeholder={t('quality.directThresholds')}
                  onChange={(value) => setDirectThresholds(value as Array<string | number>)}
                />
                <Select
                  value={generationThresholds}
                  options={[0.5, 0.55, 0.6].map((value) => ({ label: String(value), value }))}
                  multiple
                  placeholder={t('quality.generationThresholds')}
                  onChange={(value) => setGenerationThresholds(value as Array<string | number>)}
                />
                <Select
                  value={rerankerModes}
                  options={[
                    { label: t('quality.reranker.none'), value: 'none' },
                    { label: t('quality.reranker.local_overlap_v1'), value: 'local_overlap_v1' },
                  ]}
                  multiple
                  placeholder={t('quality.rerankerModes')}
                  onChange={(value) => setRerankerModes(value as Array<string | number>)}
                />
              </div>
              <div className="app-quality-run-actions">
                <span>{t('quality.matrixCount', { count: matrixPolicies.length })}</span>
                <Button
                  theme="primary"
                  disabled={selectedDatasets.length === 0 || matrixPolicies.length === 0}
                  onClick={startRun}
                >
                  {t('quality.startRun')}
                </Button>
              </div>
            </Space>
          </Card>
          <div className="app-quality-run-list">
            {runs.map((run) => (
              <Card key={run.id} title={`${t('quality.run')} ${run.id.slice(0, 8)}`}>
                <div className="app-quality-run-meta">
                  <Tag>{t(`quality.status.${run.status}`)}</Tag>
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
                        cell: ({ row }) => formatPolicy(row.policy) },
                      { colKey: 'metrics', title: t('quality.metricsSummary'),
                        cell: ({ row }) => `${percent(row.metrics.recallAt3)} / ${percent(row.metrics.mrr)} / ${percent(row.metrics.decisionAccuracy)}` },
                      { colKey: 'recall1', title: t('quality.recallAt1'),
                        cell: ({ row }) => percent(row.metrics.recallAt1) },
                      { colKey: 'unsafe', title: t('quality.unsafe'), width: 90,
                        cell: ({ row }) => row.metrics.unsafeAnswerCount },
                      { colKey: 'refusal', title: t('quality.overRefusal'), width: 90,
                        cell: ({ row }) => row.metrics.overRefusalCount },
                      { colKey: 'latency', title: t('quality.latency'),
                        cell: ({ row }) => `${row.metrics.p50LatencyMs.toFixed(1)} / ${row.metrics.p95LatencyMs.toFixed(1)} ${t('quality.milliseconds')}` },
                      { colKey: 'usage', title: t('quality.usage'),
                        cell: ({ row }) => `${row.metrics.embeddingCallCount} / ${row.metrics.estimatedTokenCount} / ${t('quality.costUnknown')}` },
                      { colKey: 'sources', title: t('quality.sources'),
                        cell: ({ row }) => formatSourceDistribution(row.metrics.sourceDistribution) },
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
                  if (!gate || (gate.eligible && gate.warnings.length === 0)) return null;
                  return (
                    <Alert
                      key={candidate.key}
                      theme="warning"
                      message={`${gate.eligible ? t('quality.gateWarning') : t('quality.gateFailed')}: ${[
                        ...gate.reasons,
                        ...gate.warnings,
                      ].join(', ')}`}
                    />
                  );
                })}
                <Space>
                  {run.status === 'completed' && (
                    <Button variant="outline" onClick={() => void loadGates(run)}>
                      {t('quality.checkGates')}
                    </Button>
                  )}
                  {(run.status === 'queued' || run.status === 'running') && (
                    <Button variant="outline" onClick={() => adminApi.cancelQualityRun(run.id).then(refresh)}>
                      {t('quality.cancel')}
                    </Button>
                  )}
                  {['failed', 'interrupted', 'cancelled', 'stale'].includes(run.status) && (
                    <Button variant="outline" onClick={() => void rerun(run)}>
                      {t('quality.rerun')}
                    </Button>
                  )}
                </Space>
                {run.status === 'failed' && run.failureCode && (
                  <Alert theme="error" message={`${t('quality.failureCode')}: ${run.failureCode}`} />
                )}
                {run.status === 'stale' && (
                  <Alert theme="warning" message={t('quality.staleReason')} />
                )}
              </Card>
            ))}
          </div>
        </Tabs.TabPanel>
        <Tabs.TabPanel value="policies" label={t('quality.policies')}>
          {currentPolicy && (
            <Card title={t('quality.currentPolicy')} className="app-quality-current">
              <strong>v{currentPolicy.version}</strong>
              <code>{formatPolicy(currentPolicy.config)}</code>
            </Card>
          )}
          <div className="app-quality-table-scroll">
            <Table
            rowKey="id"
            data={policyHistory}
            columns={[
              { colKey: 'version', title: t('quality.version'), width: 90, cell: ({ row }) => `v${row.version}` },
              { colKey: 'config', title: t('quality.strategy'), cell: ({ row }) => formatPolicy(row.config) },
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
          <h3>{t('quality.auditEvents')}</h3>
          <div className="app-quality-table-scroll">
            <Table
              rowKey="id"
              data={policyEvents}
              columns={[
                { colKey: 'action', title: t('quality.eventAction'),
                  cell: ({ row }) => t(`quality.event.${row.action}`) },
                { colKey: 'fromPolicyId', title: t('quality.fromPolicy'), ellipsis: true },
                { colKey: 'toPolicyId', title: t('quality.toPolicy'), ellipsis: true },
                { colKey: 'actor', title: t('quality.actor') },
                { colKey: 'createdAt', title: t('quality.eventTime'),
                  cell: ({ row }) => new Date(row.createdAt).toLocaleString() },
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
            <span>{t(`quality.failure.${item.failureReason ?? 'unknown'}`)}</span>
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
            options={['direct_faq', 'grounded_generation', 'refusal'].map((value) => ({
              label: t(`quality.answerMode.${value}`),
              value,
            }))}
            onChange={(value) => setCaseDraft({ ...caseDraft, expectedAnswerMode: String(value) as QualityCase['expectedAnswerMode'] })}
          />
          <Select
            value={caseDraft.expectedGroundingStatus}
            options={['sufficient', 'insufficient', 'conflicting', 'high_risk', 'escalated'].map((value) => ({
              label: t(`quality.grounding.${value}`),
              value,
            }))}
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
                  { label: t('quality.source.faq'), value: 'faq' },
                  { label: t('quality.source.document'), value: 'document' },
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
            options={[
              { label: t('quality.language.zh'), value: 'zh' },
              { label: t('quality.language.en'), value: 'en' },
            ]}
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
