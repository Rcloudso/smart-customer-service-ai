import React, { useEffect, useMemo, useState } from 'react';
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(14);
  const sortedData = useMemo(
    () => [...data].sort((left, right) => right.date.localeCompare(left.date)),
    [data],
  );

  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(sortedData.length / pageSize));
    setPage((current) => Math.min(current, lastPage));
  }, [sortedData.length, pageSize]);
  const ratingColor = (rating: number) => {
    if (rating >= 4) return '#0070f3';
    if (rating >= 3) return '#f5a623';
    return '#ee0000';
  };

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
        const color = ratingColor(rating);
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
        const color = ratingColor(row.avgRating);
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
        data={sortedData}
        columns={columns}
        rowKey="date"
        size="small"
        bordered
        stripe
        pagination={{
          current: page,
          pageSize,
          total: sortedData.length,
          pageSizeOptions: [7, 14, 30],
          showJumper: true,
          onChange: (pageInfo) => {
            setPage(pageInfo.current);
            setPageSize(pageInfo.pageSize);
          },
        }}
      />
    </div>
  );
}
