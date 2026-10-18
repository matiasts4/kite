import React from 'react';

export interface QuotaProgressRingProps {
  percentage?: number;
  size?: number;
  strokeWidth?: number;
  dimmed?: boolean;
  className?: string;
}

export const QuotaProgressRing: React.FC<QuotaProgressRingProps> = ({
  percentage = 100,
  size = 15,
  strokeWidth = 2,
  dimmed = false,
  className = '',
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  let strokeColor = 'var(--status-running)';
  if (dimmed) {
    strokeColor = 'var(--text-secondary)';
  } else if (clamped < 20) {
    strokeColor = 'var(--status-failed)';
  } else if (clamped < 45) {
    strokeColor = 'var(--warning-text)';
  }

  return (
    <svg
      width={size}
      height={size}
      className={`shrink-0 -rotate-90 ${className}`}
      style={{ display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        style={{ stroke: 'color-mix(in srgb, var(--text-secondary) 28%, transparent)' }}
        strokeWidth={strokeWidth}
        fill="transparent"
      />
      {/* Progress arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        fill="transparent"
        style={{
          stroke: strokeColor,
          transition: 'stroke-dashoffset 400ms cubic-bezier(0.16, 1, 0.3, 1), stroke 300ms ease',
        }}
      />
    </svg>
  );
};
