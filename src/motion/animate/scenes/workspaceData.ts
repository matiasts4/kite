export interface ThreadNode {
  id: string;
  title: string;
  detail: string;
  state: 'running' | 'idle' | 'done';
  children?: ThreadNode[];
}

export const THREADS: ThreadNode[] = [
  {
    id: 't1',
    title: 'Refactor del transcript',
    detail: 'hace 2 min',
    state: 'running',
    children: [
      { id: 't1a', title: 'Subagente · borde vivo', detail: '8 s', state: 'running' },
    ],
  },
  { id: 't2', title: 'Motion contract', detail: 'hace 18 min', state: 'idle' },
  {
    id: 't3',
    title: 'Preview Animate UI',
    detail: 'ayer',
    state: 'done',
    children: [
      { id: 't3a', title: 'Skills · install', detail: 'ayer', state: 'done' },
      { id: 't3b', title: 'Tokens · port', detail: 'ayer', state: 'done' },
    ],
  },
];

export const PROJECTS = ['kite-motion', 'agent-shell', 'motion-lab'];

export interface DiffRow {
  type: 'ctx' | 'add' | 'del';
  no: string;
  text: string;
}

export const DIFF_ROWS: DiffRow[] = [
  { type: 'ctx', no: '12', text: 'export const MOTION_ENTER_MS = 180;' },
  { type: 'del', no: '13', text: 'export const MOTION_EXIT_MS = 120;' },
  { type: 'add', no: '13', text: 'export const MOTION_EXIT_MS = 140;' },
  { type: 'ctx', no: '14', text: '' },
  { type: 'ctx', no: '15', text: 'export function prefersReducedMotion() {' },
  { type: 'del', no: '16', text: '  return false;' },
  { type: 'add', no: '16', text: "  return document.documentElement.dataset.motion === 'reduce';" },
  { type: 'ctx', no: '17', text: '}' },
];

export interface TerminalLine {
  id: string;
  tone: 'cmd' | 'out' | 'ok';
  text: string;
}

export const SEED_TERMINAL: TerminalLine[] = [
  { id: 'l1', tone: 'cmd', text: '$ npm run test -- motion' },
  { id: 'l2', tone: 'out', text: 'vitest run · 14 archivos' },
  { id: 'l3', tone: 'ok', text: '✓ 42 tests passed' },
];
