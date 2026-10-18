import React from 'react';

export const PlusIcon: React.FC<{ size?: number; strokeWidth?: number; className?: string }> = ({
  size = 13,
  strokeWidth = 2,
  className = '',
}) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

export const SunIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
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

export const MoonIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </svg>
);

export const SettingsIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const PinIcon: React.FC<{ size?: number; filled?: boolean; className?: string }> = ({
  size = 11,
  filled = false,
  className = '',
}) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
);

export const ChevronRightIcon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }> = ({
  size = 10,
  className = '',
  style,
}) => (
  <svg
    aria-hidden="true"
    className={className}
    style={style}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const CloseIcon: React.FC<{ size?: number; className?: string }> = ({ size = 10, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const FolderOpenIcon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }> = ({
  size = 14,
  className = '',
  style,
}) => (
  <svg
    aria-hidden="true"
    className={className}
    style={style}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </svg>
);

export const NetworkIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="16" y="16" width="6" height="6" rx="1" />
    <rect x="2" y="16" width="6" height="6" rx="1" />
    <rect x="9" y="2" width="6" height="6" rx="1" />
    <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
    <path d="M12 12V8" />
  </svg>
);

export const SlidersHorizontalIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 5H3" />
    <path d="M12 19H3" />
    <path d="M14 3v4" />
    <path d="M16 17v4" />
    <path d="M21 12h-9" />
    <path d="M21 19h-5" />
    <path d="M21 5h-7" />
    <path d="M8 10v4" />
    <path d="M8 12H3" />
  </svg>
);

export const TrashIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const CopyIcon: React.FC<{ size?: number; className?: string }> = ({ size = 11, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

export const ArchiveIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

export const SearchIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </svg>
);

export const DownloadIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 15V3" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
  </svg>
);

export const PencilIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
);

export const MessageSquareIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);


export const ArrowUpIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
);

export const ArrowDownIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

export const CheckIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    viewBox="0 0 24 24"
    width={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

