import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ConnectionSummary } from '../../../../lib/ipc';
import type { ExtendedChatThread } from '../types';
import {
  readThreadSendBinding,
  withResolvedSendBindings,
  useChatConnectionBindings,
} from './useChatConnectionBindings';

vi.mock('../../../../lib/ipc', () => ({
  listConnections: vi.fn().mockResolvedValue([
    {
      connectionId: 'conn-1',
      driverKind: 'antigravity',
      displayName: 'Antigravity CLI',
      authMethod: 'cli_session',
      accountIdentity: {},
      credentialRef: 'vault',
      endpoints: [{ endpointId: 'agy -p', ok: true }],
      status: 'connected',
    },
  ]),
  invokeCommand: vi.fn(),
}));

describe('readThreadSendBinding', () => {
  it('extracts connectionId and supportedEndpoint when present on thread', () => {
    const thread = {
      id: 't-1',
      provider: 'antigravity',
      connectionId: 'conn-1',
      supportedEndpoint: 'agy -p',
    } as unknown as ExtendedChatThread;

    const binding = readThreadSendBinding(thread);
    expect(binding).toEqual({
      connectionId: 'conn-1',
      supportedEndpoint: 'agy -p',
    });
  });

  it('omits connectionId and supportedEndpoint when unset', () => {
    const thread = {
      id: 't-2',
      provider: 'claude',
      connectionId: null,
      supportedEndpoint: null,
    } as unknown as ExtendedChatThread;

    const binding = readThreadSendBinding(thread);
    expect(binding).toEqual({});
  });
});

describe('withResolvedSendBindings', () => {
  const connections: ConnectionSummary[] = [
    {
      connectionId: 'conn-1',
      driverKind: 'antigravity',
      displayName: 'Antigravity CLI',
      authMethod: 'cli_session',
      accountIdentity: {},
      credentialRef: 'vault',
      endpoints: [{ endpointId: 'agy -p', ok: true }],
      status: 'connected',
    },
  ];

  it('binds connection if exactly one candidate is verified', () => {
    const threadMap: Record<string, ExtendedChatThread> = {
      't-1': {
        id: 't-1',
        provider: 'antigravity',
      } as ExtendedChatThread,
    };

    const next = withResolvedSendBindings(threadMap, connections, {});
    expect(next['t-1'].connectionId).toBe('conn-1');
    expect(next['t-1'].supportedEndpoint).toBe('agy -p');
  });

  it('preserves existing map reference if nothing changes', () => {
    const threadMap: Record<string, ExtendedChatThread> = {
      't-1': {
        id: 't-1',
        provider: 'antigravity',
        connectionId: 'conn-1',
        supportedEndpoint: 'agy -p',
      } as ExtendedChatThread,
    };

    const next = withResolvedSendBindings(threadMap, connections, {});
    expect(next).toBe(threadMap);
  });
});

describe('useChatConnectionBindings', () => {
  it('resolves bindings and updates thread connections', async () => {
    let threadMap: Record<string, ExtendedChatThread> = {
      't-1': {
        id: 't-1',
        provider: 'antigravity',
      } as ExtendedChatThread,
    };
    const setThreadsMap = vi.fn((updater) => {
      threadMap = typeof updater === 'function' ? updater(threadMap) : updater;
    });

    const isMountedRef = { current: true };
    const { result } = renderHook(() =>
      useChatConnectionBindings({
        threadsMap: threadMap,
        setThreadsMap,
        isMountedRef,
      })
    );

    await act(async () => {
      await result.current.loadConnections();
    });

    const bound = result.current.threadWithResolvedBinding(threadMap['t-1']);
    expect(bound.connectionId).toBe('conn-1');
    expect(bound.supportedEndpoint).toBe('agy -p');

    await act(async () => {
      await result.current.selectThreadConnection('t-1', 'conn-custom');
    });

    expect(result.current.threadConnections['t-1']).toBe('conn-custom');
  });
});
