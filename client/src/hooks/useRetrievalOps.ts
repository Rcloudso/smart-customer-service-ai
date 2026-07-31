import { useCallback, useEffect, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import * as adminApi from '../api/admin';
import type {
  RetrievalActivationCheck,
  RetrievalIndexJob,
  RetrievalStatus,
  RetrievalTrace,
  RetrievalTraceDetail,
  RetrievalTraceStatus,
} from '../types';

export type RetrievalPendingAction = {
  kind: 'activate' | 'rollback';
  job: RetrievalIndexJob;
  gate?: RetrievalActivationCheck;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;

const TRACE_PAGE_SIZE = 20;

export function useRetrievalOps(t: Translate) {
  const [status, setStatus] = useState<RetrievalStatus | null>(null);
  const [jobs, setJobs] = useState<RetrievalIndexJob[]>([]);
  const [traces, setTraces] = useState<RetrievalTrace[]>([]);
  const [traceTotal, setTraceTotal] = useState(0);
  const [tracePage, setTracePage] = useState(1);
  const [traceStatus, setTraceStatus] = useState<RetrievalTraceStatus | ''>('');
  const [traceBackend, setTraceBackend] = useState<'memory' | 'qdrant' | ''>('');
  const [traceSession, setTraceSession] = useState('');
  const [traceDates, setTraceDates] = useState<Array<string | number>>([]);
  const [detail, setDetail] = useState<RetrievalTraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [traceLoading, setTraceLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(false);
  const [pendingAction, setPendingAction] = useState<RetrievalPendingAction | null>(null);
  const [latencyConfirmed, setLatencyConfirmed] = useState(false);

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextStatus, jobPage] = await Promise.all([
        adminApi.getRetrievalStatus(),
        adminApi.listRetrievalIndexJobs(1, 50),
      ]);
      setStatus(nextStatus);
      setJobs(jobPage.items);
      setError(false);
    } catch {
      setError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadTraces = useCallback(async () => {
    setTraceLoading(true);
    try {
      const result = await adminApi.listRetrievalTraces({
        page: tracePage,
        pageSize: TRACE_PAGE_SIZE,
        status: traceStatus || undefined,
        backend: traceBackend || undefined,
        sessionId: traceSession.trim() || undefined,
        createdFrom: traceDates[0]
          ? new Date(`${String(traceDates[0])}T00:00:00`).toISOString()
          : undefined,
        createdTo: traceDates[1]
          ? new Date(`${String(traceDates[1])}T23:59:59.999`).toISOString()
          : undefined,
      });
      setTraces(result.items);
      setTraceTotal(result.total);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setTraceLoading(false);
    }
  }, [traceBackend, traceDates, tracePage, traceSession, traceStatus]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadTraces()]);
  }, [loadOverview, loadTraces]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!jobs.some((job) => ['queued', 'running', 'interrupted'].includes(job.status))) {
      return undefined;
    }
    const timer = window.setInterval(() => void loadOverview(true), 1500);
    return () => window.clearInterval(timer);
  }, [jobs, loadOverview]);

  const openActivation = async (job: RetrievalIndexJob) => {
    setActionLoading(true);
    try {
      const gate = await adminApi.getRetrievalActivationCheck(job.id);
      setLatencyConfirmed(false);
      setPendingAction({ kind: 'activate', job, gate });
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const confirmAction = async () => {
    if (!pendingAction || !status) return;
    setActionLoading(true);
    try {
      if (pendingAction.kind === 'activate') {
        await adminApi.activateRetrievalIndexJob({
          id: pendingAction.job.id,
          expectedCurrentCollection: status.collection,
          confirmLatencyWarning: latencyConfirmed,
        });
        MessagePlugin.success(t('retrievalOps.activated'));
      } else {
        await adminApi.rollbackRetrievalIndexJob({
          id: pendingAction.job.id,
          expectedCurrentCollection: pendingAction.job.collection,
        });
        MessagePlugin.success(t('retrievalOps.rolledBack'));
      }
      setPendingAction(null);
      await loadOverview();
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const createJob = async () => {
    setActionLoading(true);
    try {
      await adminApi.createRetrievalIndexJob();
      MessagePlugin.success(t('retrievalOps.jobQueued'));
      await loadOverview();
    } catch {
      MessagePlugin.error(t('retrievalOps.actionFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const openTrace = async (traceId: string) => {
    setTraceLoading(true);
    try {
      setDetail(await adminApi.getRetrievalTrace(traceId));
    } catch {
      MessagePlugin.error(t('retrievalOps.traceLoadFailed'));
    } finally {
      setTraceLoading(false);
    }
  };

  return {
    status,
    jobs,
    traces,
    traceTotal,
    tracePage,
    traceStatus,
    traceBackend,
    traceSession,
    traceDates,
    detail,
    loading,
    traceLoading,
    actionLoading,
    error,
    pendingAction,
    latencyConfirmed,
    pageSize: TRACE_PAGE_SIZE,
    setTracePage,
    setTraceStatus,
    setTraceBackend,
    setTraceSession,
    setTraceDates,
    setDetail,
    setPendingAction,
    setLatencyConfirmed,
    loadOverview,
    loadTraces,
    refreshAll,
    openActivation,
    confirmAction,
    createJob,
    openTrace,
  };
}
