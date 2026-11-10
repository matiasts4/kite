import { useMemo, useState } from 'react';

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export function DiffStatLabel({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600">+{additions}</span>{' '}
      <span className="text-red-600">-{deletions}</span>
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
    () => files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 }),
    [files]
  );
  const hasDirs = files.some((file) => file.path.includes('/'));
  if (files.length === 0) return null;
  const label = files.length === 1 ? '1 changed file' : `${files.length} changed files`;
  return (
    <section className="changed-files-card border border-border bg-muted/40 p-3" aria-label={label}>
      <header className="flex items-center gap-2">
        <strong>{label}</strong>
        <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
        {hasDirs ? (
          <button type="button" aria-label={open ? 'Collapse folders' : 'Expand folders'} onClick={() => setOpen((value) => !value)}>
            {open ? 'Collapse' : 'Expand'}
          </button>
        ) : null}
        <button type="button" className="ml-auto rounded-control px-2" onClick={onOpenTurnDiff}>Open diff</button>
      </header>
      {open ? (
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <button type="button" onClick={() => onOpenFile?.(file.path)}>
                {file.path} <DiffStatLabel additions={file.additions} deletions={file.deletions} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
