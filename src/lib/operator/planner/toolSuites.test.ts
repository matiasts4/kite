import { describe, expect, it } from 'vitest';
import { OPERATOR_NATIVE_TOOLS } from '../contract';
import {
  classifyIntentSuites,
  filterToolsBySuites,
  TOOL_SUITE_DEFINITIONS,
} from './toolSuites';

describe('toolSuites — Dynamic Intent Tool Pruning (S2/T2)', () => {
  it('defines the 6 intent suites and keeps conversational suite <= 2 tools', () => {
    expect(Object.keys(TOOL_SUITE_DEFINITIONS)).toEqual([
      'conversational',
      'inspect',
      'orchestration',
      'terminals',
      'tasks_routines',
      'workspace_ops',
    ]);
    const convTools = filterToolsBySuites(['conversational']);
    expect(convTools.length).toBeLessThanOrEqual(2);
    expect(convTools.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['stay_silent', 'stop_speaking'])
    );
  });

  it('prunes conversational turns to 0-2 tools instead of full 22+ catalog', () => {
    const res = classifyIntentSuites('hola, ¿cómo viene el proyecto hoy?');
    expect(res.isConversational).toBe(true);
    expect(res.suites).toEqual(['conversational']);
    expect(res.tools.length).toBeLessThanOrEqual(2);
    expect(res.tools.length).toBeLessThan(OPERATOR_NATIVE_TOOLS.length);
  });

  it('selects inspect tools for read-only code/diff/history questions', () => {
    const res = classifyIntentSuites('revisa qué archivos cambiaron en git y los últimos runs');
    expect(res.suites).toContain('inspect');
    const names = res.tools.map((t) => t.function.name);
    expect(names).toContain('peek_changes');
    expect(names).toContain('peek_files');
    expect(names).not.toContain('open_terminals');
  });

  it('selects orchestration suite for subagent, thread, and proposal turns', () => {
    const res = classifyIntentSuites('lanza un subagente con claude para auditar auth');
    expect(res.suites).toContain('orchestration');
    const names = res.tools.map((t) => t.function.name);
    expect(names).toContain('spawn_subagent');
    expect(names).toContain('propose_task');
    expect(names).toContain('confirm_proposal');
  });

  it('selects terminals suite for terminal and pane layout commands', () => {
    const res = classifyIntentSuites('abre dos terminales e iguala los paneles');
    expect(res.suites).toContain('terminals');
    const names = res.tools.map((t) => t.function.name);
    expect(names).toContain('open_terminals');
    expect(names).toContain('manage_pane_layout');
  });

  it('dynamically filters against OPERATOR_NATIVE_TOOLS without failing on optional future tools', () => {
    const customCatalog = [
      ...OPERATOR_NATIVE_TOOLS,
      {
        type: 'function',
        function: {
          name: 'manage_tasks',
          description: 'Manage Kite Tasks',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const res = classifyIntentSuites('crea una tarea en tasks para revisar voice mode', undefined, customCatalog);
    expect(res.suites).toContain('tasks_routines');
    expect(res.tools.map((t) => t.function.name)).toContain('manage_tasks');
  });
});
