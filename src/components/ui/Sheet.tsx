import React, { useRef, useId, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SheetButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface SheetProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  width?: number;
  height?: number;
  onCancel: () => void;
  primary?: SheetButtonProps;
  secondary?: SheetButtonProps;
  children?: React.ReactNode;
  className?: string;
  ariaLabel?: string;
  initialFocus?: 'first' | 'primary';
}

function getUiScale(el: HTMLElement | null): number {
  const scaled = el?.closest('.app-frame--scaled') ?? document.querySelector('.app-frame--scaled');
  if (!scaled) return 1;
  const val = Number(window.getComputedStyle(scaled).getPropertyValue('--ui-scale'));
  return Number.isFinite(val) && val > 0 ? val : 1;
}

export const Sheet: React.FC<SheetProps> = ({
  open,
  title,
  description,
  width = 440,
  height,
  onCancel,
  primary,
  secondary,
  children,
  className,
  ariaLabel,
  initialFocus = 'first',
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [scale, setScale] = useState(1);
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    setScale(getUiScale(dialog));
    if (!dialog.open) {
      dialog.showModal();
      if (initialFocus === 'primary') {
        dialog.querySelector<HTMLButtonElement>('.ui-sheet__footer button[type="submit"]:not(:disabled)')?.focus({ preventScroll: true });
      }
    }

    return () => {
      if (dialog && dialog.open) {
        dialog.close();
      }
    };
  }, [open, initialFocus]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (e: Event) => {
      e.preventDefault();
      cancelRef.current();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, []);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (primary && !primary.disabled && !primary.loading) {
      primary.onClick?.();
    }
  };

  const style: React.CSSProperties = {
    '--sheet-width': `${width}px`,
    '--sheet-scale': String(scale),
    ...(height !== undefined ? { height: `${height}px` } : {}),
  } as React.CSSProperties;

  const content = (
    <dialog
      ref={dialogRef}
      className={className ? `ui-sheet ${className}` : 'ui-sheet'}
      style={style}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      aria-describedby={description ? descId : undefined}
    >
      <form className="ui-sheet__form" noValidate onSubmit={handleSubmit}>
        <header className="ui-sheet__heading">
          <h2 className="ui-sheet__title" id={titleId}>
            {title}
          </h2>
          {description && (
            <div className="ui-sheet__description" id={descId}>
              {description}
            </div>
          )}
        </header>
        <div className="ui-sheet__body">{children}</div>
        {(primary || secondary) && (
          <footer className="ui-sheet__footer">
            {secondary && (
              <button
                type="button"
                className="secondary-button"
                disabled={secondary.disabled}
                onClick={secondary.onClick}
              >
                {secondary.label}
              </button>
            )}
            <span aria-hidden="true" className="ui-sheet__spacer" />
            {primary && (
              <button
                type="submit"
                className={`primary-button${primary.variant === 'danger' ? ' danger-button' : ''}`}
                disabled={primary.disabled || primary.loading}
              >
                {primary.label}
              </button>
            )}
          </footer>
        )}
      </form>
    </dialog>
  );

  return typeof document !== 'undefined'
    ? createPortal(content, document.querySelector('.app-frame--scaled') ?? document.body)
    : content;
};
