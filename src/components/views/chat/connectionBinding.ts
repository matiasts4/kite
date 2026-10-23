import type { ConnectionSummary } from '../../../lib/ipc';

/**
 * The local chat spawn form for each provider. These ids match the spawn
 * endpoints the native chat runtime knows; a verified quota route or a network
 * chat route is never a substitute for one.
 */
export const CHAT_SPAWN_ENDPOINTS: Record<string, string> = {
  antigravity: 'agy -p',
  claude: 'claude -p',
  codex: 'codex exec',
  cursor: 'cursor-agent -p',
  grok: 'grok -p',
  opencode: 'opencode run',
  gemini: 'gemini --prompt',
};

/** The network chat route for a Go key. It needs a Go model and the
 * `x-opencode-session` header, and the local `opencode run` spawn selects
 * neither, so the two must never be used for each other. */
export const OPENCODE_GO_CHAT_ENDPOINT =
  'https://opencode.ai/inference/go/openai/v1/chat/completions';

/** The connection fields a chat send forwards. Both are present together or
 * neither is: a connection id alone gives the runtime no verified endpoint. */
export interface ThreadSendBinding {
  connectionId: string;
  supportedEndpoint: string;
}

export interface ConnectionCandidate {
  connectionId: string;
  displayName: string;
  supportedEndpoint: string;
}

const PROVIDER_ALIASES: Record<string, string> = {
  agy: 'antigravity',
  'claude-code': 'claude',
  'open-code': 'opencode',
};

function canonicalProvider(provider: string): string {
  const raw = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[raw] ?? raw;
}

export function spawnEndpointForProvider(provider: string): string | null {
  return CHAT_SPAWN_ENDPOINTS[canonicalProvider(provider)] ?? null;
}

function verifiesSpawnEndpoint(
  connection: ConnectionSummary,
  provider: string,
  spawnEndpoint: string
): boolean {
  if (canonicalProvider(connection.driverKind) !== provider) return false;
  return connection.endpoints.some(
    (endpoint) => endpoint.ok && endpoint.endpointId.trim() === spawnEndpoint
  );
}

/**
 * Connections that verified the local spawn endpoint for this provider. A
 * connection whose only verified endpoint is a quota or network route does not
 * qualify. The spawn endpoint id is carried with every candidate, so a
 * connection id can never be bound without the endpoint it was verified for.
 */
export function verifiedSpawnConnections(
  provider: string,
  connections: readonly ConnectionSummary[]
): ConnectionCandidate[] {
  const canonical = canonicalProvider(provider);
  const spawnEndpoint = spawnEndpointForProvider(canonical);
  if (!spawnEndpoint) return [];
  return connections
    .filter((connection) => verifiesSpawnEndpoint(connection, canonical, spawnEndpoint))
    .map((connection) => ({
      connectionId: connection.connectionId,
      displayName: connection.displayName,
      supportedEndpoint: spawnEndpoint,
    }));
}

/**
 * Resolves the binding a thread can write without asking the user. One verified
 * connection binds that connection; zero or several leave the binding unset, so
 * the composer asks instead of guessing.
 */
export function resolveConnectionBinding(
  provider: string,
  connections: readonly ConnectionSummary[]
): { candidates: ConnectionCandidate[]; binding: ThreadSendBinding | null } {
  const candidates = verifiedSpawnConnections(provider, connections);
  if (candidates.length !== 1) {
    return { candidates, binding: null };
  }
  return {
    candidates,
    binding: {
      connectionId: candidates[0].connectionId,
      supportedEndpoint: candidates[0].supportedEndpoint,
    },
  };
}

/** The binding for a connection the user chose, or null when that connection
 * did not verify this provider's spawn endpoint. */
export function bindingForConnection(
  provider: string,
  connections: readonly ConnectionSummary[],
  connectionId: string | null | undefined
): ThreadSendBinding | null {
  if (!connectionId) return null;
  const match = verifiedSpawnConnections(provider, connections).find(
    (candidate) => candidate.connectionId === connectionId
  );
  if (!match) return null;
  return {
    connectionId: match.connectionId,
    supportedEndpoint: match.supportedEndpoint,
  };
}
