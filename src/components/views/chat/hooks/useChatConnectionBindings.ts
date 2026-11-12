import { useState, useEffect, useRef, type MutableRefObject } from 'react';
import { listConnections, type ConnectionSummary } from '../../../../lib/ipc';
import type { ExtendedChatThread } from '../types';
import {
  bindingForConnection,
  resolveConnectionBinding,
  type ThreadSendBinding,
} from '../connectionBinding';

export type SendBindingArgs = Partial<ThreadSendBinding>;

/**
 * A send forwards the thread's connection and supported endpoint only when the
 * thread already carries them. Nothing is inferred from the provider id.
 */
export const readThreadSendBinding = (thread: ExtendedChatThread): SendBindingArgs => {
  const source = thread as ExtendedChatThread & {
    connectionId?: string | null;
    supportedEndpoint?: string | null;
  };
  return {
    ...(source.connectionId ? { connectionId: source.connectionId } : {}),
    ...(source.supportedEndpoint ? { supportedEndpoint: source.supportedEndpoint } : {}),
  };
};

/**
 * Re-applies the resolved send binding to every loaded thread. A provider with
 * one verified spawn connection binds it; zero connections clear the binding;
 * several connections stay unset until the composer lets the user pick one.
 */
export const withResolvedSendBindings = (
  map: Record<string, ExtendedChatThread>,
  connections: readonly ConnectionSummary[],
  selections: Record<string, string>
): Record<string, ExtendedChatThread> => {
  let changed = false;
  const next: Record<string, ExtendedChatThread> = {};
  for (const [id, thread] of Object.entries(map)) {
    const selected = selections[id];
    const candidates = resolveConnectionBinding(thread.provider, connections).candidates;
    const binding = selected
      ? bindingForConnection(thread.provider, connections, selected)
      : candidates.length === 1
        ? { connectionId: candidates[0].connectionId, supportedEndpoint: candidates[0].supportedEndpoint }
        : null;
    const connectionId = binding?.connectionId ?? null;
    const supportedEndpoint = binding?.supportedEndpoint ?? null;
    if (
      (thread.connectionId ?? null) !== connectionId ||
      (thread.supportedEndpoint ?? null) !== supportedEndpoint
    ) {
      next[id] = { ...thread, connectionId, supportedEndpoint };
      changed = true;
    } else {
      next[id] = thread;
    }
  }
  return changed ? next : map;
};

export interface UseChatConnectionBindingsOptions {
  threadsMap?: Record<string, ExtendedChatThread>;
  setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, ExtendedChatThread>>>;
  isMountedRef?: MutableRefObject<boolean>;
}

export function useChatConnectionBindings({
  threadsMap: _ignoredThreadsMap,
  setThreadsMap,
  isMountedRef,
}: UseChatConnectionBindingsOptions) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  // Chosen connection per thread, kept apart from the thread object because the
  // native thread schema does not carry extra fields across a reload.
  const [threadConnections, setThreadConnections] = useState<Record<string, string>>({});

  const connectionsRef = useRef<ConnectionSummary[]>(connections);
  connectionsRef.current = connections;
  const threadConnectionsRef = useRef<Record<string, string>>(threadConnections);
  threadConnectionsRef.current = threadConnections;

  const loadConnections = async (): Promise<ConnectionSummary[]> => {
    const list = await listConnections();
    connectionsRef.current = list;
    if (!isMountedRef || isMountedRef.current) setConnections(list);
    return list;
  };

  // The shared registry is read once per chat surface. A browser build returns
  // an empty list, so nothing is bound without a verified native connection.
  useEffect(() => {
    void loadConnections();
  }, []);

  // When the registry, the user's choice, or a thread's own fields change,
  // re-apply the binding so the in-memory thread always mirrors the verified
  // connection. A chosen connection that stopped verifying is dropped.
  useEffect(() => {
    if (connections.length === 0) return;
    setThreadsMap((prev) =>
      withResolvedSendBindings(prev, connections, threadConnections)
    );
  }, [connections, threadConnections, setThreadsMap]);

  const resolveThreadSendBinding = (
    thread: ExtendedChatThread
  ): ThreadSendBinding | null => {
    const selected = threadConnectionsRef.current[thread.id];
    if (selected) {
      const chosen = bindingForConnection(thread.provider, connectionsRef.current, selected);
      if (chosen) return chosen;
    }
    return resolveConnectionBinding(thread.provider, connectionsRef.current).binding;
  };

  const threadWithResolvedBinding = (thread: ExtendedChatThread): ExtendedChatThread => {
    const binding = resolveThreadSendBinding(thread);
    return {
      ...thread,
      connectionId: binding?.connectionId ?? null,
      supportedEndpoint: binding?.supportedEndpoint ?? null,
    };
  };

  const selectThreadConnection = async (threadId: string, connectionId: string | null) => {
    if (connectionId && connectionsRef.current.length === 0) await loadConnections();
    const next = { ...threadConnectionsRef.current };
    if (connectionId) next[threadId] = connectionId;
    else delete next[threadId];
    threadConnectionsRef.current = next;
    setThreadConnections(next);
  };

  return {
    connections,
    threadConnections,
    connectionsRef,
    threadConnectionsRef,
    loadConnections,
    resolveThreadSendBinding,
    threadWithResolvedBinding,
    selectThreadConnection,
  };
}
