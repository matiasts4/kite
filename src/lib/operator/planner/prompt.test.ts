import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadZedMemoryNotes, saveZedMemoryNotes, type ZedMemoryNote } from '../operatorConfig';
import { buildOperatorSystemPrompt } from './prompt';

/** Stable notes heading. Chat index text must not reuse this line. */
const NOTES_HEADING = 'NOTAS DE MEMORIA DEL ASISTENTE:';
const OTHER_CHAT_TRANSCRIPT =
  'CUERPO-DE-TRANSCRIPCION-ajena-9f3c: el otro chat decidió reescribir el índice completo.';

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

function dumpStorage(store: Map<string, string>): string {
  return JSON.stringify([...store.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

describe('buildOperatorSystemPrompt local notes', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes existing local notes in the live planner prompt and omits another chat transcript', () => {
    const notes: ZedMemoryNote[] = [
      {
        id: 'mem-powershell',
        content: 'El usuario prefiere terminales de PowerShell salvo que pida un agente.',
        createdAt: '2026-03-01T12:00:00.000Z',
        workspace: 'kite',
      },
      {
        id: 'mem-short',
        content: 'Las confirmaciones del asistente deben ser cortas.',
        createdAt: '2026-03-02T09:15:00.000Z',
      },
    ];
    saveZedMemoryNotes(notes);
    store.set('kite.chat.transcript.other', OTHER_CHAT_TRANSCRIPT);

    const prompt = buildOperatorSystemPrompt({
      workspaceName: 'kite',
      workspacePath: 'C:/kite',
      mode: 'code',
    });

    expect(prompt).toContain(NOTES_HEADING);
    const firstNote = prompt.indexOf(notes[0].content);
    const secondNote = prompt.indexOf(notes[1].content);
    expect(firstNote).toBeGreaterThanOrEqual(0);
    expect(secondNote).toBeGreaterThan(firstNote);
    expect(prompt).not.toContain(OTHER_CHAT_TRANSCRIPT);
    expect(prompt).not.toContain('CUERPO-DE-TRANSCRIPCION-ajena-9f3c');
  });

  it('omits the notes section when no notes are stored', () => {
    const prompt = buildOperatorSystemPrompt({
      workspaceName: 'kite',
      mode: 'code',
    });

    expect(prompt).not.toContain(NOTES_HEADING);
    expect(prompt).not.toContain('El usuario prefiere terminales de PowerShell');
  });

  it('leaves an existing note unchanged in storage after building the prompt', () => {
    const note: ZedMemoryNote = {
      id: 'mem-keep',
      content: 'No borrar esta nota al planificar.',
      createdAt: '2026-01-15T08:30:00.000Z',
      workspace: 'kite',
    };
    saveZedMemoryNotes([note]);
    store.set('kite.chat.transcript.other', OTHER_CHAT_TRANSCRIPT);
    const before = dumpStorage(store);

    buildOperatorSystemPrompt({ workspaceId: 'ws-1', mode: 'agents' });

    expect(dumpStorage(store)).toBe(before);
    expect(loadZedMemoryNotes()).toEqual([note]);
    expect(store.get('kite.chat.transcript.other')).toBe(OTHER_CHAT_TRANSCRIPT);
  });

  it('keeps the existing operator instructions and live terminal context', () => {
    const prompt = buildOperatorSystemPrompt({
      workspaceName: 'kite',
      workspacePath: 'C:/kite',
      mode: 'code',
      activeTerminals: [
        {
          sessionId: 'ses-1',
          title: 'shell',
          engine: 'powershell',
          state: 'activo',
        },
      ],
    });

    expect(prompt).toContain('Responde SIEMPRE con un ÚNICO objeto JSON válido.');
    expect(prompt).toContain('Proyecto actual: "kite"');
    expect(prompt).toContain('ID="ses-1"');
    expect(prompt).toContain('Motor=powershell');
    expect(prompt).toContain('launch_thread');
  });

  it('injects chatReach index and read context when provided', () => {
    const promptWithIndex = buildOperatorSystemPrompt(undefined, {
      kind: 'index',
      entries: [
        { id: 'chat-antigravity', title: 'Plan de Auth', cli: 'antigravity', lastDecision: 'Aprobado' },
      ],
      text: 'Plan de Auth (antigravity)',
    });
    expect(promptWithIndex).toContain('ÍNDICE DE CONVERSACIONES Y CHATS (CLIs / HILOS DISPONIBLES):');
    expect(promptWithIndex).toContain('Plan de Auth [Motor: antigravity, ID: chat-antigravity]: Aprobado');

    const promptWithRead = buildOperatorSystemPrompt(undefined, {
      kind: 'read',
      entry: { id: 'chat-antigravity', title: 'Plan de Auth', cli: 'antigravity' },
      body: 'Usuario: ¿Cómo va el backend?\nAsistente: Todo listo.',
      text: 'Plan de Auth\nUsuario: ¿Cómo va el backend?\nAsistente: Todo listo.',
    });
    expect(promptWithRead).toContain('CONTENIDO DE LA CONVERSACIÓN CONSULTADA (Plan de Auth - antigravity):');
    expect(promptWithRead).toContain('Usuario: ¿Cómo va el backend?');
  });
});
