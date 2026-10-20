// Kite Code — Operator Execution Audit Log
// Persistent diagnostic log for the Operator Assistant to audit commands, LLM provider output,
// planned actions, and per-action execution results.

import type { OperatorAction } from './operatorBrain';
import { emitTrace } from './trace/trace';

export interface OperatorActionAuditResult {
  actionType: string;
  description: string;
  status: 'success' | 'failed';
  error?: string;
  target?: string | number;
  data?: unknown;
}

export interface OperatorAuditEntry {
  id: string;
  timestamp: number;
  input: string;
  provider: string;
  model: string;
  latencyMs: number;
  usedFallbackLocal: boolean;
  reply: string;
  rawResponse?: string;
  error?: string;
  actionsPlanned: OperatorAction[];
  executionResults: OperatorActionAuditResult[];
  overallSuccess: boolean;
}

const OPERATOR_AUDIT_LOG_KEY = 'kite.operator.auditLog.v1';
const MAX_AUDIT_ENTRIES = 50;

/**
 * Retrieves the current operator audit log from localStorage.
 */
export function getOperatorAuditLog(): OperatorAuditEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OPERATOR_AUDIT_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[OperatorAudit] Error leyendo log de auditoría:', err);
    return [];
  }
}

/**
 * Appends a new execution record to the audit log and notifies listeners.
 */
export function recordOperatorAudit(
  entryData: Omit<OperatorAuditEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }
): OperatorAuditEntry {
  const entry: OperatorAuditEntry = {
    id: entryData.id || `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: entryData.timestamp || Date.now(),
    input: entryData.input,
    provider: entryData.provider,
    model: entryData.model,
    latencyMs: entryData.latencyMs,
    usedFallbackLocal: entryData.usedFallbackLocal,
    reply: entryData.reply,
    rawResponse: entryData.rawResponse,
    error: entryData.error,
    actionsPlanned: entryData.actionsPlanned,
    executionResults: entryData.executionResults,
    overallSuccess: entryData.overallSuccess,
  };

  if (typeof window !== 'undefined') {
    try {
      const current = getOperatorAuditLog();
      const updated = [entry, ...current].slice(0, MAX_AUDIT_ENTRIES);
      localStorage.setItem(OPERATOR_AUDIT_LOG_KEY, JSON.stringify(updated));

      window.dispatchEvent(
        new CustomEvent('kite:operator-audit-updated', {
          detail: { entry, log: updated },
        })
      );
    } catch (err) {
      console.warn('[OperatorAudit] Error guardando registro en localStorage:', err);
    }
  }

  // Also forward into trace store for unified JSONL disk logging
  try {
    emitTrace({
      turnId: entry.id,
      ev: 'turn.start',
      input: entry.input,
      source: 'texto',
    });
    emitTrace({
      turnId: entry.id,
      ev: 'plan.created',
      strategy: entry.usedFallbackLocal
        ? 'heuristic-fallback'
        : entry.provider === 'local'
          ? 'heuristic'
          : 'llm',
      provider: entry.provider,
      model: entry.model,
      latencyMs: entry.latencyMs,
      actions: entry.actionsPlanned,
      rawModelOutputTruncated: entry.rawResponse ? entry.rawResponse.slice(0, 2000) : undefined,
    });
    entry.executionResults.forEach((res, idx) => {
      emitTrace({
        turnId: entry.id,
        ev: 'action.end',
        actionIdx: idx,
        type: res.actionType,
        status: res.status,
        error: res.error,
        ms: 0,
      });
    });
    emitTrace({
      turnId: entry.id,
      ev: 'reply.composed',
      text: entry.reply,
      source: 'receipts',
    });
    emitTrace({
      turnId: entry.id,
      ev: 'turn.end',
      overallSuccess: entry.overallSuccess,
      durationMs: entry.latencyMs,
      error: entry.error,
    });
  } catch (err) {
    console.warn('[OperatorAudit] Error emitiendo traza:', err);
  }

  return entry;
}

/**
 * Clears the entire operator audit log.
 */
export function clearOperatorAuditLog(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(OPERATOR_AUDIT_LOG_KEY);
    window.dispatchEvent(
      new CustomEvent('kite:operator-audit-updated', {
        detail: { log: [] },
      })
    );
  } catch (err) {
    console.warn('[OperatorAudit] Error limpiando log de auditoría:', err);
  }
}

/**
 * Subscribes to changes in the operator audit log.
 */
export function subscribeToOperatorAuditLog(
  callback: (log: OperatorAuditEntry[]) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleUpdate = () => {
    callback(getOperatorAuditLog());
  };

  window.addEventListener('kite:operator-audit-updated', handleUpdate);
  window.addEventListener('storage', handleUpdate);

  return () => {
    window.removeEventListener('kite:operator-audit-updated', handleUpdate);
    window.removeEventListener('storage', handleUpdate);
  };
}
