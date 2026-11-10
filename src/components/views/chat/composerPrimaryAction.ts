export type PrimaryAction = 'send' | 'interrupt' | 'queue' | 'steer' | 'resume';

export function resolvePrimaryAction(input: {
  running: boolean;
  draftEmpty: boolean;
  paused: boolean;
  steerSupported: boolean;
  defaultFollowUp: 'queue' | 'steer';
  flip: boolean;
}): PrimaryAction {
  if (input.running && input.draftEmpty) return 'interrupt';
  if (input.running && !input.draftEmpty) {
    const preferred = input.steerSupported ? input.defaultFollowUp : 'queue';
    const opposite = preferred === 'queue' ? 'steer' : 'queue';
    const flipped = input.flip ? opposite : preferred;
    return flipped === 'steer' && input.steerSupported ? 'steer' : 'queue';
  }
  if (!input.running && input.paused && input.draftEmpty) return 'resume';
  return 'send';
}

export function queueVisibleRows<T>(rows: T[], expanded: boolean, limit = 3): { visible: T[]; hidden: number } {
  if (expanded || rows.length <= limit) return { visible: rows, hidden: 0 };
  return { visible: rows.slice(0, limit), hidden: rows.length - limit };
}
