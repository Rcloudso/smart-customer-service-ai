import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Loading, MessagePlugin, Space, Tag } from 'tdesign-react';
import { ArrowRightIcon, CheckCircleIcon, HelpCircleIcon } from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import {
  completeEvidenceReview,
  dismissOnboarding,
  getOnboarding,
  installSamplePack,
  recordGuidedAnswer,
  startOnboarding,
} from '../../api/admin';
import { sendMessage } from '../../api/chat';
import { useTranslation } from '../../hooks/usePreferences';
import type { KnowledgeRetrievalSnapshot, OnboardingOverview } from '../../types';

export default function GettingStartedPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<KnowledgeRetrievalSnapshot[]>([]);

  const question = state?.recommendedQuestions[language] ?? '';
  const sampleReady = state?.samplePack?.status === 'ready';
  const firstAnswerReady = Boolean(state?.firstAnswerMessageId);
  const displayedAnswer = answer || state?.verifiedAnswer?.content || '';
  const displayedSources = sources.length > 0
    ? sources
    : state?.verifiedAnswer?.knowledgeSources ?? [];
  const steps = useMemo(() => [
    { key: 'ready', done: Boolean(state), label: t('onboarding.step.ready') },
    { key: 'sample', done: sampleReady, label: t('onboarding.step.sample') },
    { key: 'answer', done: firstAnswerReady, label: t('onboarding.step.answer') },
    { key: 'source', done: state?.status === 'completed', label: t('onboarding.step.source') },
    { key: 'next', done: state?.status === 'completed', label: t('onboarding.step.next') },
  ], [firstAnswerReady, sampleReady, state, t]);

  useEffect(() => {
    void getOnboarding()
      .then(setState)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('common.loadFailed')))
      .finally(() => setLoading(false));
  }, [language]);

  const run = async (name: string, work: () => Promise<OnboardingOverview>): Promise<void> => {
    setAction(name);
    setError(null);
    try {
      setState(await work());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.operationFailed'));
    } finally {
      setAction(null);
    }
  };

  const askQuestion = async (): Promise<void> => {
    if (!state?.runId) return;
    setAction('answer');
    setError(null);
    setAnswer('');
    setSources([]);
    try {
      const result = await sendMessage(question, undefined, {
        onToken: (token) => setAnswer((current) => current + token),
        onDone: (data) => setSources(data.knowledgeSources ?? []),
      }, { onboardingRunId: state.runId });
      setState(await recordGuidedAnswer({ sessionId: result.sessionId, messageId: result.messageId }));
      MessagePlugin.success(t('onboarding.answerVerified'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.operationFailed'));
    } finally {
      setAction(null);
    }
  };

  const finish = async (): Promise<void> => {
    if (!state?.firstAnswerMessageId) return;
    await run('finish', () => completeEvidenceReview(state.firstAnswerMessageId as string));
  };

  if (loading) return <div className="app-centered-state"><Loading text={t('common.loading')} /></div>;

  return (
    <div className="app-onboarding-page" data-testid="getting-started-page">
      <header className="app-page-header">
        <div>
          <h1>{t('onboarding.title')}</h1>
          <p>{t('onboarding.description')}</p>
        </div>
        <Button variant="text" onClick={() => void dismissOnboarding().then(() => navigate('/admin', { replace: true })).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('common.operationFailed')))}>
          {t('onboarding.skip')}
        </Button>
      </header>

      {error && <Alert theme="error" message={error} close onClose={() => setError(null)} />}
      <ol className="app-onboarding-steps" aria-label={t('onboarding.stepsLabel')}>
        {steps.map((step, index) => (
          <li key={step.key} className={step.done ? 'is-complete' : ''}>
            <span>{step.done ? <CheckCircleIcon /> : index + 1}</span>{step.label}
          </li>
        ))}
      </ol>

      <div className="app-onboarding-grid">
        <Card title={t('onboarding.readinessTitle')} className="app-panel-card">
          <Space direction="vertical">
            <div><Tag theme="success">{t('onboarding.ready')}</Tag> {t('onboarding.databaseReady')}</div>
            <div><Tag theme="success">{t('onboarding.available')}</Tag> {state?.readiness.answerMode === 'deterministic_local' ? t('onboarding.localMode') : t('onboarding.providerMode')}</div>
            <div><Tag theme="default">{t('onboarding.localOnly')}</Tag> {t('onboarding.noTelemetry')}</div>
            {state?.status !== 'in_progress' && state?.status !== 'completed' && (
              <Button theme="primary" loading={action === 'start'} onClick={() => void run('start', startOnboarding)}>
                {t('onboarding.start')}
              </Button>
            )}
          </Space>
        </Card>

        <Card title={t('onboarding.sampleTitle')} className="app-panel-card">
          <p>{t('onboarding.sampleDescription')}</p>
          <Button
            theme="primary"
            disabled={state?.status !== 'in_progress' || sampleReady}
            loading={action === 'sample'}
            onClick={() => void run('sample', installSamplePack)}
          >
            {sampleReady ? t('onboarding.sampleLoaded') : t('onboarding.loadSample')}
          </Button>
        </Card>

        <Card title={t('onboarding.questionTitle')} className="app-panel-card app-onboarding-answer-card">
          <p className="app-onboarding-question"><HelpCircleIcon /> {question}</p>
          <Button
            theme="primary"
            disabled={!sampleReady || !state?.runId || firstAnswerReady}
            loading={action === 'answer'}
            onClick={() => void askQuestion()}
          >
            {firstAnswerReady ? t('onboarding.answerVerified') : t('onboarding.ask')}
          </Button>
          {displayedAnswer && <div className="app-onboarding-answer" data-testid="onboarding-answer">{displayedAnswer}</div>}
          {displayedSources.length > 0 && (
            <div className="app-onboarding-sources" data-testid="onboarding-sources">
              <strong>{t('onboarding.sources')}</strong>
              {displayedSources.map((source) => (
                <div key={`${source.knowledgeType}-${source.knowledgeId}`}>
                  <Tag theme={source.knowledgeType === 'document' ? 'success' : 'default'}>{source.knowledgeType}</Tag>
                  <span>{source.title}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('onboarding.reviewTitle')} className="app-panel-card">
          <p>{t('onboarding.reviewDescription')}</p>
          <Button
            theme="primary"
            icon={<ArrowRightIcon />}
            disabled={!firstAnswerReady || displayedSources.length === 0 || state?.status === 'completed'}
            loading={action === 'finish'}
            onClick={() => void finish()}
          >
            {state?.status === 'completed' ? t('onboarding.completed') : t('onboarding.confirmSource')}
          </Button>
          {state?.status === 'completed' && (
            <Button variant="outline" onClick={() => navigate('/admin/documents')}>{t('onboarding.nextDocuments')}</Button>
          )}
        </Card>
      </div>
    </div>
  );
}
