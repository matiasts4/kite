import { useMemo, useState } from 'react';
import { FileCodeIcon } from './ChatIcons';

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export function formatDisplayPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const srcIdx = parts.findIndex((p) => p === 'src' || p === 'src-tauri' || p === 'crates');
  if (srcIdx >= 0) {
    return parts.slice(srcIdx).join('/');
  }
  if (parts.length > 3) {
    return parts.slice(-3).join('/');
  }
  return normalized;
}

export function DiffStatLabel({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stat-label tabular-nums">
      <span className="diff-stat-label__add">+{additions}</span>{' '}
      <span className="diff-stat-label__del">-{deletions}</span>
    </span>
  );
}

export function ChangedFilesCard({
  files,
  onOpenTurnDiff,
  onOpenFile,
}: {
  files: ChangedFile[];
  onOpenTurnDiff?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 }
      ),
    [files]
  );
  const hasDirs = files.some((file) => file.path.includes('/') || file.path.includes('\\'));
  if (files.length === 0) return null;
  const label = files.length === 1 ? '1 changed file' : `${files.length} changed files`;

  return (
    <section className="changed-files-card" aria-label={label}>
      <header className="changed-files-card__header">
        <strong className="changed-files-card__title">{label}</strong>
        <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
        {hasDirs ? (
          <button
            type="button"
            className="changed-files-card__btn"
            aria-label={open ? 'Collapse folders' : 'Expand folders'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Collapse' : 'Expand'}
          </button>
        ) : null}
        <button
          type="button"
          className="changed-files-card__btn changed-files-card__open-diff"
          onClick={onOpenTurnDiff}
        >
          Open diff
        </button>
      </header>
      {open ? (
        <ul className="changed-files-card__list">
          {files.map((file) => {
            const display = formatDisplayPath(file.path);
            return (
              <li key={file.path} className="changed-files-card__item">
                <button
                  type="button"
                  className="changed-files-card__file-btn"
                  onClick={() => onOpenFile?.(file.path)}
                  title={file.path}
                >
                  <FileCodeIcon size={12} className="changed-files-card__icon" />
                  <span className="changed-files-card__path">{display}</span>
                  <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
