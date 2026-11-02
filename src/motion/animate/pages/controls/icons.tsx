interface IconProps {
  size?: number;
  className?: string;
}

function iconProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export function PlayIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M9 5.5l9 6.5-9 6.5Z" />
    </svg>
  );
}

export function PauseIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function SunIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </svg>
  );
}

export function MoonIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />
    </svg>
  );
}

export function BookmarkIcon({
  size = 15,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...iconProps(size, className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M6 4.5h12v16l-6-4-6 4Z" />
    </svg>
  );
}

export function HeartIcon({
  size = 15,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...iconProps(size, className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 20.5 4.2 12.8a4.8 4.8 0 0 1 0-6.9 5 5 0 0 1 7-0.1l.8.8.8-.8a5 5 0 0 1 7 .1 4.8 4.8 0 0 1 0 6.9Z" />
    </svg>
  );
}

export function CloudIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M7 18h10a3.5 3.5 0 0 0 .6-6.9A5.5 5.5 0 0 0 7 9.2 4.4 4.4 0 0 0 7 18Z" />
    </svg>
  );
}

export function SpinnerIcon({ size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
