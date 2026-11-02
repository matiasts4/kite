import React from 'react';

export const Sparkline: React.FC<{
  values: number[];
  maxVal?: number;
  color: string;
  height?: number;
  width?: number;
}> = ({ values, maxVal, color, height = 34, width = 140 }) => {
  const safeValues = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const computedMax = Math.max(maxVal ?? 0, ...safeValues, 1);
  const minVal = 0;
  const range = Math.max(1, computedMax - minVal);

  const pts = safeValues.map((v, i) => {
    const x = (i / Math.max(1, safeValues.length - 1)) * width;
    const clamped = Math.max(minVal, Math.min(computedMax, v));
    const y = height - 3 - ((clamped - minVal) / range) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylinePoints = pts.join(' ');
  const areaPoints = `0,${height} ${polylinePoints} ${width},${height}`;
  const gradId = `spark-grad-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', overflow: 'visible', flexShrink: 0 }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`} />
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polylinePoints}
      />
    </svg>
  );
};

export const CircularGauge: React.FC<{
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color: string;
  label?: string;
}> = ({ percentage, size = 42, strokeWidth = 3.5, color, label }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)', display: 'block', overflow: 'visible' }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="color-mix(in srgb, var(--text-secondary) 22%, transparent)"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="transparent"
          style={{
            transition: 'stroke-dashoffset 380ms cubic-bezier(0.16, 1, 0.3, 1), stroke 250ms ease',
          }}
        />
      </svg>
      {label && (
        <span
          style={{
            position: 'absolute',
            fontSize: '10px',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
};
