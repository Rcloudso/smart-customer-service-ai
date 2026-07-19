import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Card, DateRangePicker, MessagePlugin, Space } from 'tdesign-react';
import {
  ChatIcon,
  FileIcon,
  FilterClearIcon,
  SearchIcon,
  StarIcon,
  UserIcon,
} from 'tdesign-icons-react';
import { StatsCard } from '../../components/admin/StatsCard';
import { IntentPieChart } from '../../components/admin/IntentPieChart';
import { SatisfactionLineChart } from '../../components/admin/SatisfactionLineChart';
import { LoadingSkeleton } from '../../components/common/LoadingSkeleton';
import { useTranslation } from '../../hooks/usePreferences';
import * as adminApi from '../../api/admin';
import type { AdminOverview, IntentDistribution, SatisfactionTrend } from '../../api/admin';

/**
 * Admin dashboard page — overview stats, intent distribution, and satisfaction trend.
 */
export function DashboardPage(): React.ReactElement {
  const { language, t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [intentDistribution, setIntentDistribution] = useState<IntentDistribution[]>([]);
  const [trend, setTrend] = useState<SatisfactionTrend[]>([]);
  const [dateRange, setDateRange] = useState<[string, string] | null>(null);
  const [appliedDateRange, setAppliedDateRange] = useState<[string, string] | null>(null);
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const from = appliedDateRange?.[0] ?? undefined;
      const to = appliedDateRange?.[1] ?? undefined;

      const [overviewData, trendData] = await Promise.all([
        adminApi.getStatsOverview(from, to),
        adminApi.getSatisfactionTrend(from, to, 'day'),
      ]);

      if (requestId !== requestIdRef.current) return;
      setOverview({
        totalConversations: overviewData.totalConversations,
        totalMessages: overviewData.totalMessages,
        avgSatisfaction: overviewData.avgSatisfaction,
        escalationRate: overviewData.escalationRate,
        activeSessions: overviewData.activeSessions,
        activeWindowMinutes: overviewData.activeWindowMinutes,
      });
      setIntentDistribution(overviewData.intentDistribution ?? []);
      setTrend(trendData);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : t('common.loadFailed');
      MessagePlugin.error(message);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [appliedDateRange, language]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDateChange = (value: unknown) => {
    const dates = value as string[];
    if (dates && dates.length === 2) {
      setDateRange([dates[0], dates[1]]);
    } else {
      setDateRange(null);
    }
  };

  const handleSearch = () => {
    const unchanged = dateRange?.[0] === appliedDateRange?.[0]
      && dateRange?.[1] === appliedDateRange?.[1];
    setAppliedDateRange(dateRange ? [...dateRange] : null);
    if (unchanged) void fetchData();
  };

  const handleReset = () => {
    setDateRange(null);
    setAppliedDateRange(null);
  };

  return (
    <div className="app-page-container">
      {/* Page header */}
      <div className="app-page-header">
        <h2 className="app-page-title">
          {t('dashboard.title')}
        </h2>
        <Space className="app-page-actions">
          <DateRangePicker
            value={dateRange ?? []}
            placeholder={[t('dashboard.startDate'), t('dashboard.endDate')]}
            onChange={handleDateChange}
            allowInput
            clearable
            style={{ width: '260px' }}
          />
          <Button
            theme="primary"
            icon={<SearchIcon />}
            onClick={handleSearch}
            data-testid="dashboard-filter-search"
          >
            {t('common.search')}
          </Button>
          <Button
            variant="outline"
            icon={<FilterClearIcon />}
            onClick={handleReset}
            data-testid="dashboard-filter-reset"
          >
            {t('common.reset')}
          </Button>
        </Space>
      </div>

      {/* Stats cards */}
      {loading && !overview ? (
        <div className="app-stat-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} bordered className="app-panel-card">
              <LoadingSkeleton height="80px" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="app-stat-grid">
          <StatsCard
            title={t('dashboard.totalConversations')}
            value={overview?.totalConversations ?? 0}
            unit={t('unit.count')}
            color="blue"
            icon={<ChatIcon />}
          />
          <StatsCard
            title={t('dashboard.totalMessages')}
            value={overview?.totalMessages ?? 0}
            unit={t('unit.messages')}
            color="green"
            icon={<FileIcon />}
          />
          <StatsCard
            title={t('dashboard.avgSatisfaction')}
            value={overview?.avgSatisfaction?.toFixed(1) ?? '0.0'}
            unit={t('unit.score')}
            color="orange"
            icon={<StarIcon />}
          />
          <StatsCard
            title={t('dashboard.activeSessionsWindow', {
              minutes: overview?.activeWindowMinutes ?? 30,
            })}
            value={overview?.activeSessions ?? 0}
            unit={t('unit.sessions')}
            color="purple"
            icon={<UserIcon />}
          />
        </div>
      )}

      {/* Charts row */}
      <div className="app-chart-grid">
        {/* Intent distribution */}
        <Card title={t('dashboard.intentDistribution')} bordered className="app-panel-card">
          {loading ? (
            <LoadingSkeleton height="200px" count={4} />
          ) : (
            <IntentPieChart data={intentDistribution} />
          )}
        </Card>

        {/* Escalation rate card */}
        <Card title={t('dashboard.escalationRate')} bordered className="app-panel-card">
          {loading ? (
            <LoadingSkeleton height="200px" />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '200px',
              }}
            >
              <div
                style={{
                  fontSize: '48px',
                  fontWeight: 700,
                  color: overview && overview.escalationRate > 10 ? 'var(--app-danger)' : 'var(--app-success)',
                }}
              >
                {overview?.escalationRate ?? 0}%
              </div>
              <div style={{ fontSize: '14px', color: 'var(--app-text-muted)', marginTop: '8px' }}>
                {t('dashboard.escalationCaption', { count: overview?.totalConversations ?? 0 })}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Satisfaction trend */}
      <Card title={t('dashboard.satisfactionTrend')} bordered className="app-panel-card" style={{ marginTop: '16px' }}>
        {loading ? (
          <LoadingSkeleton height="300px" count={5} />
        ) : (
          <SatisfactionLineChart data={trend} />
        )}
      </Card>
    </div>
  );
}

export default DashboardPage;
