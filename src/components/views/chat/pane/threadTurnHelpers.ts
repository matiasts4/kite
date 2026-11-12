import type { ExtendedChatThread } from '../types';

export function composeRewoundPrompt(draft: string, rewound: string): string {
  if (!draft.trim()) return rewound;
  if (draft.trim() === rewound.trim()) return rewound;
  return `${draft.replace(/\s+$/, '')}\n\n${rewound}`;
}

export function changedFilesForTurn(items: ExtendedChatThread['items']) {
  let start = 0;
  items.forEach((item, index) => {
    if (item.kind === 'user') start = index + 1;
  });
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  for (const item of items.slice(start)) {
    if (!item.filePath) continue;
    if (item.toolKind !== 'fileChange' && item.addedLines == null && item.removedLines == null) continue;
    const key = item.filePath.replace(/\\/g, '/');
    const added = item.addedLines ?? 0;
    const deleted = item.removedLines ?? 0;
    const existing = files.get(key);
    if (existing) {
      existing.additions += added;
      existing.deletions += deleted;
    } else {
      files.set(key, {
        path: item.filePath,
        additions: added,
        deletions: deleted,
      });
    }
  }
  return [...files.values()];
}
