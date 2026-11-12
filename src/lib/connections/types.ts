export const OPENCODE_PAYG_CHAT_ENDPOINT = 'https://opencode.ai/inference/v1/chat/completions';

const OPENCODE_PAYG_CHAT_ENDPOINTS = [
  OPENCODE_PAYG_CHAT_ENDPOINT,
  'https://opencode.ai/inference/openai/v1/chat/completions',
] as const;

export type DriverKind =
  | 'opencode'
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'grok'
  | 'gemini'
  | 'cursor';

export type AuthMethod =
  | 'api_key'
  | 'console_oauth'
  | 'cli_session'
  | 'local_rpc'
  | 'google_oauth'
  | 'acp';

export interface AccountIdentity {
  email?: string | null;
  orgId?: string | null;
  accountId?: string | null;
}

export interface CredentialRef {
  kind: 'vault' | 'env' | 'cli_file' | 'kite_file';
  locator: string;
}

export interface EndpointVerification {
  endpointId: string;
  ok: boolean;
  httpStatus: number | null;
  verifiedAt: number | null;
}

export interface Entitlement {
  planType: string | null;
  billingMode: 'subscription' | 'payg' | null;
  ok: boolean;
}

export interface ConnectionDraft {
  driverKind: DriverKind;
  authMethod: AuthMethod;
  displayName: string;
  accountIdentity: AccountIdentity;
  credentialRef: CredentialRef;
  entitlement: Entitlement;
  endpoints: EndpointVerification[];
}

export interface ConnectionRecord {
  connectionId: string;
  driverKind: DriverKind;
  authMethod: AuthMethod;
  displayName: string;
  accountIdentity: AccountIdentity;
  credentialRef: CredentialRef;
  entitlement: Entitlement;
  endpoints: EndpointVerification[];
}

export interface BuiltConnection {
  connection: ConnectionRecord;
  rejected: string[];
}

function identityPart(value: string | null | undefined): string {
  return (value ?? '').trim();
}

export function connectionIdFor(
  driverKind: DriverKind,
  authMethod: AuthMethod,
  accountIdentity: AccountIdentity,
): string {
  const email = identityPart(accountIdentity.email).toLowerCase();
  const orgId = identityPart(accountIdentity.orgId);
  const accountId = identityPart(accountIdentity.accountId);
  return `${driverKind}:${authMethod}:email=${email}|org=${orgId}|account=${accountId}`;
}

function isOpenCodeGoKey(draft: ConnectionDraft): boolean {
  return (
    draft.driverKind === 'opencode' &&
    draft.authMethod === 'api_key' &&
    draft.entitlement.billingMode === 'subscription'
  );
}

function rejectsPaygChat(draft: ConnectionDraft, endpoint: EndpointVerification): boolean {
  if (!endpoint.ok || !isOpenCodeGoKey(draft)) return false;
  return OPENCODE_PAYG_CHAT_ENDPOINTS.includes(
    endpoint.endpointId as (typeof OPENCODE_PAYG_CHAT_ENDPOINTS)[number],
  );
}

export function buildConnection(draft: ConnectionDraft): BuiltConnection {
  const rejected: string[] = [];
  const endpoints: EndpointVerification[] = [];
  for (const endpoint of draft.endpoints) {
    if (rejectsPaygChat(draft, endpoint)) {
      rejected.push(endpoint.endpointId);
      continue;
    }
    endpoints.push(endpoint);
  }
  return {
    rejected,
    connection: {
      connectionId: connectionIdFor(draft.driverKind, draft.authMethod, draft.accountIdentity),
      driverKind: draft.driverKind,
      authMethod: draft.authMethod,
      displayName: draft.displayName,
      accountIdentity: draft.accountIdentity,
      credentialRef: draft.credentialRef,
      entitlement: draft.entitlement,
      endpoints,
    },
  };
}
