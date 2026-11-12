// Kite Code — Operator Postcondition Verification
// Verifies terminal creation, layout state, and process presence in active registry.

import { getActiveAgentTerminals } from '../../terminalRegistry';
import type { ActionVerification } from '../contract';

/**
 * Polls active terminals registry until expected new terminals appear or timeout fires.
 */
export async function verifyOpenTerminals(
  initialSessionIds: Set<string>,
  expectedNew: number,
  expectedEngine: string,
  timeoutMs: number = 3000,
  expectedSessionIds?: string[]
): Promise<ActionVerification & { sessionIds: string[] }> {
  const startTime = Date.now();
  const pollIntervalMs = 150;

  while (Date.now() - startTime <= timeoutMs) {
    const current = getActiveAgentTerminals();
    const currentIdSet = new Set(current.map((t) => t.sessionId));
    const newSessions = current.filter((t) => !initialSessionIds.has(t.sessionId));
    const confirmedExpected = (expectedSessionIds || []).filter((id) => currentIdSet.has(id));

    if (
      newSessions.length >= expectedNew ||
      (expectedSessionIds && expectedSessionIds.length >= expectedNew && confirmedExpected.length >= expectedNew)
    ) {
      const ids =
        newSessions.length >= expectedNew
          ? newSessions.map((s) => s.sessionId)
          : confirmedExpected;
      return {
        expected: { count: expectedNew, engine: expectedEngine },
        observed: { count: ids.length, sessionIds: ids },
        ok: true,
        sessionIds: ids,
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout reached
  const finalCurrent = getActiveAgentTerminals();
  const finalIdSet = new Set(finalCurrent.map((t) => t.sessionId));
  const observedNew = finalCurrent.filter((t) => !initialSessionIds.has(t.sessionId));
  const finalConfirmed = (expectedSessionIds || []).filter((id) => finalIdSet.has(id));

  const isOk = Boolean(
    observedNew.length >= expectedNew ||
    (expectedSessionIds && expectedSessionIds.length >= expectedNew && finalConfirmed.length >= expectedNew)
  );

  const ids =
    observedNew.length >= expectedNew
      ? observedNew.map((s) => s.sessionId)
      : finalConfirmed.length > 0
      ? finalConfirmed
      : observedNew.map((s) => s.sessionId);

  return {
    expected: { count: expectedNew, engine: expectedEngine },
    observed: { count: ids.length, sessionIds: ids },
    ok: isOk,
    error: !isOk
      ? `Se esperaban ${expectedNew} terminales nuevas con ${expectedEngine}, pero solo se detectaron ${ids.length}.`
      : undefined,
    sessionIds: ids,
  };
}

/**
 * Verifies that closed session IDs are no longer active in the terminal registry.
 */
export async function verifyCloseTerminals(
  targetSessionIds: string[],
  timeoutMs: number = 2000
): Promise<ActionVerification> {
  if (!targetSessionIds || targetSessionIds.length === 0) {
    return {
      expected: { closedCount: 1 },
      observed: { stillActiveCount: 0, targetSessionIds: [] },
      ok: false,
      error: 'No se especificaron terminales válidas para cerrar o verificar.',
    };
  }

  const startTime = Date.now();
  const pollIntervalMs = 150;

  while (Date.now() - startTime <= timeoutMs) {
    const active = getActiveAgentTerminals();
    const stillActive = active.filter((t) => targetSessionIds.includes(t.sessionId));

    if (stillActive.length === 0) {
      return {
        expected: { closedCount: targetSessionIds.length },
        observed: { stillActiveCount: 0 },
        ok: true,
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const finalActive = getActiveAgentTerminals();
  const remaining = finalActive.filter((t) => targetSessionIds.includes(t.sessionId));

  return {
    expected: { closedCount: targetSessionIds.length },
    observed: { remainingCount: remaining.length, remainingIds: remaining.map((r) => r.sessionId) },
    ok: remaining.length === 0,
    error:
      remaining.length > 0
        ? `No se pudieron cerrar ${remaining.length} terminales: ${remaining.map((r) => r.sessionId).join(', ')}`
        : undefined,
  };
}
