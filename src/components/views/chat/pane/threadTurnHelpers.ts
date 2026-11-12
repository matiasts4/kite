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
    files.set(item.filePath, {
      path: item.filePath,
      additions: item.addedLines ?? 0,
      deletions: item.removedLines ?? 0,
    });
  }
  return [...files.values()];
}
