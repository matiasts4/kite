import { useEffect, useState } from 'react';
import { CheckGlyph, CopyGlyph } from '../dockIcons';

export interface DiffFilePathCopyButtonProps {
  path: string;
  className?: string;
  size?: number;
}

/**
 * Click-to-copy button for file paths inside diff headers; briefly swaps to a
 * checkmark to confirm clipboard write without shifting neighboring badges.
 */
export function DiffFilePathCopyButton({
  path,
  className = '',
  size = 12,
}: DiffFilePathCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(path).catch(() => {});
    }
    setCopied(true);
  };

  return (
    <button
      type="button"
      className={`kite-diff-copy-btn ${copied ? 'copied' : ''} ${className}`.trim()}
      onClick={handleClick}
      title={copied ? `Copied ${path}` : `Copy path: ${path}`}
      aria-label={copied ? `Copied ${path}` : `Copy path ${path}`}
    >
      {copied ? <CheckGlyph size={size} /> : <CopyGlyph size={size} />}
    </button>
  );
}
