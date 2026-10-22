import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyHandoffPlan,
  planHandoff,
  type HandoffContext,
} from './agentHandoff';

function makeLongBody(): string {
  const filler = 'x'.repeat(1800);
  return `${filler}\nRuta: E:\\kite\\src\\lib\\agentHandoff.ts\nCriterio de aceptación: entregar texto íntegro.\n`;
}

describe('agentHandoff', () => {
  let dispatchSpy: { mockRestore: () => void; mock: { calls: unknown[][] } };

  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  const baseCtx = (terminals: HandoffContext['terminals'], readTask: HandoffContext['readTask']): HandoffContext => ({
    terminals,
    readTask,
  });

  it('spawn delivers full body in ptyPrompt and null cliInitialPrompt', () => {
    const body = makeLongBody();
    const plan = planHandoff(
      {
        id: '1',
        op: 'spawn',
        engine: 'agy',
        taskPath: '.kite/tasks/foo.md',
        cwd: 'E:/kite',
      },
      baseCtx([], () => body)
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.op !== 'spawn') throw new Error('expected spawn plan');

    expect(plan.ptyPrompt).toBe(body.replace(/\s+$/, ''));
    expect(plan.cliInitialPrompt).toBe(null);
    expect(plan.spawnDetail.initialPrompt).toBe(plan.ptyPrompt);
    expect(plan.spawnDetail.engine).toBe('antigravity');

    applyHandoffPlan(plan);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const evt = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(evt.type).toBe('kite:spawn-agent-terminal');
  });

  it('rejects path with parent segments and does not emit', () => {
    const plan = planHandoff(
      {
        id: '2',
        op: 'spawn',
        engine: 'grok',
        taskPath: '../fuera.md',
        cwd: 'E:/kite',
      },
      baseCtx([], () => 'should-not-read')
    );
    expect(plan.ok).toBe(false);
    applyHandoffPlan(plan);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('rejects absolute path outside cwd', () => {
    const plan = planHandoff(
      {
        id: '3',
        op: 'spawn',
        engine: 'codex',
        taskPath: 'D:/otro/proyecto/task.md',
        cwd: 'E:/kite',
      },
      baseCtx([], () => 'x')
    );
    expect(plan.ok).toBe(false);
    applyHandoffPlan(plan);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('inject by agent who emits projectile with full body and sourceSessionId', () => {
    const body = 'Instrucción completa para Orion\n';
    const plan = planHandoff(
      {
        id: '4',
        op: 'inject',
        target: 'Orion',
        taskPath: '.kite/tasks/orion.md',
        cwd: 'E:/kite',
        sourceSessionId: 'parent-sess-99',
        sourcePaneId: 'pane-parent',
      },
      baseCtx(
        [
          {
            sessionId: 'child-sess',
            title: 'Orion (grok)',
            who: 'Orion',
            engine: 'grok',
            state: 'idle',
          },
        ],
        () => body
      )
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.op !== 'inject') throw new Error('expected inject');

    expect(plan.projectileDetail.prompt).toBe(body.trimEnd());
    expect(plan.projectileDetail.sourceSessionId).toBe('parent-sess-99');

    applyHandoffPlan(plan);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const evt = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(evt.type).toBe('kite:dispatch-prompt-projectile');
    expect((evt.detail as { prompt: string }).prompt).toBe(body.trimEnd());
  });

  it('missing inject target returns error and no event', () => {
    const plan = planHandoff(
      {
        id: '5',
        op: 'inject',
        target: 'NoExiste',
        taskBody: 'hola',
        cwd: 'E:/kite',
      },
      baseCtx([], () => '')
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('expected failure');
    expect(plan.error).toContain('No encontré');
    applyHandoffPlan(plan);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('agents lists terminals without emitting spawn or projectile', () => {
    const terminals = [
      {
        sessionId: 'a',
        title: 'A',
        who: 'A',
        engine: 'claude-code',
        state: 'working',
      },
    ];
    const plan = planHandoff({ id: '6', op: 'agents' }, baseCtx(terminals, () => ''));
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.op !== 'agents') throw new Error('expected agents');
    expect(plan.agents).toEqual(terminals);
    applyHandoffPlan(plan);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
