import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export function HtmlRenderDialog({
  html,
  title,
  onClose,
}: {
  html: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="html-render-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="html-render-dialog__bar">
        <span>{title}</span>
        <button type="button" className="chrome-button" onClick={onClose}>
          Close
        </button>
      </div>
      <iframe title={title} sandbox="allow-scripts" srcDoc={html} className="html-render-dialog__frame" />
    </div>,
    document.body,
  );
}
