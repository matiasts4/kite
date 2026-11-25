import React from 'react';
import './primitives.css';

export type EmptyStateTone = 'neutral' | 'error';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: EmptyStateTone;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  function EmptyState(
    { icon, title, description, action, tone = 'neutral', className = '', ...rest },
    ref
  ) {
    const classes = [
      'kite-empty',
      tone === 'error' ? 'kite-empty--error' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        role={tone === 'error' ? 'alert' : undefined}
        className={classes}
        {...rest}
      >
        {icon && <div className="kite-empty__icon">{icon}</div>}
        <h3 className="kite-empty__title">{title}</h3>
        {description && <p className="kite-empty__description">{description}</p>}
        {action && <div className="kite-empty__action">{action}</div>}
      </div>
    );
  }
);
