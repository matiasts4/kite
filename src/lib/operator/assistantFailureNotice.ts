/**
 * User-facing copy when the Zed assistant's model fails.
 * Heuristic recovery can still run; the notice is what the toast should say.
 */

export interface ZedAssistantFailureInput {
  strategy?: string;
  fallbackReason?: string;
  actionCount?: number;
  providerId?: string;
}

const QUOTA_PATTERN =
  /\b(?:402|429)\b|quota|cuota|billing|payment|insufficient[_\s-]?(?:quota|credit|funds|balance)|rate[\s-]?limit|too many requests|usage limit|l[ií]mite de uso|out of (?:quota|credits)|cr[eé]ditos/i;

const AUTH_OR_SUBSCRIPTION_PATTERN =
  /\b(?:401|403)\b|permission_error|subscription\s+is\s+required|unauthorized|forbidden|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?failed|access[\s_-]?denied/i;

const NO_RESPONSE_PATTERN =
  /timed?\s*out|timeout|sin respuesta|no response|empty response|did not respond|no respondi[oó]|econnrefused|econnreset|enotfound|failed to fetch|fetch failed|socket hang up|gateway timeout|bad gateway|networkerror|network error|\b(?:500|502|503|504)\b|did not return valid output|sin devolver salida/i;

const CANCELLED_PATTERN = /\babort(?:ed|error)?\b|operation was aborted|cancel(?:led|ed|aci[oó]n)?/i;

const SECRET_TOKEN_PATTERN = /xai-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|bearer\s+\S+/i;

const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  grok: 'Grok',
  vercel: 'Vercel',
  cloudflare: 'Cloudflare',
};

function formatProviderLabel(providerId?: string): string {
  const clean = providerId?.trim().toLowerCase() ?? '';
  if (!clean || clean === 'local') return '';
  return PROVIDER_LABELS[clean] || clean;
}

const QUOTA_MESSAGE =
  'El modelo del asistente se quedó sin cuota. No hubo respuesta y la orden no se procesó.';

const QUOTA_RECOVERED_MESSAGE = 'El modelo del asistente se quedó sin cuota.';

const NO_RESPONSE_MESSAGE = 'El asistente no respondió. La orden no se pudo procesar.';

const NO_RESPONSE_RECOVERED_MESSAGE = 'El asistente no respondió.';

function stripUrls(text: string): string {
  return text
    .replace(/(?:\b(?:desde|from)\b\s+)?https?:\/\/\S+/gi, (match) => (match.endsWith(':') ? ':' : ''))
    .replace(/\s+:/g, ':')
    .replace(/:\s*:/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/g, '')
    .trim();
}

/**
 * Extracts a concise, URL-free diagnostic snippet from a raw provider error,
 * unwrapping JSON error messages (such as HTTP 403 permission errors) while rejecting credentials.
 */
export function extractSafeFailureDetail(fallbackReason?: string): string {
  const compact = (fallbackReason || '').replace(/\s+/g, ' ').trim();
  if (!compact || SECRET_TOKEN_PATTERN.test(compact)) {
    return '';
  }

  const statusMatch = compact.match(/\bHTTP\s*(\d{3})\b/i);
  const statusPrefix = statusMatch ? `HTTP ${statusMatch[1]}: ` : '';

  let detail = '';
  const jsonStart = compact.indexOf('{');
  const jsonEnd = compact.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(compact.slice(jsonStart, jsonEnd + 1)) as {
        message?: unknown;
        error?: { message?: unknown };
      };
      const rawJsonMsg =
        typeof parsed?.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed?.message === 'string'
            ? parsed.message
            : '';
      const cleanJsonMsg = stripUrls(rawJsonMsg);
      if (cleanJsonMsg) {
        detail = `${statusPrefix}${cleanJsonMsg}`;
      }
    } catch {
      // Fall through to plain text sanitization
    }
  }

  if (!detail) {
    detail = stripUrls(compact);
  }

  if (!detail || SECRET_TOKEN_PATTERN.test(detail)) {
    return '';
  }

  return detail.length > 160 ? `${detail.slice(0, 159)}…` : detail;
}

/**
 * Returns a short Spanish notice for quota exhaustion, auth/subscription rejection,
 * or a model that did not answer. Local heuristic plans and user cancellations stay silent.
 */
export function zedAssistantFailureMessage(input: ZedAssistantFailureInput): string | null {
  if (input.strategy !== 'heuristic-fallback') return null;

  const reason = input.fallbackReason?.trim() ?? '';
  if (CANCELLED_PATTERN.test(reason) && !QUOTA_PATTERN.test(reason)) return null;

  const nothingProcessed = (input.actionCount ?? 0) === 0;

  if (QUOTA_PATTERN.test(reason)) {
    return nothingProcessed ? QUOTA_MESSAGE : QUOTA_RECOVERED_MESSAGE;
  }

  if (AUTH_OR_SUBSCRIPTION_PATTERN.test(reason)) {
    const providerLabel = formatProviderLabel(input.providerId);
    const prefix = providerLabel
      ? `El proveedor del asistente (${providerLabel}) rechazó la solicitud por permisos o suscripción.`
      : 'El proveedor del asistente rechazó la solicitud por permisos o suscripción.';
    return nothingProcessed
      ? `${prefix} Cambia o revisa el proveedor en Ajustes → Argos → Proveedor.`
      : prefix;
  }

  if (NO_RESPONSE_PATTERN.test(reason)) {
    return nothingProcessed ? NO_RESPONSE_MESSAGE : NO_RESPONSE_RECOVERED_MESSAGE;
  }

  if (nothingProcessed && reason) {
    return NO_RESPONSE_MESSAGE;
  }

  return null;
}
