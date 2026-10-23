import { describe, expect, it } from 'vitest';
import { buildConnection, OPENCODE_PAYG_CHAT_ENDPOINT } from './types';

describe('connection records', () => {
  it('gives two OpenCode auth methods two connection ids', () => {
    const goKey = buildConnection({
      driverKind: 'opencode',
      authMethod: 'api_key',
      displayName: 'OpenCode Go',
      accountIdentity: { orgId: 'org-1' },
      credentialRef: { kind: 'kite_file', locator: 'opencode-go-quota.json' },
      entitlement: { planType: 'go', billingMode: 'subscription', ok: true },
      endpoints: [],
    });
    const consoleOAuth = buildConnection({
      driverKind: 'opencode',
      authMethod: 'console_oauth',
      displayName: 'OpenCode Console',
      accountIdentity: { orgId: 'org-1' },
      credentialRef: { kind: 'vault', locator: 'opencode-console' },
      entitlement: { planType: null, billingMode: 'payg', ok: false },
      endpoints: [],
    });

    expect(goKey.connection.connectionId).not.toBe(consoleOAuth.connection.connectionId);
    expect(goKey.rejected).toEqual([]);
    expect(consoleOAuth.rejected).toEqual([]);
  });

  it('does not store a Go key as valid for the pay-as-you-go chat endpoint', () => {
    const stored = buildConnection({
      driverKind: 'opencode',
      authMethod: 'api_key',
      displayName: 'OpenCode Go',
      accountIdentity: { orgId: 'org-1' },
      credentialRef: { kind: 'kite_file', locator: 'opencode-go-quota.json' },
      entitlement: { planType: 'go', billingMode: 'subscription', ok: true },
      endpoints: [
        {
          endpointId: OPENCODE_PAYG_CHAT_ENDPOINT,
          ok: true,
          httpStatus: 200,
          verifiedAt: 1,
        },
      ],
    });

    expect(stored.rejected).toContain(OPENCODE_PAYG_CHAT_ENDPOINT);
    expect(stored.connection.endpoints.find((endpoint) => endpoint.endpointId === OPENCODE_PAYG_CHAT_ENDPOINT)).toBeUndefined();
  });
});
