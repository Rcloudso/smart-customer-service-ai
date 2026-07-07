import React from 'react';

interface LoadingSkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string;
  count?: number;
  style?: React.CSSProperties;
}

/**
 * A simple skeleton loading placeholder component.
 */
export function LoadingSkeleton({
  width = '100%',
  height = '16px',
  borderRadius = '4px',
  count = 1,
  style = {},
}: LoadingSkeletonProps): React.ReactElement {
  const items = Array.from({ length: count }, (_, i) => i);

  return (
    <>
      {items.map((i) => (
        <div
          key={i}
          style={{
            width: typeof width === 'number' ? `${width}px` : width,
            height: typeof height === 'number' ? `${height}px` : height,
            borderRadius,
            background: 'linear-gradient(90deg, var(--app-skeleton-a) 25%, var(--app-skeleton-b) 50%, var(--app-skeleton-a) 75%)',
            backgroundSize: '200% 100%',
            animation: 'skeleton-loading 1.5s ease-in-out infinite',
            marginBottom: i < count - 1 ? '8px' : 0,
            ...style,
          }}
        />
      ))}
      <style>{`
        @keyframes skeleton-loading {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </>
  );
}
