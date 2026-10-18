import type { ProviderQuotaStatus } from './types';

export type HonestProviderState = 'ok' | 'detected' | 'signed_out' | 'error' | 'not_installed';

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
