// Kite Code — Structured ReAct Observation Envelope (`<= 450` tokens per hop)
// Formats `peek_*` and `read_finding` receipts deterministically while preserving
// file paths, diff hunks, symbol matches, summary bullets, and `<<ccr:HASH>>` pointers.

import type { ActionReceipt } from '../contract';
import { ctxClient } from './ctxClient';

export const REACT_OBSERVATION_MAX_TOKENS = 450;
const APPROX_CHARS_PER_TOKEN = 4;

export interface ReactObservationEnvelope {
  type: string;
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  ccrHash?: string;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function compactToBudget(text: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = (text || '').trim();
  if (clean.length <= maxChars) {
    return { text: clean, truncated: false };
  }
  const headBudget = Math.max(80, Math.floor(maxChars * 0.7));
  const tailBudget = Math.max(40, Math.floor(maxChars * 0.25));
  const head = clean.slice(0, headBudget).trimEnd();
  const tail = clean.slice(clean.length - tailBudget).trimStart();
  return {
    text: `${head}\n… [compactado]\n${tail}`.slice(0, maxChars),
    truncated: true,
  };
}

function formatCcrPointer(rawHash: unknown): string | null {
  if (typeof rawHash !== 'string' || !rawHash.trim()) return null;
  const clean = rawHash.trim().replace(/^<<ccr:/i, '').replace(/>>$/, '');
  return clean ? `<<ccr:${clean}>>` : null;
}

function appendStructuredDataSections(
  lines: string[],
  type: string,
  data: Record<string, unknown>
): string | undefined {
  let detectedHash: string | undefined;
  const ccrPointer = formatCcrPointer(data.ccrHash ?? data.hash);
  if (ccrPointer) {
    detectedHash = ccrPointer.slice(6, -2);
  }

  if (type === 'peek_changes' || type === 'read_diff') {
    if (typeof data.branch === 'string' && data.branch) {
      lines.push(`Rama: ${data.branch}`);
    }
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length > 0) {
      const fileLines = files
        .slice(0, 12)
        .map((f: any) => `- ${f.path} (${f.status || 'modified'}${f.staged ? ', staged' : ''})`);
      lines.push(`Archivos:\n${fileLines.join('\n')}`);
    }
    const diffs = Array.isArray(data.diffs) ? data.diffs : [];
    for (const diff of diffs.slice(0, 3)) {
      const d = diff as Record<string, unknown>;
      const added = typeof d.added === 'number' ? d.added : 0;
      const removed = typeof d.removed === 'number' ? d.removed : 0;
      const hunks = Array.isArray(d.hunks) ? d.hunks.slice(0, 4).join(' | ') : '';
      const header = `Diffs (${String(d.path || '')}, +${added}/-${removed})${hunks ? ` ${hunks}` : ''}:`;
      const preview = typeof d.preview === 'string' ? d.preview.trim() : '';
      lines.push(preview ? `${header}\n${preview}` : header);
    }
    if (typeof data.preview === 'string' && data.preview.trim() && diffs.length === 0) {
      lines.push(`Diffs:\n${data.preview.trim()}`);
    }
  } else if (type === 'peek_files') {
    if (typeof data.path === 'string') {
      lines.push(`Archivo: ${data.path} (modo: ${String(data.mode || 'signatures')})`);
    }
    if (typeof data.content === 'string' && data.content.trim()) {
      lines.push(`Contenido:\n${data.content.trim()}`);
    }
  } else if (type === 'peek_search') {
    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (matches.length > 0) {
      const formatted = matches
        .slice(0, 12)
        .map((m: any) => {
          const loc = m.line ? `${m.path}:${m.line}` : String(m.path || '');
          const snip = typeof m.snippet === 'string' ? m.snippet.trim().slice(0, 140) : '';
          return `- ${loc}${snip ? ` → ${snip}` : ''}`;
        })
        .join('\n');
      lines.push(`Coincidencias:\n${formatted}`);
    }
  } else if (type === 'read_finding') {
    if (typeof data.source === 'string' && data.source) {
      lines.push(`Origen: ${data.source}`);
    }
    if (typeof data.content === 'string' && data.content.trim()) {
      lines.push(`Contenido:\n${data.content.trim()}`);
    }
  } else if (type === 'peek_agents') {
    const subagents = Array.isArray(data.subagents) ? data.subagents : [];
    if (subagents.length > 0) {
      lines.push(
        `Subagentes:\n${subagents
          .slice(0, 8)
          .map((s: any) => `- ${s.role || s.id} [${s.status || 'unknown'}]${s.provider ? ` (${s.provider})` : ''}`)
          .join('\n')}`
      );
    }
    const autonomous = Array.isArray(data.autonomousAgents) ? data.autonomousAgents : [];
    if (autonomous.length > 0) {
      lines.push(
        `Agentes:\n${autonomous
          .slice(0, 8)
          .map((a: any) => `- ${a.name || a.id} [${a.status || 'idle'}]`)
          .join('\n')}`
      );
    }
    const routines = Array.isArray(data.routines) ? data.routines : [];
    if (routines.length > 0) {
      lines.push(
        `Rutinas:\n${routines
          .slice(0, 6)
          .map((r: any) => `- ${r.name || r.id} (${r.enabled ? 'activa' : 'pausada'})`)
          .join('\n')}`
      );
    }
    if (typeof data.swarmTitle === 'string' && data.swarmTitle) {
      lines.push(`Swarm: ${data.swarmTitle}`);
    }
  } else if (type === 'peek_runs') {
    const runs = Array.isArray(data.runs) ? data.runs : [];
    if (runs.length > 0) {
      lines.push(
        `Ejecuciones:\n${runs
          .slice(0, 8)
          .map((r: any) => `- ${r.turnId || 'run'}: ${r.outcome || 'running'}`)
          .join('\n')}`
      );
    }
  } else if (type === 'recall_conversations') {
    if (typeof data.text === 'string' && data.text.trim()) {
      lines.push(`Contenido:\n${data.text.trim()}`);
    } else if (Array.isArray(data.entries) && data.entries.length > 0) {
      lines.push(
        `Conversaciones:\n${data.entries
          .slice(0, 6)
          .map((e: any) => `- ${e.title || e.id} (${e.cli || 'chat'})`)
          .join('\n')}`
      );
    }
  } else {
    const fallbackJson = JSON.stringify(data);
    if (fallbackJson && fallbackJson !== '{}') {
      lines.push(`Datos: ${fallbackJson}`);
    }
  }

  if (ccrPointer) {
    lines.push(`Referencia: ${ccrPointer}`);
  }

  return detectedHash;
}

/**
 * Formats a single ReAct observation receipt into a bounded (`<= 450` tokens) structured envelope.
 */
export function formatReactObservation(
  receipt: ActionReceipt,
  maxTokens: number = REACT_OBSERVATION_MAX_TOKENS
): ReactObservationEnvelope {
  const safeMaxTokens = Math.max(60, Math.min(REACT_OBSERVATION_MAX_TOKENS, maxTokens));
  const maxChars = safeMaxTokens * APPROX_CHARS_PER_TOKEN;
  const lines: string[] = [`[Observación ${receipt.type}]`, `Resumen: ${receipt.summaryEs}`];

  let ccrHash: string | undefined;
  if (receipt.data && typeof receipt.data === 'object' && !Array.isArray(receipt.data)) {
    ccrHash = appendStructuredDataSections(
      lines,
      receipt.type,
      receipt.data as Record<string, unknown>
    );
  } else if (receipt.data !== undefined) {
    lines.push(`Datos: ${String(receipt.data)}`);
  }

  const rawText = lines.join('\n');
  let compacted = compactToBudget(rawText, maxChars);

  // Ensure <<ccr:HASH>> pointer survives compaction when present
  const ccrTag = ccrHash ? `<<ccr:${ccrHash}>>` : null;
  if (ccrTag && compacted.truncated && !compacted.text.includes(ccrTag)) {
    const suffix = `\nReferencia: ${ccrTag}`;
    const trimmed = compacted.text.slice(0, Math.max(40, maxChars - suffix.length)).trimEnd();
    compacted = { text: `${trimmed}${suffix}`, truncated: true };
  }

  return {
    type: receipt.type,
    text: compacted.text,
    estimatedTokens: estimateTokens(compacted.text),
    truncated: compacted.truncated,
    ...(ccrHash ? { ccrHash } : {}),
  };
}

/**
 * Formats a batch of ReAct hop receipts into a combined prompt observation block.
 */
export function formatReactObservationBatch(
  receipts: ActionReceipt[],
  maxTokensPerHop: number = REACT_OBSERVATION_MAX_TOKENS
): string {
  if (!receipts || receipts.length === 0) return '';
  const perHop =
    receipts.length > 1
      ? Math.max(120, Math.floor(maxTokensPerHop / Math.min(receipts.length, 3)))
      : maxTokensPerHop;
  return receipts.map((r) => formatReactObservation(r, perHop).text).join('\n\n');
}

/**
 * Async variant that leverages `ctxClient.packVoiceContext` when Tauri `kite-ctx` is active,
 * falling back to deterministic local compaction.
 */
export async function formatReactObservationWithCtx(
  receipt: ActionReceipt,
  maxTokens: number = REACT_OBSERVATION_MAX_TOKENS
): Promise<ReactObservationEnvelope> {
  const syncEnv = formatReactObservation(receipt, maxTokens);
  if (!syncEnv.truncated) {
    return syncEnv;
  }
  try {
    const packed = await ctxClient.packVoiceContext({
      workingContextSummary: syncEnv.text,
      maxTokens,
    });
    if (packed.packedText && packed.estimatedTokens <= maxTokens) {
      return {
        type: receipt.type,
        text: packed.packedText,
        estimatedTokens: packed.estimatedTokens,
        truncated: true,
        ...(syncEnv.ccrHash ? { ccrHash: syncEnv.ccrHash } : {}),
      };
    }
  } catch {
    // Keep deterministic sync envelope
  }
  return syncEnv;
}
