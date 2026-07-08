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
  blue: { bg: 'var(--app-surface)', accent: 'var(--app-link)' },
  green: { bg: 'var(--app-surface)', accent: 'var(--app-success)' },
  orange: { bg: 'var(--app-surface)', accent: 'var(--app-warning)' },
  red: { bg: 'var(--app-surface)', accent: 'var(--app-danger)' },
  purple: { bg: 'var(--app-surface)', accent: 'var(--app-stat-purple)' },
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
      className="app-panel-card app-stat-card"
      style={{
        backgroundColor: theme.bg,
        '--app-stat-accent': theme.accent,
      } as React.CSSProperties}
    >
      <div className="app-stat-card__content">
        <div>
          <div className="app-stat-card__label">
            {title}
          </div>
          <div className="app-stat-card__value-row">
            <span className="app-stat-card__value">
              {value}
            </span>
            {unit && (
              <span className="app-stat-card__unit">
                {unit}
              </span>
            )}
          </div>
        </div>
        {icon && (
          <div className="app-stat-card__icon">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
