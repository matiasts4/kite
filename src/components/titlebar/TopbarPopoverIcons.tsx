import React from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

const baseProps = (size: number, strokeWidth: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
  className,
});

export const RefreshIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M16 21h5v-5" />
  </svg>
);

export const CloseIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const ArrowUpIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M12 19V5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

export const ArrowRightIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export const ChevronLeftIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.1, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 2.4, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const CheckCheckIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M18 6 7 17l-5-5" />
    <path d="m22 10-7.5 7.5L13 16" />
  </svg>
);

export const CheckCircleIcon: React.FC<IconProps> = ({ size = 18, strokeWidth = 1.75, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m8.5 12.2 2.4 2.4 4.8-5.1" />
  </svg>
);

export const AlertTriangleIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

export const InfoCircleIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const FolderIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
);

export const MonitorIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>
);

export const TerminalIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" x2="20" y1="19" y2="19" />
  </svg>
);

export const CpuChipIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3" />
    <path d="M15 1v3" />
    <path d="M9 20v3" />
    <path d="M15 20v3" />
    <path d="M20 9h3" />
    <path d="M20 14h3" />
    <path d="M1 9h3" />
    <path d="M1 14h3" />
  </svg>
);

export const BotSparkIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

export const ActivityPulseIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

export const HardDriveIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </svg>
);

export const SearchIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const ClockIcon: React.FC<IconProps> = ({ size = 12, strokeWidth = 1.9, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <circle cx="12" cy="12" r="9.5" />
    <polyline points="12 7 12 12 15.5 14" />
  </svg>
);

export const UserVaultIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export const SettingsGearIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 1.85, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const LayersIcon: React.FC<IconProps> = ({ size = 16, strokeWidth = 1.75, className }) => (
  <svg {...baseProps(size, strokeWidth, className)}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);
