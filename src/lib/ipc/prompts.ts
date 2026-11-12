import { invokeCommand } from './core';

export interface PromptSummary {
  id: string;
  title: string;
  content: string;
  createdAtUnixMs?: number;
}

export interface PromptItem {
  id: string;
  title: string;
  prompt: string;
  category?: string;
  description?: string;
  content?: string;
  createdAtUnixMs?: number;
}

export async function listPrompts(): Promise<PromptItem[]> {
  return invokeCommand<PromptItem[]>('list_prompts');
}

export async function searchTranscripts(query: string): Promise<{ ok: boolean; matches?: unknown[] }> {
  return invokeCommand<{ ok: boolean; matches?: unknown[] }>('search_transcripts', { query });
}

export async function saveShellState(state: Record<string, unknown>): Promise<{ saved: boolean }> {
  return invokeCommand<{ saved: boolean }>('save_shell_state', { state });
}
