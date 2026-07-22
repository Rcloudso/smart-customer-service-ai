import React, { useRef, useState } from 'react';
import { useTranslation } from '../../hooks/usePreferences';

interface SatisfactionRatingProps {
  currentRating?: number;
  onSubmitRating: (rating: number) => Promise<boolean>;
}

/**
 * 1-5 star satisfaction rating component.
 * Only shown after AI message is complete.
 */
export function SatisfactionRating({
  currentRating,
  onSubmitRating,
}: SatisfactionRatingProps): React.ReactElement {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(!!currentRating);
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  const { t } = useTranslation();
  const starLabels = [1, 2, 3, 4, 5].map((rating) => t(`chat.rating.${rating}`));

  const handleClick = async (rating: number) => {
    if (inFlightRef.current || submitted) return;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      if (await onSubmitRating(rating)) setSubmitted(true);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const displayRating = hoveredIndex ?? currentRating ?? 0;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '12px',
        color: 'var(--app-text-muted)',
      }}
    >
      <span>{t('chat.rating')}</span>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayRating;
        return (
          <button
            key={star}
            type="button"
            onClick={() => void handleClick(star)}
            onMouseEnter={() => !submitted && !submitting && setHoveredIndex(star)}
            onMouseLeave={() => !submitted && !submitting && setHoveredIndex(null)}
            disabled={submitted || submitting}
            title={starLabels[star - 1]}
            style={{
              background: 'none',
              border: 'none',
              cursor: submitted || submitting ? 'default' : 'pointer',
              fontSize: '20px',
              color: filled ? '#f5a623' : '#d0d0d0',
              padding: 0,
              lineHeight: 1,
              transition: 'color 0.15s ease, transform 0.15s ease',
              transform: filled && !submitted ? 'scale(1.1)' : 'scale(1)',
            }}
          >
            {filled ? '★' : '☆'}
          </button>
        );
      })}
      {submitted && (
        <span style={{ marginLeft: '4px', color: 'var(--app-success)' }}>
          {t('chat.rated')}
        </span>
      )}
      {hoveredIndex && !submitted && (
        <span style={{ marginLeft: '4px' }}>
          {starLabels[hoveredIndex - 1]}
        </span>
      )}
    </div>
  );
}
