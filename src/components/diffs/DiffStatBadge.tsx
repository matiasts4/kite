import React from 'react';

export interface DiffStatBadgeProps {
  additions: number;
  deletions: number;
  className?: string;
  compact?: boolean;
  showZero?: boolean;
  title?: string;
}

/**
 * Compact `+A -D` diff line count badge shared across the Diffs toolbar,
 * hierarchical file tree, sticky file headers, and focused viewer header.
 */
export const DiffStatBadge: React.FC<DiffStatBadgeProps> = ({
  additions,
  deletions,
  className = '',
  compact = false,
  showZero = false,
  title,
}) => {
  if (!showZero && additions <= 0 && deletions <= 0) {
    return null;
  }

  return (
    <span
      className={`diffs-stat-badge ${compact ? 'diffs-stat-badge--compact' : ''} ${className}`.trim()}
      title={title ?? `+${additions} additions, -${deletions} deletions`}
      aria-label={`+${additions} -${deletions}`}
    >
      {(additions > 0 || showZero) && (
        <span className="diffs-stat-add">+{additions}</span>
      )}
      {(deletions > 0 || showZero) && (
        <span className="diffs-stat-del">-{deletions}</span>
      )}
    </span>
  );
};
