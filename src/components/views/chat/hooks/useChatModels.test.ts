import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { invokeCommand } from '../../../../lib/ipc';
import { useChatModels } from './useChatModels';
import { PROVIDER_CATALOG, type ChatProvider, type ModelOption } from '../types';

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

type ModelsResponse = { models: ModelOption[]; cached?: boolean };

const dynamicProviders = Object.keys(PROVIDER_CATALOG) as ChatProvider[];

function liveModels(provider: ChatProvider): ModelOption[] {
  return [{ id: `${provider}-live`, name: `${provider} live`, description: 'Reported by the provider CLI' }];
}

function respondFrom(handler: (provider: ChatProvider) => ModelsResponse) {
  vi.mocked(invokeCommand).mockImplementation((async (
    _command: string,
    args: Record<string, unknown>
  ) => handler(args.provider as ChatProvider)) as unknown as typeof invokeCommand);
}

function invocationsFor(provider: ChatProvider) {
  return vi
    .mocked(invokeCommand)
    .mock.calls.filter(([, args]) => (args as { provider?: string }).provider === provider);
}

describe('useChatModels', () => {
  beforeEach(() => {
    vi.mocked(invokeCommand).mockReset();
    respondFrom((provider) => ({ models: liveModels(provider) }));
  });

  it('prefetches every dynamic provider exactly once when the chat session mounts', async () => {
    renderHook(() => useChatModels());

    await waitFor(() => expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(dynamicProviders.length));

    for (const provider of dynamicProviders) {
      expect(invocationsFor(provider)).toHaveLength(1);
      expect(invocationsFor(provider)[0][0]).toBe('list_chat_provider_models');
      expect((invocationsFor(provider)[0][1] as { forceRefresh?: boolean }).forceRefresh).toBe(false);
    }
  });

  it('does not invoke a provider again for a non-forced request in the same session', async () => {
    const { result } = renderHook(() => useChatModels());
    const provider = dynamicProviders[0];

    await waitFor(() => expect(invocationsFor(provider)).toHaveLength(1));

    await act(async () => {
      await result.current.fetchDynamicModels(provider, false);
      await result.current.fetchDynamicModels(provider);
    });

    expect(invocationsFor(provider)).toHaveLength(1);
  });

  it('invokes again on a forced refresh and replaces the cached list', async () => {
    const { result } = renderHook(() => useChatModels());
    const provider = dynamicProviders[0];
    const fresh: ModelOption[] = [{ id: `${provider}-fresh`, name: 'Freshly released model' }];

    await waitFor(() => expect(invocationsFor(provider)).toHaveLength(1));

    respondFrom(() => ({ models: fresh }));

    await act(async () => {
      await result.current.fetchDynamicModels(provider, true);
    });

    expect(invocationsFor(provider)).toHaveLength(2);
    expect((invocationsFor(provider)[1][1] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    expect(result.current.dynamicModelsMap[provider]).toEqual(fresh);
  });

  it('still forces a refresh through refreshModels for existing callers', async () => {
    const { result } = renderHook(() => useChatModels());
    const provider = dynamicProviders[0];

    await waitFor(() => expect(invocationsFor(provider)).toHaveLength(1));

    await act(async () => {
      await result.current.refreshModels(provider);
    });

    expect(invocationsFor(provider)).toHaveLength(2);
    expect((invocationsFor(provider)[1][1] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    expect(result.current.isRefreshingModels).toBe(false);
  });

  it('does not invent a model list when a fetch fails, and never clears a good list with an empty refresh', async () => {
    const provider = dynamicProviders[0];
    vi.mocked(invokeCommand).mockRejectedValue(new Error('provider CLI unavailable'));

    const { result } = renderHook(() => useChatModels());

    await waitFor(() => expect(invocationsFor(provider)).toHaveLength(1));
    expect(result.current.dynamicModelsMap[provider]).toBeUndefined();

    respondFrom(() => ({ models: liveModels(provider) }));
    await act(async () => {
      await result.current.fetchDynamicModels(provider, true);
    });

    const good = result.current.dynamicModelsMap[provider];
    expect(good).toEqual(liveModels(provider));

    respondFrom(() => ({ models: [] }));
    await act(async () => {
      await result.current.fetchDynamicModels(provider, true);
    });

    expect(result.current.dynamicModelsMap[provider]).toEqual(good);
  });
});
