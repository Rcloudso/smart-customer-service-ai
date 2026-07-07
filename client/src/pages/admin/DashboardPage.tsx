import React, { useState, useEffect, useCallback } from 'react';
import { Card, DateRangePicker, MessagePlugin, Space } from 'tdesign-react';
import {
  ChatIcon,
  FileIcon,
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const from = dateRange?.[0] ?? undefined;
      const to = dateRange?.[1] ?? undefined;

      const [overviewData, trendData] = await Promise.all([
        adminApi.getStatsOverview(from, to),
        adminApi.getSatisfactionTrend(from, to, 'day'),
      ]);

      setOverview({
        totalConversations: overviewData.totalConversations,
        totalMessages: overviewData.totalMessages,
        avgSatisfaction: overviewData.avgSatisfaction,
        escalationRate: overviewData.escalationRate,
        activeSessions: overviewData.activeSessions,
      });
      setIntentDistribution(overviewData.intentDistribution ?? []);
      setTrend(trendData);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.loadFailed');
      MessagePlugin.error(message);
    } finally {
      setLoading(false);
    }
  }, [dateRange, language]);

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

  return (
    <div className="app-page-container">
      {/* Page header */}
      <div className="app-page-header">
        <h2 className="app-page-title">
          {t('dashboard.title')}
        </h2>
        <Space className="app-page-actions">
          <DateRangePicker
            placeholder={[t('dashboard.startDate'), t('dashboard.endDate')]}
            onChange={handleDateChange}
            clearable
            style={{ width: '260px' }}
          />
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
            title={t('dashboard.activeSessions')}
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
