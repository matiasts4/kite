import React, { useId } from 'react';

export const Sparkline: React.FC<{
  values: number[];
  maxVal?: number;
  color: string;
  height?: number;
  width?: number;
}> = React.memo(({ values, maxVal, color, height = 34, width = 140 }) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const safeValues = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const computedMax = Math.max(maxVal ?? 0, ...safeValues, 1);
  const minVal = 0;
  const range = Math.max(1, computedMax - minVal);
  const padY = 4;

  const coords = safeValues.map((v, i) => {
    const x = (i / Math.max(1, safeValues.length - 1)) * (width - 4) + 1;
    const clamped = Math.max(minVal, Math.min(computedMax, v));
    const y = height - padY - ((clamped - minVal) / range) * (height - padY * 2);
    return { x, y };
  });

  const polylinePoints = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const firstX = coords[0]?.x ?? 1;
  const last = coords[coords.length - 1] ?? { x: width - 3, y: height - padY };
  const areaPoints = `${firstX.toFixed(1)},${height} ${polylinePoints} ${last.x.toFixed(1)},${height}`;
  const gradId = `spark-grad-${uid}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 block overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
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
      <circle cx={last.x} cy={last.y} r="4.5" fill={color} fillOpacity="0.22" />
      <circle cx={last.x} cy={last.y} r="2.1" fill={color} />
    </svg>
  );
});

export const CircularGauge: React.FC<{
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color: string;
  label?: string;
}> = React.memo(({ percentage, size = 46, strokeWidth = 3.5, color, label }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  return (
    <div className="tm-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="tm-gauge__svg" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="tm-gauge__track"
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
          className="tm-gauge__arc"
        />
      </svg>
      {label && <span className="tm-gauge__label">{label}</span>}
    </div>
  );
});
