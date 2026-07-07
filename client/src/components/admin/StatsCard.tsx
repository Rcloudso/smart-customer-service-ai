import React from 'react';
import { Card } from 'tdesign-react';

interface StatsCardProps {
  title: string;
  value: string | number;
  unit?: string;
  color?: string;
  icon?: React.ReactNode;
}

const COLOR_MAP: Record<string, { bg: string; accent: string }> = {
  blue: { bg: 'var(--app-primary-soft)', accent: 'var(--app-primary)' },
  green: { bg: 'var(--app-stat-green-bg)', accent: 'var(--app-success)' },
  orange: { bg: 'var(--app-stat-orange-bg)', accent: 'var(--app-warning)' },
  red: { bg: 'var(--app-stat-red-bg)', accent: 'var(--app-danger)' },
  purple: { bg: 'var(--app-stat-purple-bg)', accent: 'var(--app-stat-purple)' },
};

/**
 * Statistic display card for admin dashboard.
 */
export function StatsCard({
  title,
  value,
  unit,
  color = 'blue',
  icon,
}: StatsCardProps): React.ReactElement {
  const theme = COLOR_MAP[color] || COLOR_MAP.blue;

  return (
    <Card
      bordered
      className="app-panel-card"
      style={{
        backgroundColor: theme.bg,
        borderColor: `color-mix(in srgb, ${theme.accent} 22%, transparent)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '13px',
              color: 'var(--app-text-secondary)',
              marginBottom: '8px',
              fontWeight: 500,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '4px',
            }}
          >
            <span
              style={{
                fontSize: '28px',
                fontWeight: 700,
                color: theme.accent,
                lineHeight: 1,
              }}
            >
              {value}
            </span>
            {unit && (
              <span style={{ fontSize: '13px', color: 'var(--app-text-muted)' }}>
                {unit}
              </span>
            )}
          </div>
        </div>
        {icon && (
          <div
            style={{
              fontSize: '28px',
              color: theme.accent,
              opacity: 0.5,
            }}
          >
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
