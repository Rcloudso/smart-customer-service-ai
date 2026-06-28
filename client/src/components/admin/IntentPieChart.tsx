import React from 'react';
import type { IntentDistribution } from '../../api/admin';
import { intentLabel } from '../../i18n';
import { useTranslation } from '../../hooks/usePreferences';

interface IntentPieChartProps {
  data: IntentDistribution[];
  height?: number;
}

const INTENT_COLORS: Record<string, string> = {
  refund: '#e34d59',
  order: '#0052d9',
  technical: '#e37318',
  general: '#8b8b8b',
};

/**
 * Simple horizontal bar chart for intent distribution.
 * Uses pure CSS/DOM rendering without external chart library dependency.
 */
export function IntentPieChart({ data, height = 200 }: IntentPieChartProps): React.ReactElement {
  const { language, t } = useTranslation();

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
        {t('dashboard.noData')}
      </div>
    );
  }

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div style={{ padding: '8px 0' }}>
      {data.map((item) => {
        const color = INTENT_COLORS[item.intent] || '#8b8b8b';
        const label = intentLabel(language, item.intent) || item.intent;
        const barWidth = item.count > 0 ? (item.count / maxCount) * 100 : 0;

        return (
          <div
            key={item.intent}
            style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '12px',
              gap: '12px',
            }}
          >
            {/* Label */}
            <div
              style={{
                width: '48px',
                fontSize: '13px',
                color: 'var(--app-text-secondary)',
                fontWeight: 500,
                textAlign: 'right',
                flexShrink: 0,
              }}
            >
              {label}
            </div>

            {/* Bar container */}
            <div style={{ flex: 1, position: 'relative', height: '24px' }}>
              {/* Background */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: 'var(--app-surface-muted)',
                  borderRadius: '4px',
                }}
              />
              {/* Filled bar */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: `${Math.max(barWidth, 2)}%`,
                  backgroundColor: color,
                  borderRadius: '4px',
                  transition: 'width 0.5s ease',
                  opacity: 0.85,
                  minWidth: barWidth > 0 ? '4px' : '0',
                }}
              />
            </div>

            {/* Count + percentage */}
            <div
              style={{
                width: '80px',
                fontSize: '12px',
                color: 'var(--app-text-muted)',
                flexShrink: 0,
                textAlign: 'left',
              }}
            >
              {item.count} {t('unit.messages')} ({item.percentage.toFixed(1)}%)
            </div>
          </div>
        );
      })}
    </div>
  );
}
