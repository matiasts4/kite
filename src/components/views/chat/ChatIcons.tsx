import React from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  fill?: string;
  strokeWidth?: number;
}

const createIcon = (
  defaultSize: number,
  children: React.ReactNode,
  viewBox: string = '0 0 24 24',
  defaultStroke: number = 2,
  defaultFill: string = 'none'
): React.FC<IconProps> => {
  const Icon: React.FC<IconProps> = ({
    size = defaultSize,
    className = '',
    style,
    fill = defaultFill,
    strokeWidth = defaultStroke,
  }) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      {children}
    </svg>
  );
  return Icon;
};

export const BrainIcon = createIcon(
  13,
  <>
    <path d="M12 18V5" />
    <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
    <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
    <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
    <path d="M18 18a4 4 0 0 0 2-7.464" />
    <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
    <path d="M6 18a4 4 0 0 1-2-7.464" />
    <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
  </>,
  "0 0 24 24",
  2.25,
  "none"
);

export const ShieldIcon = createIcon(
  13,
  <>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const SendIcon = createIcon(
  14,
  <>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const StopIcon = createIcon(
  13,
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ChevronDownIcon = createIcon(
  11,
  <>
    <path d="m6 9 6 6 6-6" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ChevronRightIcon = createIcon(
  12,
  <>
    <path d="m9 18 6-6-6-6" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ChevronsUpDownIcon = createIcon(
  10,
  <>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const PaperclipIcon = createIcon(
  13,
  <>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CloseIcon = createIcon(
  12,
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CheckIcon = createIcon(
  12,
  <>
    <polyline points="20 6 9 17 4 12" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CopyIcon = createIcon(
  12,
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CpuIcon = createIcon(
  13,
  <>
    <rect width="16" height="16" x="4" y="4" rx="2" />
    <path d="M9 9h6v6H9z" />
    <path d="M9 1v3" />
    <path d="M15 1v3" />
    <path d="M9 20v3" />
    <path d="M15 20v3" />
    <path d="M20 9h3" />
    <path d="M20 15h3" />
    <path d="M1 9h3" />
    <path d="M1 15h3" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CompassIcon = createIcon(
  13,
  <>
    <circle cx="12" cy="12" r="10" />
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const FileCodeIcon = createIcon(
  13,
  <>
    <path d="M10 12.5 8 15l2 2.5" />
    <path d="m14 12.5 2 2.5-2 2.5" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M4 10V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const UserIcon = createIcon(
  12,
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const BotIcon = createIcon(
  12,
  <>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M9 13v2" />
    <path d="M15 13v2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const TerminalIcon = createIcon(
  12,
  <>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" x2="20" y1="19" y2="19" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const WrenchIcon = createIcon(
  12,
  <>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const AlertCircleIcon = createIcon(
  12,
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const MessageSquareIcon = createIcon(
  13,
  <>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const PlusIcon = createIcon(
  12,
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const PinIcon = createIcon(
  13,
  <>
    <line x1="12" x2="12" y1="17" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ArchiveIcon = createIcon(
  13,
  <>
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const GitBranchIcon = createIcon(
  10,
  <>
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const FolderIcon = createIcon(
  14,
  <>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ClockIcon = createIcon(
  11,
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const Columns2Icon = createIcon(
  13,
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M12 3v18" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const PencilIcon = createIcon(
  11,
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const SpinnerIcon = createIcon(
  14,
  <>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const EyeIcon = createIcon(
  12,
  <>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ZapIcon = createIcon(
  12,
  <>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ListChecksIcon = createIcon(
  12,
  <>
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const RefreshIcon = createIcon(
  12,
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const DiffIcon = createIcon(
  12,
  <>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <line x1="9" x2="15" y1="12" y2="12" />
    <line x1="12" x2="12" y1="9" y2="15" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const SearchIcon = createIcon(
  14,
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const ArrowUpIcon = createIcon(
  14,
  <>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const SquarePenIcon = createIcon(
  13,
  <>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const PanelRightIcon = createIcon(
  13,
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const FolderPlusIcon = createIcon(
  13,
  <>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" />
    <path d="M9 13h6" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const SquareTerminalIcon = createIcon(
  13,
  <>
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const CalendarIcon = createIcon(
  12,
  <>
    <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
    <line x1="16" x2="16" y1="2" y2="6" />
    <line x1="8" x2="8" y1="2" y2="6" />
    <line x1="3" x2="21" y1="10" y2="10" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const GlobeIcon = createIcon(
  12,
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </>,
  "0 0 24 24",
  2,
  "none"
);

export const MicIcon = createIcon(
  14,
  <>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </>,
  "0 0 24 24",
  2,
  "none"
);
