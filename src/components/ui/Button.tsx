import React from 'react';
import './primitives.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      iconOnly = false,
      loading = false,
      leftIcon,
      rightIcon,
      disabled,
      type = 'button',
      className = '',
      children,
      ...rest
    },
    ref
  ) {
    const classes = [
      'kite-btn',
      `kite-btn--${variant}`,
      `kite-btn--${size}`,
      iconOnly ? 'kite-btn--icon' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type={type}
        disabled={Boolean(disabled || loading)}
        aria-busy={loading || undefined}
        className={classes}
        {...rest}
      >
        {loading ? (
          <span className="kite-btn__spinner" aria-hidden="true" />
        ) : (
          leftIcon && <span className="kite-btn__icon">{leftIcon}</span>
        )}
        {children}
        {!loading && rightIcon && <span className="kite-btn__icon">{rightIcon}</span>}
      </button>
    );
  }
);
