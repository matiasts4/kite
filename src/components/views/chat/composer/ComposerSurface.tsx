import type { ComponentProps } from 'react';

function Shell({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-shell"
      className={`kite-composer-shell ${className}`.trim()}
      {...props}
    />
  );
}

function Main({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-main"
      className={`kite-composer-main ${className}`.trim()}
      {...props}
    />
  );
}

function ContextStrip({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-context-strip"
      className={`kite-composer-context-strip ${className}`.trim()}
      {...props}
    />
  );
}

export const ComposerSurface = {
  Shell,
  Main,
  ContextStrip,
};
