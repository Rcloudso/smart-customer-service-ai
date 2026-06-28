import React from 'react';
import { Table } from 'tdesign-react';
import type { SatisfactionTrend } from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';

/** Simplified column definition to avoid depending on TDesign's internal TableColumn type. */
interface SimpleColumn {
  colKey: string;
  title: string;
  width?: number;
  cell?: (params: { row: SatisfactionTrend }) => React.ReactNode;
}

interface SatisfactionLineChartProps {
  data: SatisfactionTrend[];
  height?: number;
}

/**
 * Satisfaction trend display using TDesign Table.
 * Shows daily/weekly/monthly rating averages and counts.
 */
export function SatisfactionLineChart({
  data,
  height = 300,
}: SatisfactionLineChartProps): React.ReactElement {
  const { t } = useTranslation();

  if (!data || data.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--app-text-muted)',
          fontSize: '14px',
        }}
      >
        {t('dashboard.noTrendData')}
      </div>
    );
  }

  const columns: SimpleColumn[] = [
    {
      colKey: 'date',
      title: t('dashboard.date'),
      width: 120,
      cell: ({ row }: { row: SatisfactionTrend }) => (
        <span style={{ fontSize: '13px' }}>{row.date}</span>
      ),
    },
    {
      colKey: 'avgRating',
      title: t('dashboard.avgRating'),
      width: 120,
      cell: ({ row }: { row: SatisfactionTrend }) => {
        const rating = row.avgRating;
        const color = rating >= 4 ? '#00a870' : rating >= 3 ? '#e37318' : '#e34d59';
        const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
        return (
          <span style={{ color, fontWeight: 600, fontSize: '14px' }}>
            {stars} {rating.toFixed(1)}
          </span>
        );
      },
    },
    {
      colKey: 'count',
      title: t('dashboard.ratingCount'),
      width: 100,
      cell: ({ row }: { row: SatisfactionTrend }) => (
        <span style={{ fontSize: '13px', color: 'var(--app-text-secondary)' }}>{row.count}</span>
      ),
    },
    {
      colKey: 'bar',
      title: t('dashboard.ratingTrend'),
      cell: ({ row }: { row: SatisfactionTrend }) => {
        const maxRating = 5;
        const percentage = row.count > 0 ? (row.avgRating / maxRating) * 100 : 0;
        const color = row.avgRating >= 4 ? '#00a870' : row.avgRating >= 3 ? '#e37318' : '#e34d59';
        return (
          <div
            style={{
              height: '20px',
              backgroundColor: 'var(--app-surface-muted)',
              borderRadius: '4px',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.max(percentage, 2)}%`,
                backgroundColor: color,
                borderRadius: '4px',
                transition: 'width 0.3s ease',
                opacity: 0.8,
              }}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ maxHeight: height, overflowY: 'auto' }}>
      <Table
        data={data}
        columns={columns}
        rowKey="date"
        size="small"
        bordered
        stripe
        pagination={{
          defaultPageSize: 14,
          pageSizeOptions: [7, 14, 30],
          showJumper: true,
        }}
      />
    </div>
  );
}
