import { prefersReducedMotion, MOTION_EXIT_MS } from '../../contract';

export { prefersReducedMotion, MOTION_EXIT_MS };

/* -------------------------------------------------------------------------- */
/* Local icons (the shared ui.tsx is owned by the lab shell)                   */
/* -------------------------------------------------------------------------- */

export interface LocalIconProps {
  size?: number;
  className?: string;
}

export function localIconProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export function SearchIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SidebarIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m14 10 2 2-2 2" />
    </svg>
  );
}

export function TerminalIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

export function StopIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 16, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
