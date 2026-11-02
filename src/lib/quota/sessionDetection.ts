import { type DetectedCliAccount, type CredentialStatusItem } from '../ipc';
import { normalizeTerminalEngine, type ActiveAgentTerminal } from '../terminalRegistry';
import { ALL_SUPPORTED_PROVIDERS, type ProviderQuotaStatus } from './types';
import { getProviderConnectionMeta } from './connectionMethods';

export interface ProviderDetectedSession {
  providerId: string;
  hasSession: boolean;
  sessionType:
    | 'terminal_agent'
    | 'cli_authenticated'
    | 'api_key_vault'
    | 'api_key_env'
    | 'cli_installed'
    | 'quota_active'
    | 'none';
  statusLabel: string;
  statusTone: 'ok' | 'warn' | 'idle';
  email?: string;
  accountLabel?: string;
  planName?: string;
  terminalTitle?: string;
  binaryPath?: string;
  configPath?: string;
  details?: string;
}

export function matchEngineToProvider(engine: string, providerId: string): boolean {
  if (!engine || !providerId) return false;
  const norm = normalizeTerminalEngine(engine).toLowerCase();
  const prov = providerId.toLowerCase();
  if (norm === prov) return true;
  if (prov === 'claude' && (norm === 'claude-code' || norm === 'claude')) return true;
  if (prov === 'opencode' && (norm === 'open-code' || norm === 'opencode')) return true;
  if (prov === 'gemini' && (norm === 'gemini' || norm === 'antigravity')) return true;
  if (prov === 'antigravity' && (norm === 'antigravity' || norm === 'gemini')) return true;
  if (prov === 'cursor' && (norm === 'cursor' || norm === 'cursor-agent')) return true;
  return false;
}

export function resolveProviderDetectedSession(
  providerId: string,
  cliAccounts: DetectedCliAccount[] = [],
  terminals: ActiveAgentTerminal[] = [],
  quota?: ProviderQuotaStatus,
  credentials: CredentialStatusItem[] = []
): ProviderDetectedSession {
  // 1. Terminal Agent: Active live process running in terminal pane
  const activeTerm = terminals.find(
    (t) => matchEngineToProvider(t.engine, providerId) && t.state !== 'exited'
  );
  if (activeTerm) {
    return {
      providerId,
      hasSession: true,
      sessionType: 'terminal_agent',
      statusLabel: '● Agente en terminal',
      statusTone: 'ok',
      terminalTitle: activeTerm.who || activeTerm.title,
      details: `Terminal activa: ${activeTerm.title}`,
    };
  }

  // 2. Local CLI Account (tokens/oauth files in ~/.gemini, ~/.codex, ~/.grok, etc.)
  const cli = cliAccounts.find(
    (a) =>
      a.provider === providerId ||
      (providerId === 'gemini' && a.provider === 'antigravity') ||
      (providerId === 'antigravity' && a.provider === 'gemini')
  );

  if (cli && cli.authState === 'authenticated') {
    return {
      providerId,
      hasSession: true,
      sessionType: 'cli_authenticated',
      statusLabel: '● Sesión CLI detectada',
      statusTone: 'ok',
      email: cli.email,
      accountLabel: cli.accountLabel,
      planName: cli.planName,
      binaryPath: cli.binaryPath,
      configPath: cli.configPath,
      details: cli.details || 'Credenciales CLI locales activas',
    };
  }

  // 3. Vault API Key or Environment Variable
  const meta = getProviderConnectionMeta(providerId);
  const credKey = meta?.apiKeyProviderKey ?? providerId;
  const cred = credentials.find(
    (c) => c.provider === credKey || c.provider === providerId
  );
  if (cred && cred.isConfigured) {
    return {
      providerId,
      hasSession: true,
      sessionType: cred.source === 'vault' ? 'api_key_vault' : 'api_key_env',
      statusLabel: cred.source === 'vault' ? '● Clave en bóveda' : '● Clave en entorno',
      statusTone: 'ok',
      email: cred.preview ? `API Key (${cred.preview})` : 'Clave de API configurada',
      planName: 'API Directa / Bóveda',
      details:
        cred.source === 'vault'
          ? 'Clave de API guardada y cifrada en la base de datos de Kite'
          : `Detectada en variable de entorno del sistema (${meta?.envVars?.[0] || 'ENV'})`,
    };
  }

  // 4. Quota Status: Live network verified quota or verified connection
  if (quota?.isAuth) {
    return {
      providerId,
      hasSession: true,
      sessionType: 'quota_active',
      statusLabel: '● Conexión activa',
      statusTone: 'ok',
      email: quota.metadata?.email ? String(quota.metadata.email) : undefined,
      details: 'Sesión activa verificada',
    };
  }

  // 5. Installed CLI binary (unauthenticated)
  if (cli && cli.authState === 'unauthenticated') {
    return {
      providerId,
      hasSession: false,
      sessionType: 'cli_installed',
      statusLabel: '○ CLI instalada',
      statusTone: 'warn',
      binaryPath: cli.binaryPath,
      configPath: cli.configPath,
      details: cli.details || 'Instalado localmente, requiere iniciar sesión',
    };
  }

  // 6. Default: No session or install detected
  return {
    providerId,
    hasSession: false,
    sessionType: 'none',
    statusLabel: 'No instalado',
    statusTone: 'idle',
    details: 'Sin sesión ni CLI detectada en este equipo',
  };
}

export function detectAllProviderSessions(
  cliAccounts: DetectedCliAccount[] = [],
  terminals: ActiveAgentTerminal[] = [],
  quotas: Record<string, ProviderQuotaStatus> = {},
  credentials: CredentialStatusItem[] = []
): Record<string, ProviderDetectedSession> {
  const result: Record<string, ProviderDetectedSession> = {};
  for (const id of ALL_SUPPORTED_PROVIDERS) {
    result[id] = resolveProviderDetectedSession(
      id,
      cliAccounts,
      terminals,
      quotas[id],
      credentials
    );
  }
  return result;
}

export function getAutoEnableSuggestedProviders(
  detectedSessions: Record<string, ProviderDetectedSession>
): string[] {
  return Object.values(detectedSessions)
    .filter((s) => s.hasSession)
    .map((s) => s.providerId);
}
