import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion } from './context';

interface SwapLabelProps {
  value: string;
  labels: readonly string[];
  className?: string;
}

/** A label taking turns: the box is sized by the longest label, the swap is a blur. */
export function SwapLabel({ value, labels, className = '' }: SwapLabelProps) {
  const motionTokens = useLabMotion();
  return (
    <span className={`alab-swap ${className}`.trim()}>
      {labels.map((label) => (
        <span key={label} className="alab-swap__ghost" aria-hidden="true">
          {label}
        </span>
      ))}
      <span className="alab-swap__live">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value}
            className="alab-swap__value"
            initial={{ opacity: 0, filter: motionTokens.swapBlur }}
            animate={{
              opacity: 1,
              filter: 'blur(0px)',
              transition: motionTokens.tweens.swap,
            }}
            exit={{
              opacity: 0,
              filter: motionTokens.swapBlur,
              transition: motionTokens.tweens.swap,
            }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}

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
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export function ChevronDownIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function BellIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function MoreIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
