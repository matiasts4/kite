import React from 'react';
import './primitives.css';

export type CardPadding = 'none' | 'sm' | 'md';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  selected?: boolean;
  padding?: CardPadding;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  function Card(
    {
      interactive = false,
      selected = false,
      padding = 'md',
      className = '',
      children,
      ...rest
    },
    ref
  ) {
    const classes = [
      'kite-card',
      `kite-card--pad-${padding}`,
      interactive ? 'kite-card--interactive' : '',
      selected ? 'kite-card--selected' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        data-interactive={interactive ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        className={classes}
        {...rest}
      >
        {children}
      </div>
    );
  }
);

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className = '', children, ...rest }, ref) {
    return (
      <div ref={ref} className={['kite-card__header', className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </div>
    );
  }
);

export const CardBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardBody({ className = '', children, ...rest }, ref) {
    return (
      <div ref={ref} className={['kite-card__body', className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </div>
    );
  }
);

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className = '', children, ...rest }, ref) {
    return (
      <div ref={ref} className={['kite-card__footer', className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </div>
    );
  }
);
