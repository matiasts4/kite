import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import './primitives.css';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const CloseIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  closeLabel = 'Close dialog',
  closeOnBackdrop = true,
  className = '',
  children,
}) => {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="kite-modal-backdrop"
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={['kite-modal', `kite-modal--${size}`, className].filter(Boolean).join(' ')}
      >
        <div className="kite-modal__header">
          <div className="kite-modal__heading">
            <h2 id={titleId} className="kite-modal__title">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="kite-modal__description">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="kite-modal__close"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <CloseIcon />
          </button>
        </div>
        {children !== undefined && <div className="kite-modal__body">{children}</div>}
        {footer !== undefined && <div className="kite-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
};
