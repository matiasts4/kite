/**
 * User-facing copy when the Zed assistant's model fails.
 * Heuristic recovery can still run; the notice is what the toast should say.
 */

export interface ZedAssistantFailureInput {
  strategy?: string;
  fallbackReason?: string;
  actionCount?: number;
}

const QUOTA_PATTERN =
  /\b(?:402|429)\b|quota|cuota|billing|payment|insufficient[_\s-]?(?:quota|credit|funds|balance)|rate[\s-]?limit|too many requests|usage limit|l[ií]mite de uso|out of (?:quota|credits)|cr[eé]ditos/i;

const NO_RESPONSE_PATTERN =
  /timed?\s*out|timeout|sin respuesta|no response|empty response|did not respond|no respondi[oó]|econnrefused|econnreset|enotfound|failed to fetch|fetch failed|socket hang up|gateway timeout|bad gateway|networkerror|network error|\b(?:500|502|503|504)\b|did not return valid output|sin devolver salida/i;

const CANCELLED_PATTERN = /\babort(?:ed|error)?\b|operation was aborted|cancel(?:led|ed|aci[oó]n)?/i;

const QUOTA_MESSAGE =
  'El modelo del asistente se quedó sin cuota. No hubo respuesta y la orden no se procesó.';

const QUOTA_RECOVERED_MESSAGE = 'El modelo del asistente se quedó sin cuota.';

const NO_RESPONSE_MESSAGE = 'El asistente no respondió. La orden no se pudo procesar.';

const NO_RESPONSE_RECOVERED_MESSAGE = 'El asistente no respondió.';

/**
 * Returns a short Spanish notice for quota exhaustion or a model that did not answer.
 * Local heuristic plans and user cancellations stay silent.
 */
export function zedAssistantFailureMessage(input: ZedAssistantFailureInput): string | null {
  if (input.strategy !== 'heuristic-fallback') return null;

  const reason = input.fallbackReason?.trim() ?? '';
  if (CANCELLED_PATTERN.test(reason) && !QUOTA_PATTERN.test(reason)) return null;

  const nothingProcessed = (input.actionCount ?? 0) === 0;

  if (QUOTA_PATTERN.test(reason)) {
    return nothingProcessed ? QUOTA_MESSAGE : QUOTA_RECOVERED_MESSAGE;
  }

  if (NO_RESPONSE_PATTERN.test(reason)) {
    return nothingProcessed ? NO_RESPONSE_MESSAGE : NO_RESPONSE_RECOVERED_MESSAGE;
  }

  if (nothingProcessed && reason) {
    return NO_RESPONSE_MESSAGE;
  }

  return null;
}
