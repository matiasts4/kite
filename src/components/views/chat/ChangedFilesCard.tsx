import { useMemo, useState } from 'react';
import { FileCodeIcon } from './ChatIcons';
import { stripWorkspacePathPrefix } from '../../../lib/diffPreviewNav';

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export function formatDisplayPath(filePath: string, workspaceName?: string | null): string {
  return stripWorkspacePathPrefix(filePath, workspaceName);
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
  workspaceName,
  onOpenTurnDiff,
  onOpenFile,
}: {
  files: ChangedFile[];
  workspaceName?: string | null;
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
  const formattedFiles = useMemo(
    () =>
      files.map((file) => ({
        file,
        display: formatDisplayPath(file.path, workspaceName),
      })),
    [files, workspaceName]
  );
  const hasCollapsibleGroups =
    files.length > 2 || formattedFiles.some(({ display }) => display.includes('/'));
  if (files.length === 0) return null;
  const label = files.length === 1 ? '1 changed file' : `${files.length} changed files`;

  return (
    <div className="changed-files-shell">
      <section className="changed-files-card" aria-label={label}>
        <header className="changed-files-card__header">
          <div className="changed-files-card__summary">
            <strong className="changed-files-card__title">{label}</strong>
            <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
          </div>
          <div className="changed-files-card__actions">
            {hasCollapsibleGroups ? (
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
          </div>
        </header>
        {open ? (
          <ul className="changed-files-card__list scroll-quiet">
            {formattedFiles.map(({ file, display }) => (
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
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
