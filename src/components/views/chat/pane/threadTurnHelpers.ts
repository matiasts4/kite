import type { ExtendedChatThread } from '../types';

export function composeRewoundPrompt(draft: string, rewound: string): string {
  if (!draft.trim()) return rewound;
  if (draft.trim() === rewound.trim()) return rewound;
  return `${draft.replace(/\s+$/, '')}\n\n${rewound}`;
}

const FILE_CHANGE_TOOL_KINDS = new Set(['fileChange', 'edit', 'delete', 'move']);

function countUnifiedDiffLines(text?: string | null): { added: number; deleted: number } | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let sawHeader = false;
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (
      line.startsWith('@@') ||
      line.startsWith('diff --git') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      sawHeader = true;
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      deleted += 1;
    }
  }
  if (!sawHeader || (added === 0 && deleted === 0)) {
    return null;
  }
  return { added, deleted };
}

function normalizeTurnFileKey(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\\\\\?\\/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function changedFilesForTurn(items: ExtendedChatThread['items']) {
  let start = 0;
  items.forEach((item, index) => {
    if (item.kind === 'user') start = index + 1;
  });
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  for (const item of items.slice(start)) {
    if (!item.filePath) continue;
    const isFileTool =
      (item.toolKind && FILE_CHANGE_TOOL_KINDS.has(item.toolKind)) ||
      item.addedLines != null ||
      item.removedLines != null;
    if (!isFileTool) continue;
    const key = normalizeTurnFileKey(item.filePath);
    const fallback =
      item.addedLines == null && item.removedLines == null
        ? countUnifiedDiffLines(item.text)
        : null;
    const added = item.addedLines ?? fallback?.added ?? 0;
    const deleted = item.removedLines ?? fallback?.deleted ?? 0;
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
