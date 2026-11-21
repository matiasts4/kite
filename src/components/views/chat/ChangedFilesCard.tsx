import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useReduceMotion } from '../../../motion/standard/context';
import { prefersReducedMotion } from '../../../motion/contract';
import { eases, tweens } from '../../../motion/standard/tokens';
import { ChevronDownIcon, FileCodeIcon } from './ChatIcons';
import { ComposerSurface } from './composer/ComposerSurface';
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

export interface ChangedFilesCardProps {
  files: ChangedFile[];
  workspaceName?: string | null;
  variant?: 'standalone' | 'composer-top';
  onOpenTurnDiff?: () => void;
  onOpenFile?: (path: string) => void;
}

export const ChangedFilesCard = memo(function ChangedFilesCard({
  files,
  workspaceName,
  variant = 'standalone',
  onOpenTurnDiff,
  onOpenFile,
}: ChangedFilesCardProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReduceMotion() || prefersReducedMotion();
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
  if (files.length === 0) return null;
  const label = files.length === 1 ? '1 changed file' : `${files.length} changed files`;
  const isComposerTop = variant === 'composer-top';

  const fileList = (
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
  );

  const header = (
    <header className="changed-files-card__header">
      <div className="changed-files-card__summary">
        {isComposerTop && (
          <FileCodeIcon size={13} className="kite-composer-top-strip__lead-icon" />
        )}
        <strong className="changed-files-card__title">{label}</strong>
        <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
      </div>
      <div className="changed-files-card__actions">
        <button
          type="button"
          className={
            isComposerTop ? 'kite-composer-top-strip__btn' : 'changed-files-card__btn'
          }
          aria-expanded={open}
          aria-label={open ? 'Collapse changed files' : 'Expand changed files'}
          onClick={() => setOpen((value) => !value)}
        >
          {isComposerTop && (
            <ChevronDownIcon
              size={11}
              className={`kite-composer-top-strip__chevron${
                open ? ' kite-composer-top-strip__chevron--expanded' : ''
              }`}
            />
          )}
          <span>{open ? 'Collapse' : 'Expand'}</span>
        </button>
        <button
          type="button"
          className={
            isComposerTop
              ? 'kite-composer-top-strip__btn kite-composer-top-strip__btn--open-diff'
              : 'changed-files-card__btn changed-files-card__open-diff'
          }
          onClick={onOpenTurnDiff}
        >
          Open diff
        </button>
      </div>
    </header>
  );

  if (isComposerTop) {
    return (
      <ComposerSurface.TopStrip aria-label={label}>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="changed-files-drawer"
              className="kite-composer-top-strip__drawer"
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{
                opacity: 1,
                height: 'auto',
                transition: reduceMotion ? tweens.instant : tweens.disclosure,
              }}
              exit={
                reduceMotion
                  ? { opacity: 0, height: 0, transition: tweens.instant }
                  : {
                      opacity: 0,
                      height: 0,
                      transition: {
                        height: { duration: 0.22, ease: eases.out },
                        opacity: { duration: 0.14, ease: eases.leave },
                      },
                    }
              }
            >
              {fileList}
            </motion.div>
          )}
        </AnimatePresence>
        {header}
      </ComposerSurface.TopStrip>
    );
  }

  return (
    <div className="changed-files-shell">
      <section className="changed-files-card" aria-label={label}>
        {header}
        {open ? fileList : null}
      </section>
    </div>
  );
});
