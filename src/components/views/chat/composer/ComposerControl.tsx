import React, { forwardRef, type ButtonHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../ChatIcons';

export interface ComposerControlProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  className?: string;
}

export const ComposerControl = forwardRef<HTMLButtonElement, ComposerControlProps>(
  ({ active = false, className = '', children, type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={`kite-composer-control-pill ${
          active ? 'kite-composer-control-pill--active' : ''
        } ${className}`.trim()}
        {...props}
      >
        {children}
      </button>
    );
  }
);
ComposerControl.displayName = 'ComposerControl';

export const ComposerControlSeparator: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span className={`kite-composer-control-separator ${className}`.trim()} aria-hidden="true" />
);

export const ComposerControlChevron: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className = '',
}) => (
  <ChevronDownIcon
    size={size}
    className={`shrink-0 opacity-70 ${className}`.trim()}
    aria-hidden="true"
  />
);

export const ComposerControlIcon: React.FC<{
  icon: any;
  size?: number;
  className?: string;
}> = ({ icon: Icon, size = 14, className = '' }) => (
  <Icon
    size={size}
    width={size}
    height={size}
    className={`shrink-0 ${className}`.trim()}
    aria-hidden="true"
  />
);
