import { describe, expect, it } from 'vitest';
import { processAgentInboxRequest } from './agentInboxLoop';

describe('processAgentInboxRequest', () => {
  it('does not open a pane for a spawn or inject request', async () => {
    const spawn = await processAgentInboxRequest({
      id: 'r1',
      op: 'spawn',
      cwd: 'E:/kite',
      taskPath: 'secret.md',
      engine: 'codex',
    });
    expect(spawn.ok).toBe(true);
    expect(spawn.message).toContain('kite dispatch');
    expect(spawn.sessionId).toBeUndefined();

    const inject = await processAgentInboxRequest({
      id: 'r2',
      op: 'inject',
      cwd: 'E:/kite',
      taskPath: 'secret.md',
      target: 'review',
    });
    expect(inject.ok).toBe(true);
    expect(inject.message).toContain('kite dispatch');
    expect(inject.sessionId).toBeUndefined();
  });
});
