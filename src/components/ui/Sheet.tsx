import React, { useRef, useId, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { springs } from '../../motion/standard/tokens';

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

const DIALOG_MOTION = surfaceMotion('dialog');

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
  const lastDialogRef = useRef<HTMLDialogElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [scale, setScale] = useState(1);
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const attachDialog = useCallback((node: HTMLDialogElement | null) => {
    dialogRef.current = node;
    // Keep the node after React detaches it: the exit finishes in the same
    // commit that removes the dialog, so `dialogRef` is already null by then.
    if (node) lastDialogRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    setScale(getUiScale(dialog));
    if (dialog.open) return;

    // `<dialog>.close()` restores focus to whatever was focused before
    // `showModal()`. Keep that element: the element leaves the DOM before the
    // browser can do it for us once the exit has played.
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body && !dialog.contains(active)
        ? active
        : null;

    dialog.showModal();
    if (initialFocus === 'primary') {
      dialog.querySelector<HTMLButtonElement>('.ui-sheet__footer button[type="submit"]:not(:disabled)')?.focus({ preventScroll: true });
    }
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
    // Re-bind when the dialog element mounts with `open`.
  }, [open]);

  const handleExitComplete = useCallback(() => {
    const dialog = lastDialogRef.current;
    lastDialogRef.current = null;
    if (dialog?.open) dialog.close();

    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!previous?.isConnected) return;
    // Only restore when nothing else claimed the focus while closing.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    previous.focus({ preventScroll: true });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (primary && !primary.disabled && !primary.loading) {
      primary.onClick?.();
    }
  };

  const style: React.CSSProperties = {
    '--sheet-width': `${width}px`,
    '--sheet-scale': String(scale),
    // Motion owns the entrance and exit; the legacy `ui-sheet-in` keyframes
    // would otherwise fight the animated transform.
    animation: 'none',
    ...(height !== undefined ? { height: `${height}px` } : {}),
  } as React.CSSProperties;

  const sheet = (
    <motion.dialog
      key="sheet"
      {...DIALOG_MOTION}
      transition={springs.dialog}
      ref={attachDialog}
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
    </motion.dialog>
  );

  if (typeof document === 'undefined') return open ? sheet : null;

  return createPortal(
    <AnimatePresence onExitComplete={handleExitComplete}>{open ? sheet : null}</AnimatePresence>,
    document.querySelector('.app-frame--scaled') ?? document.body
  );
};
