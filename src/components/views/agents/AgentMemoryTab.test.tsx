import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentMemoryTab, normalizeMemoryKey } from './AgentMemoryTab';
import type { AgentMindSnapshot } from './types';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../../lib/ipc', () => ({
  loadAgentMind: vi.fn(),
  writeAgentMemory: vi.fn(),
}));

describe('AgentMemoryTab (T3 Knowledge Packs & Smart Memory)', () => {
  const sampleMind: AgentMindSnapshot = {
    schemaVersion: 1,
    agentId: 'a1111111-1111-4111-8111-111111111111',
    memory: [
      'Keep Tauri commands snake_case across the backend.',
      'Use Vitest for frontend unit verification.',
    ].join('\n§\n'),
    user: 'Short replies preferred.',
    skills: [],
    memoryUpdatedAtUnixMs: Date.now() - 20 * 24 * 60 * 60 * 1000,
    userUpdatedAtUnixMs: Date.now(),
    memoryRevision: 'rev-1',
    userRevision: 'rev-u',
    memoryMeta: {
      [normalizeMemoryKey('Keep Tauri commands snake_case across the backend.')]: {
        pinned: true,
        archived: false,
        lastVerifiedAtUnixMs: Date.now(),
      },
    },
    readIssues: [],
  };

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('filters memory notes, flags stale/pinned badges, and warns on near-duplicates', async () => {
    render(<AgentMemoryTab agentName="Architect" mind={sampleMind} />);

    expect(screen.getByText('Keep Tauri commands snake_case across the backend.')).toBeInTheDocument();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();

    const filterInput = screen.getByLabelText('Filter memory notes');
    fireEvent.change(filterInput, { target: { value: 'Vitest' } });
    expect(screen.queryByText('Keep Tauri commands snake_case across the backend.')).toBeNull();
    expect(screen.getByText('Use Vitest for frontend unit verification.')).toBeInTheDocument();

    const composer = screen.getByLabelText('Add a memory note');
    fireEvent.change(composer, {
      target: { value: 'Use Vitest for frontend unit verification!' },
    });
    expect(screen.getByText(/Possible duplicate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add anyway' })).toBeInTheDocument();
  });

  it('attaches and searches Knowledge Packs via Tauri commands', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_knowledge_packs') {
        return {
          agentId: sampleMind.agentId,
          packs: [],
          entries: [],
          totalChunks: 0,
          manifestPreview: '',
        };
      }
      if (cmd === 'save_agent_knowledge_pack') {
        return {
          agentId: sampleMind.agentId,
          packs: [
            {
              id: 'kp-1',
              name: 'ODD Specs',
              root: 'C:\\repo\\odd',
              globs: ['tasks/*.md'],
              enabled: true,
              createdAtUnixMs: Date.now(),
            },
          ],
          entries: [
            {
              packId: 'kp-1',
              name: 'ODD Specs',
              root: 'C:\\repo\\odd',
              globs: ['tasks/*.md'],
              indexedAtUnixMs: Date.now(),
              fileCount: 3,
              chunkCount: 12,
            },
          ],
          totalChunks: 12,
          manifestPreview: '## Knowledge Packs\n- ODD Specs',
        };
      }
      if (cmd === 'search_agent_knowledge_packs') {
        return {
          query: 'Playbooks',
          matches: [
            {
              packId: 'kp-1',
              packName: 'ODD Specs',
              path: 'C:/repo/odd/tasks/spec.md',
              heading: 'S5 Playbooks',
              lineStart: 88,
              lineEnd: 94,
              preview: 'Execute Playbooks on top of Kite Swarm with SharedContextStore.',
              score: 5,
            },
          ],
          totalChars: 63,
        };
      }
      return null;
    });

    render(<AgentMemoryTab agentName="Architect" mind={sampleMind} />);
    fireEvent.click(screen.getByRole('tab', { name: /Knowledge Packs/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_agent_knowledge_packs', {
        request: { agentId: sampleMind.agentId },
      });
    });

    fireEvent.change(screen.getByPlaceholderText('Architecture & ODDs'), {
      target: { value: 'ODD Specs' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:\\repo\\docs'), {
      target: { value: 'C:\\repo\\odd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach Knowledge Pack' }));

    await waitFor(() => {
      expect(screen.getByText('ODD Specs')).toBeInTheDocument();
      expect(screen.getByText(/3 files \/ 12 chunks/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Test Knowledge Pack search'), {
      target: { value: 'Playbooks' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search Packs' }));

    await waitFor(() => {
      expect(screen.getByText('S5 Playbooks')).toBeInTheDocument();
      expect(screen.getByText(/SharedContextStore/i)).toBeInTheDocument();
    });
  });
});
