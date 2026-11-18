import type { ProviderQuotaStatus } from './types';

export type HonestProviderState = 'ok' | 'detected' | 'signed_out' | 'error' | 'not_installed';

export const QUOTA_STALE_WARNING_MS = 30 * 60 * 1000;

export interface QuotaRefreshNotice {
  message: string;
  detail: string;
  lastUpdatedLabel: string;
  ageMs: number;
}

export function hasUsableQuotaData(q: ProviderQuotaStatus | null | undefined): boolean {
  return Boolean(q && q.isAvailable && q.isAuth && !q.error);
}

export function isUsableQuotaUpdate(
  prev: ProviderQuotaStatus | undefined,
  incoming: ProviderQuotaStatus
): boolean {
  if (!hasUsableQuotaData(incoming)) {
    return false;
  }
  if (
    prev &&
    prev.windows?.length > 0 &&
    (!incoming.windows || incoming.windows.length === 0) &&
    !incoming.metadata?.note
  ) {
    return false;
  }
  return true;
}

export function readQuotaRefreshError(q: ProviderQuotaStatus | null | undefined): string | null {
  const raw = q?.metadata?.lastRefreshError;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function formatQuotaStaleAge(ageMs: number): string {
  const totalMin = Math.max(1, Math.floor(ageMs / 60_000));
  if (totalMin < 60) {
    return `hace ${totalMin} min`;
  }
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    return `hace ${totalHours} h`;
  }
  const days = Math.floor(totalHours / 24);
  return `hace ${days} d`;
}

export function getQuotaRefreshNotice(
  q: ProviderQuotaStatus | null | undefined,
  nowMs: number = Date.now()
): QuotaRefreshNotice | null {
  const refreshError = readQuotaRefreshError(q);
  if (!q || !refreshError || !hasUsableQuotaData(q)) {
    return null;
  }
  const updatedMs = Number.isFinite(q.lastUpdatedMs) && q.lastUpdatedMs > 0 ? q.lastUpdatedMs : 0;
  const referenceMs = updatedMs || Number(q.metadata?.lastRefreshErrorAtMs) || 0;
  if (referenceMs <= 0) {
    return null;
  }
  const ageMs = Math.max(0, nowMs - referenceMs);
  if (ageMs < QUOTA_STALE_WARNING_MS) {
    return null;
  }
  const lastUpdatedLabel = formatQuotaStaleAge(ageMs);
  return {
    message: `No se pudo actualizar la cuota (${lastUpdatedLabel}). Mostrando el último dato guardado.`,
    detail: refreshError,
    lastUpdatedLabel,
    ageMs,
  };
}

export interface ProviderDiagnostic {
  state: HonestProviderState;
  hasQuota: boolean;
  statusLabel: string;
  detail: string | null;
  badgeVariant: 'success' | 'warning' | 'info' | 'error' | 'neutral';
}

/**
 * Categorizes a provider's live state with honesty:
 * - 'ok': Connected and exposes live quota windows and consumption figures.
 * - 'detected': Detected and authenticated locally, but does not expose an active quota meter.
 * - 'signed_out': Detected locally, but requires user sign-in / CLI login command.
 * - 'error': Active credentials exist but the upstream returned an error (e.g. Privacy Mode, 401, network).
 * - 'not_installed': Not detected in the system.
 */
export function diagnoseProvider(q: ProviderQuotaStatus | null | undefined): ProviderDiagnostic {
  if (!q || !q.isAvailable) {
    return {
      state: 'not_installed',
      hasQuota: false,
      statusLabel: 'No detectado',
      detail: q?.error || 'No se encontraron binarios o credenciales en el equipo',
      badgeVariant: 'neutral',
    };
  }

  if (q.error) {
    const errLower = q.error.toLowerCase();
    const isSessionIssue =
      !q.isAuth ||
      errLower.includes('sesión') ||
      errLower.includes('session') ||
      errLower.includes('login') ||
      errLower.includes('iniciar sesión') ||
      errLower.includes('expirad');

    if (isSessionIssue) {
      return {
        state: 'signed_out',
        hasQuota: false,
        statusLabel: 'Sesión requerida',
        detail: q.error,
        badgeVariant: 'warning',
      };
    }

    return {
      state: 'error',
      hasQuota: false,
      statusLabel: 'Atención requerida',
      detail: q.error,
      badgeVariant: 'error',
    };
  }

  const hasWindows = Boolean(q.windows && q.windows.length > 0);

  if (hasWindows) {
    return {
      state: 'ok',
      hasQuota: true,
      statusLabel: 'En línea',
      detail: null,
      badgeVariant: 'success',
    };
  }

  // Available, authenticated, but no quota windows reported
  return {
    state: 'detected',
    hasQuota: false,
    statusLabel: 'Conectado (Sin cuota expuesta)',
    detail: (q.metadata?.note as string) || 'Herramienta detectada con sesión local activa',
    badgeVariant: 'info',
  };
}
