import { describe, it, expect } from 'vitest';
import type { NotificationRecord } from '../../types';
import {
  resolveNotificationModule,
  getNotificationActor,
  getNotificationDetail,
  getNotificationToastContent,
  getOsNotificationContent,
} from './presentation';

function makeRecord(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'n-1',
    createdAtUnixMs: 1_700_000_000_000,
    isRead: false,
    ...overrides,
  };
}

describe('notifications/presentation', () => {
  it('resolves notification module from explicit module, target source, or profileId', () => {
    expect(resolveNotificationModule(makeRecord({ module: 'code', target: { source: 'agentChat', id: 't1' } }))).toBe(
      'code'
    );
    expect(resolveNotificationModule(makeRecord({ target: { source: 'agentChat', id: 't1' } }))).toBe('agent');
    expect(resolveNotificationModule(makeRecord({ target: { source: 'codeThread', id: 't1' } }))).toBe('chat');
    expect(resolveNotificationModule(makeRecord({ target: { source: 'terminal', id: 's1' } }))).toBe('code');
    expect(resolveNotificationModule(makeRecord({ target: { source: 'codeTerminal', id: 's1' } }))).toBe('code');
    expect(
      resolveNotificationModule(makeRecord({ target: { source: 'accountVault', id: 'agy' }, profileId: 'agent-1' }))
    ).toBeNull();
    expect(resolveNotificationModule(makeRecord({ profileId: 'agent-1' }))).toBe('agent');
    expect(resolveNotificationModule(makeRecord({ target: { source: 'task', id: 'task-1' } }))).toBeNull();
  });

  it('resolves characteristic actor names in priority order and ignores generic thread titles', () => {
    const lookups = {
      agents: [{ id: 'a1', name: 'Chip Worker' }],
      threads: [
        { id: 't1', title: 'Refactor auth' },
        { id: 't2', title: 'New thread' },
      ],
    };

    expect(
      getNotificationActor(
        makeRecord({
          actorName: 'Explicit Actor',
          profileId: 'a1',
          target: { source: 'agentChat', id: 't1' },
          title: 'Fallback Title',
        }),
        lookups
      )
    ).toBe('Explicit Actor');

    expect(
      getNotificationActor(
        makeRecord({
          profileId: 'a1',
          target: { source: 'agentChat', id: 't1' },
        }),
        lookups
      )
    ).toBe('Chip Worker');

    expect(
      getNotificationActor(
        makeRecord({
          target: { source: 'codeThread', id: 't1' },
          threadTitle: 'Untitled',
        }),
        lookups
      )
    ).toBe('Refactor auth');

    expect(
      getNotificationActor(
        makeRecord({
          target: { source: 'codeThread', id: 't2' },
          threadTitle: 'New chat',
        }),
        lookups
      )
    ).toBe('Code thread');

    expect(
      getNotificationActor(
        makeRecord({
          target: { source: 'terminal', id: 's1' },
          actorName: 'Orion · Codex',
        })
      )
    ).toBe('Orion · Codex');

    expect(
      getNotificationActor(
        makeRecord({
          kind: { kind: 'autoSwitchConfirm', requestKind: 'model_mismatch' },
          title: 'Model confirmation required',
        })
      )
    ).toBe('Model confirmation required');

    expect(
      getNotificationActor(
        makeRecord({
          kind: { kind: 'modelQuotaExhausted', requestKind: 'antigravity' },
          title: 'Cuota agotada: Gemini 4 Argon',
        })
      )
    ).toBe('Cuota agotada: Gemini 4 Argon');
  });

  it('formats notification detail cleanly across settled, needsInput, and legacy codeThread records', () => {
    const lookups = {
      agents: [{ id: 'a1', name: 'Chip Worker' }],
      threads: [{ id: 't1', title: 'Fix billing race' }],
    };

    expect(
      getNotificationDetail(
        makeRecord({
          profileId: 'a1',
          threadTitle: 'Fix billing race',
          target: { source: 'agentChat', id: 't1' },
          kind: { kind: 'settled', outcome: 'completed' },
        }),
        lookups
      )
    ).toBe('Finished · Fix billing race');

    expect(
      getNotificationDetail(
        makeRecord({
          profileId: 'a1',
          threadTitle: 'Fix billing race',
          target: { source: 'agentChat', id: 't1' },
          kind: { kind: 'settled', outcome: 'failed' },
        }),
        lookups
      )
    ).toBe('Needs attention · Fix billing race');

    expect(
      getNotificationDetail(
        makeRecord({
          actorName: 'Orion · Codex',
          body: 'All 12 tests passed',
          target: { source: 'terminal', id: 's1' },
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toBe('All 12 tests passed');

    expect(
      getNotificationDetail(
        makeRecord({
          target: { source: 'codeThread', id: 't1' },
          threadTitle: 'Refactor auth',
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toBe('finished');

    expect(
      getNotificationDetail(
        makeRecord({
          target: { source: 'codeThread', id: 'legacy-1' },
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toBe('Code thread closed');

    expect(
      getNotificationDetail(
        makeRecord({
          profileId: 'a1',
          threadTitle: 'Fix billing race',
          target: { source: 'agentChat', id: 't1' },
          kind: { kind: 'needsInput', requestKind: 'toolApproval' },
          isWaitingForInput: true,
        }),
        lookups
      )
    ).toBe('Waiting for your approval · Fix billing race');
  });

  it('formats characteristic and legacy toast content plus concise OS toast payloads', () => {
    const lookups = {
      agents: [{ id: 'a1', name: 'Chip Worker' }],
      threads: [{ id: 't1', title: 'Refactor auth' }],
    };

    expect(
      getNotificationToastContent(
        makeRecord({
          profileId: 'a1',
          threadTitle: 'Refactor auth',
          target: { source: 'agentChat', id: 't1' },
          kind: { kind: 'settled', outcome: 'completed' },
        }),
        lookups
      )
    ).toEqual({
      title: 'Chip Worker finished',
      description: 'Refactor auth',
      isError: false,
    });

    expect(
      getNotificationToastContent(
        makeRecord({
          target: { source: 'codeThread', id: 't1' },
          threadTitle: 'Refactor auth',
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toEqual({
      title: 'Refactor auth finished',
      description: undefined,
      isError: false,
    });

    expect(
      getNotificationToastContent(
        makeRecord({
          actorName: 'Orion · Codex',
          body: 'Updated API routes',
          target: { source: 'terminal', id: 's1' },
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toEqual({
      title: 'Orion · Codex finished',
      description: 'Updated API routes',
      isError: false,
    });

    expect(
      getNotificationToastContent(
        makeRecord({
          actorName: 'Chip Worker',
          target: { source: 'agentChat', id: 't1' },
          kind: { kind: 'settled', outcome: 'failed' },
        })
      )
    ).toEqual({
      title: 'Chip Worker needs attention',
      description: 'Stopped with errors.',
      isError: true,
    });

    // Legacy fallback format preserved
    expect(
      getNotificationToastContent(
        makeRecord({
          target: { source: 'agentChat', id: 'chat-1' },
          profileId: 'unknown-agent',
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toEqual({
      title: 'Agent chat: Completed',
      description: 'Execution completed successfully.',
      isError: false,
    });

    expect(
      getOsNotificationContent(
        makeRecord({
          actorName: 'Orion · Codex',
          target: { source: 'terminal', id: 's1' },
          kind: { kind: 'settled', outcome: 'completed' },
        })
      )
    ).toEqual({
      title: 'Orion · Codex finished',
      body: 'Ready for you in Kite.',
    });
  });

  it('keeps approval toast titles concise for long thread titles and moves thread context to description', () => {
    const longThreadTitle =
      'Quiero que verifiques y corrijas este error que estoy teniendo al momento de lanzar agentes';

    expect(
      getNotificationToastContent(
        makeRecord({
          target: { source: 'codeThread', id: 't-long' },
          threadTitle: longThreadTitle,
          body: 'Allow running cargo test?',
          kind: { kind: 'needsInput', requestKind: 'toolApproval' },
          isWaitingForInput: true,
        })
      )
    ).toEqual({
      title: 'Approval needed',
      description: `${longThreadTitle} · Allow running cargo test?`,
      isError: false,
    });

    expect(
      getNotificationToastContent(
        makeRecord({
          target: { source: 'codeThread', id: 't-long' },
          threadTitle: longThreadTitle,
          kind: { kind: 'needsInput', requestKind: 'toolApproval' },
          isWaitingForInput: true,
        })
      )
    ).toEqual({
      title: 'Approval needed',
      description: longThreadTitle,
      isError: false,
    });

    const longSettled = getNotificationToastContent(
      makeRecord({
        target: { source: 'codeThread', id: 't-long' },
        threadTitle: longThreadTitle,
        kind: { kind: 'settled', outcome: 'completed' },
      })
    );
    expect(longSettled.title.length).toBeLessThanOrEqual(40);
    expect(longSettled.description).toBe(longThreadTitle);
  });
});
