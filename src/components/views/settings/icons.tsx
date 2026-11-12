import React from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const SettingsIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const PaletteIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
    <circle cx="13.5" cy="6.5" fill="currentColor" r=".5" />
    <circle cx="17.5" cy="10.5" fill="currentColor" r=".5" />
    <circle cx="8.5" cy="7.5" fill="currentColor" r=".5" />
    <circle cx="6.5" cy="12.5" fill="currentColor" r=".5" />
  </svg>
);

export const MicIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M12 19v3" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <rect height="13" rx="3" width="6" x="9" y="2" />
  </svg>
);

export const BrainIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M12 18V5" />
    <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
    <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5A3.5 3.5 0 1 0 4 11.5a3.5 3.5 0 0 0 1.5 2.873V15a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-.627A3.5 3.5 0 0 0 20 11.5a3.5 3.5 0 0 0-2.402-5z" />
  </svg>
);

export const KeyboardIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <rect height="16" rx="2" width="20" x="2" y="4" />
    <path d="M6 8h.01" />
    <path d="M10 8h.01" />
    <path d="M14 8h.01" />
    <path d="M18 8h.01" />
    <path d="M6 12h.01" />
    <path d="M18 12h.01" />
    <path d="M10 12h4" />
  </svg>
);

export const ScrollTextIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M15 12h-5" />
    <path d="M15 8h-5" />
    <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
  </svg>
);

export const ChevronLeftIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export const SunIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

export const MoonIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2.5, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const RefreshCwIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

export const ShieldIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 0 1.52 0C14.5 4.8 17 6 19 6a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const SparklesIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
  </svg>
);

export const ArrowUpRightIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M7 7h10v10" />
    <path d="M7 17 17 7" />
  </svg>
);

export const WrenchIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l7.91-7.91A6 6 0 0 1 14.7 6.3z" />
  </svg>
);

export const MinusIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M5 12h14" />
  </svg>
);

export const SquareTerminalIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect height="18" rx="2" width="18" x="3" y="3" />
  </svg>
);

export const BellIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const AudioWaveformIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2" />
  </svg>
);

export const UsersIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const PuzzleIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M19.439 7.85c0-1.57.802-2.54 1.674-3.15C20.24 3.75 18.832 3 17 3c-1.397 0-2.45.64-3.111 1.48C13.25 5.27 12 5.08 12 3.5V3H7.5C5.57 3 4 4.57 4 6.5V11c1.58 0 1.77 1.25.98 1.889C4.14 13.55 3.5 14.603 3.5 16c0 1.832.75 3.24 1.7 4.113.61-.872 1.58-1.674 3.15-1.674 1.57 0 2.54.802 3.15 1.674.873-.95 2.281-1.7 4.113-1.7 1.397 0 2.45-.64 3.111-1.48.639-.79 1.889-.6 1.889.98V18h.5c1.93 0 3.5-1.57 3.5-3.5V10c-1.58 0-1.77-1.25-.98-1.889C20.24 7.45 19.439 7.85 19.439 7.85z" />
  </svg>
);

export const CircleUserRoundIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M17.925 20.056a6 6 0 0 0-11.851.001" />
    <circle cx="12" cy="11" r="4" />
    <circle cx="12" cy="12" r="10" />
  </svg>
);

export const SmartphoneNfcIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <rect height="12" rx="1" width="7" x="2" y="6" />
    <path d="M13 8.32a7.43 7.43 0 0 1 0 7.36" />
    <path d="M16.46 6.21a11.76 11.76 0 0 1 0 11.58" />
    <path d="M19.91 4.1a15.91 15.91 0 0 1 .01 15.8" />
  </svg>
);

export const ArrowDownToLineIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
    <path d="M19 21H5" />
  </svg>
);

export const GaugeIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </svg>
);

export const TerminalIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

export const KeyIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m21 2-2 2m-1.5 1.5L13 10m-3-3 2 2m-2-2a7 7 0 1 0-9.9 9.9 7 7 0 0 0 9.9-9.9Z" />
  </svg>
);

export const GlobeIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </svg>
);

export const CopyIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <rect height="13" rx="2" ry="2" width="13" x="9" y="9" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const TrashIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

export const ExternalLinkIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

export const StarIcon: React.FC<IconProps & { filled?: boolean }> = ({
  size = 14,
  strokeWidth = 1.75,
  filled = false,
  className = '',
  style,
}) => (
  <svg
    aria-hidden="true"
    className={className}
    fill={filled ? 'currentColor' : 'none'}
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const ChevronUpIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="m18 15-6-6-6 6" />
  </svg>
);

export const AlertCircleIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

export const CheckCircleIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const SearchIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.75, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

export const XIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className = '', style }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    style={style}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
