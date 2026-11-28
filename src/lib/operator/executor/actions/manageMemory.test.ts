import { describe, it, expect, beforeEach } from 'vitest';
import { executePlan } from '../index';
import { loadArgosMemoryNotes, saveArgosMemoryNotes } from '../../operatorConfig';
import { resetEpisodicMemoryCacheForTests } from '../../context/episodicMemory';

describe('S6 / T4 — Explicit Memory & Knowledge Control (manage_memory)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetEpisodicMemoryCacheForTests();
  });

  it('remembers workspace-scoped notes non-destructively and deduplicates near-identical entries', async () => {
    saveArgosMemoryNotes([
      {
        id: 'mem-other',
        content: 'Nota de otro workspace sobre deploy',
        createdAt: '2026-11-24T00:00:00Z',
        workspace: 'ws-other',
      },
    ]);

    const first = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_memory',
            operation: 'remember',
            text: 'En este proyecto los commits van separados por ODD',
            scope: 'workspace',
          },
        ],
      },
      { workspaceId: 'ws-kite' }
    );
    expect(first.overallSuccess).toBe(true);
    expect(first.receipts[0].spokenSummaryEs).toContain('Guardé');

    // Duplicate remember in same workspace should deduplicate
    const dup = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_memory',
            operation: 'remember',
            text: 'En este proyecto, los commits van separados por ODD!',
            scope: 'workspace',
          },
        ],
      },
      { workspaceId: 'ws-kite' }
    );
    expect(dup.overallSuccess).toBe(true);
    expect((dup.receipts[0].data as any).deduplicated).toBe(true);

    const all = loadArgosMemoryNotes();
    expect(all).toHaveLength(2);
    expect(all.some((n) => n.workspace === 'ws-other')).toBe(true);
    expect(all.some((n) => n.workspace === 'ws-kite')).toBe(true);
  });

  it('searches workspace notes while isolating other workspaces and forgets matching notes cleanly', async () => {
    saveArgosMemoryNotes([
      {
        id: 'mem-1',
        content: 'En este proyecto los commits van separados por ODD',
        createdAt: '2026-11-24T00:00:00Z',
        workspace: 'ws-kite',
      },
      {
        id: 'mem-2',
        content: 'Usar Conventional Commits sin trailer',
        createdAt: '2026-11-24T00:00:00Z',
        workspace: undefined,
      },
      {
        id: 'mem-3',
        content: 'Secreta de otro proyecto sobre commits',
        createdAt: '2026-11-24T00:00:00Z',
        workspace: 'ws-other',
      },
    ]);

    const searchRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_memory',
            operation: 'search',
            query: 'commits',
            scope: 'workspace',
          },
        ],
      },
      { workspaceId: 'ws-kite' }
    );
    expect(searchRes.overallSuccess).toBe(true);
    const notes = (searchRes.receipts[0].data as any).notes;
    expect(notes).toHaveLength(2);
    expect(notes.some((n: any) => n.id === 'mem-3')).toBe(false);

    const forgetRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_memory',
            operation: 'forget',
            query: 'ODD',
            scope: 'workspace',
          },
        ],
      },
      { workspaceId: 'ws-kite' }
    );
    expect(forgetRes.overallSuccess).toBe(true);
    expect((forgetRes.receipts[0].data as any).removedCount).toBe(1);
    const remaining = loadArgosMemoryNotes();
    expect(remaining.map((n) => n.id)).toEqual(['mem-2', 'mem-3']);
  });
});
