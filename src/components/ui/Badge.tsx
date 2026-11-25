import React from 'react';
import './primitives.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type BadgeShape = 'chip' | 'pill';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  shape?: BadgeShape;
  dot?: boolean;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  function Badge(
    { tone = 'neutral', shape = 'chip', dot = false, className = '', children, ...rest },
    ref
  ) {
    const classes = [
      'kite-badge',
      `kite-badge--${tone}`,
      `kite-badge--${shape}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span ref={ref} className={classes} {...rest}>
        {dot && <span className="kite-badge__dot" aria-hidden="true" />}
        {children}
      </span>
    );
  }
);
