import { useEffect, useRef } from 'react';
import type React from 'react';
import { listen } from '@tauri-apps/api/event';
import { OPEN_SETTINGS_EVENT, openSettingsTab } from '../../lib/settingsNav';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT } from '../../lib/terminalLinkNav';
import { subscriptionQuotaManager } from '../../lib/quota/quotaManager';
import {
  canonicalQuotaProviderId,
  collectExhaustedModelWindows,
} from '../../lib/quota/modelQuota';
import { PROVIDER_LABELS, type ProviderQuotaStatus } from '../../lib/quota/types';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  type OpenRightDockSubagentDetail,
} from '../../lib/subagentNav';
import { sendUiAck, type UiBusRequestPayload } from '../../lib/operator/executor/ui-bus';
import { registerToastNavigator, toast } from '../../lib/toast';
import { closeResidualProviderProcesses, invokeCommand } from '../../lib/ipc';
import { accountVaultStore } from '../../lib/accounts/accountVaultStore';
import { voiceSessionStore } from '../../lib/operator/voice/voiceSessionStore';
import { voiceTurnArbitrator } from '../../lib/operator/voice/turnArbitrator';
import { ttsNarrator } from '../../lib/operator/ttsNarrator';
import { normalizeForVoiceSpeech } from '../../lib/operator/voice/speechProsody';
import { loadOperatorConfig } from '../../lib/operator/operatorConfig';
import type { WorkMode } from '../Sidebar';
import type {
  AgentProfile,
  AutoSwitchExecutedEvent,
  AutoSwitchStatusEvent,
  PendingAutoSwitchConfirmation,
} from '../../types';

export interface UseAppGlobalEventsOptions {
  setWorkMode: (mode: WorkMode) => void;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRoutinesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedAgentThreadId?: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  setAgentViewMode?: React.Dispatch<
    React.SetStateAction<'chats' | 'settings' | 'memory' | 'skills' | 'starters' | 'playbooks' | 'audit'>
  >;
  setRightDockVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCommandPaletteOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  onAddWorkspace?: (targetThreadId?: string) => Promise<void> | void;
  loadBootstrap: () => Promise<void>;
  loadThreads: () => Promise<void>;
  setAgents: React.Dispatch<React.SetStateAction<AgentProfile[]>>;
  selectedAgentId: string | null;
}

export function useAppGlobalEvents({
  setWorkMode,
  setSettingsOpen,
  setRoutinesOpen,
  setSelectedWorkspaceId,
  setSelectedAgentId,
  setSelectedAgentThreadId,
  setSelectedThreadId,
  setAgentViewMode,
  setRightDockVisible,
  setIsCommandPaletteOpen,
  onAddWorkspace,
  loadBootstrap,
  loadThreads,
  setAgents,
  selectedAgentId,
}: UseAppGlobalEventsOptions): void {
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, [setSettingsOpen]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let tauriMinimized = false;
    const applyWindowState = (focusedOverride?: boolean) => {
      const hidden = document.visibilityState === 'hidden' || tauriMinimized;
      const focused =
        focusedOverride !== undefined
          ? focusedOverride
          : typeof document.hasFocus === 'function'
            ? document.hasFocus()
            : true;
      const nextState = hidden ? 'minimized' : focused ? 'focused' : 'blurred';
      if (document.documentElement.getAttribute('data-window-state') !== nextState) {
        document.documentElement.setAttribute('data-window-state', nextState);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tauriMinimized = false;
      applyWindowState();
    };
    const onFocus = () => {
      tauriMinimized = false;
      applyWindowState(true);
    };
    const onBlur = () => applyWindowState(false);

    applyWindowState();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    let unlistenTauri: (() => void) | undefined;
    let cancelled = false;
    const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (host.__TAURI_INTERNALS__ || host.__TAURI__) {
      void listen<{ minimized?: boolean; focused?: boolean }>('kite:window-state', (ev) => {
        if (cancelled) return;
        tauriMinimized = Boolean(ev.payload?.minimized);
        applyWindowState(ev.payload?.focused);
      })
        .then((stop) => {
          if (cancelled) stop();
          else unlistenTauri = stop;
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      unlistenTauri?.();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    return registerToastNavigator({
      onNavigateAgent: (id) => {
        setSelectedAgentId(id);
        setAgentViewMode?.('chats');
        setWorkMode('agent');
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      onNavigateThread: (threadId, agentId) => {
        if (agentId) {
          setSelectedAgentId(agentId);
          setAgentViewMode?.('chats');
          if (setSelectedAgentThreadId) {
            setSelectedAgentThreadId(threadId);
          } else {
            setSelectedThreadId(threadId);
          }
          setWorkMode('agent');
        } else {
          setWorkMode('chat');
          setSelectedThreadId(threadId);
        }
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      onNavigateTerminal: (sessionId, workspaceId) => {
        if (workspaceId) {
          setSelectedWorkspaceId(workspaceId);
        }
        setWorkMode('code');
        window.dispatchEvent(
          new CustomEvent('kite:focus-terminal-session', {
            detail: { sessionId, workspaceId },
          })
        );
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      onNavigateMode: (m) => {
        setWorkMode(m);
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
    });
  }, [
    setSelectedAgentId,
    setSelectedAgentThreadId,
    setSelectedThreadId,
    setSelectedWorkspaceId,
    setAgentViewMode,
    setWorkMode,
    setSettingsOpen,
    setRoutinesOpen,
  ]);

  useEffect(() => {
    const handleNavigate = (e: Event) => {
      const custom = e as CustomEvent<WorkMode | { mode?: string }>;
      const raw =
        typeof custom.detail === 'string' ? custom.detail : custom.detail?.mode;
      // Operator view modes use surface names (agents/threads); the app uses its own.
      const modeAlias: Record<string, WorkMode> = {
        agents: 'agent',
        agent: 'agent',
        threads: 'chat',
        chat: 'chat',
        code: 'code',
      };
      const nextMode = raw ? modeAlias[raw] : undefined;
      if (nextMode) {
        setWorkMode(nextMode);
        setSettingsOpen(false);
      }
    };

    const handleSelectWorkspace = (e: Event) => {
      const custom = e as CustomEvent<string | { workspaceId?: string }>;
      const workspaceId =
        typeof custom.detail === 'string' ? custom.detail : custom.detail?.workspaceId;
      if (workspaceId) {
        setSelectedWorkspaceId(workspaceId);
      }
    };

    const handleSelectThread = (e: Event) => {
      const custom = e as CustomEvent<
        string | { threadId?: string; mode?: WorkMode; agentId?: string }
      >;
      const detail = custom.detail;
      const threadId = typeof detail === 'string' ? detail : detail?.threadId;
      const targetAgentId = typeof detail === 'object' ? detail?.agentId : undefined;
      const targetMode =
        typeof detail === 'object' && detail?.mode
          ? detail.mode
          : targetAgentId
            ? 'agent'
            : 'chat';
      if (targetAgentId && targetMode === 'agent') {
        setSelectedAgentId(targetAgentId);
        setAgentViewMode?.('chats');
        if (threadId) {
          if (setSelectedAgentThreadId) {
            setSelectedAgentThreadId(threadId);
          } else {
            setSelectedThreadId(threadId);
          }
        }
        setWorkMode('agent');
        setSettingsOpen(false);
        setRoutinesOpen(false);
        return;
      }
      if (targetAgentId) {
        setSelectedAgentId(targetAgentId);
        setAgentViewMode?.('chats');
      }
      if (threadId || targetAgentId) {
        if (threadId) {
          setSelectedThreadId(threadId);
        }
        setWorkMode(targetMode);
        setSettingsOpen(false);
        setRoutinesOpen(false);
      }
    };

    const handleOpenFilePreview = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenBrowserInDock = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null; url?: string }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenSubagentInDock = (e: Event) => {
      const custom = e as CustomEvent<OpenRightDockSubagentDetail>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenVoiceTranscriptInDock = () => {
      setRightDockVisible(true);
    };

    const handleOpenDiffsInDock = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleDockShortcutKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setRightDockVisible(true);
      }
    };

    const handleSpawnAgentTerminal = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setWorkMode('code');
      setSettingsOpen(false);
      setRoutinesOpen(false);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (!custom.detail) return;
      if (custom.detail.kind === 'navigate') {
        const targetMode = custom.detail.payload?.mode as WorkMode;
        if (targetMode && ['agent', 'code', 'chat'].includes(targetMode)) {
          setWorkMode(targetMode);
          setSettingsOpen(false);
          sendUiAck({
            reqId: custom.detail.reqId,
            ok: true,
            data: { mode: targetMode },
          });
        } else {
          sendUiAck({
            reqId: custom.detail.reqId,
            ok: false,
            reason: `Invalid mode: ${targetMode}`,
          });
        }
      }
    };

    const handleAddWorkspaceEvent = (e: Event) => {
      if (onAddWorkspace) {
        const custom = e as CustomEvent<{ threadId?: string } | undefined>;
        void onAddWorkspace(
          typeof custom.detail?.threadId === 'string' ? custom.detail.threadId : undefined
        );
      }
    };

    const handleOpenCommandPalette = () => {
      if (setIsCommandPaletteOpen) {
        setIsCommandPaletteOpen(true);
      }
    };

    window.addEventListener('kite:navigate-mode', handleNavigate);
    window.addEventListener('kite:select-workspace', handleSelectWorkspace);
    window.addEventListener('kite:select-thread', handleSelectThread);
    window.addEventListener('kite:open-right-dock-file', handleOpenFilePreview);
    window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagentInDock);
    window.addEventListener('kite:open-voice-transcript', handleOpenVoiceTranscriptInDock);
    window.addEventListener('kite:open-right-dock-diffs', handleOpenDiffsInDock);
    window.addEventListener('kite:open-diffs', handleOpenDiffsInDock);
    window.addEventListener('keydown', handleDockShortcutKeyDown);
    window.addEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);
    window.addEventListener('kite:op-request', handleOpRequest);
    window.addEventListener('kite:add-workspace', handleAddWorkspaceEvent);
    window.addEventListener('kite:open-command-palette', handleOpenCommandPalette);

    return () => {
      window.removeEventListener('kite:navigate-mode', handleNavigate);
      window.removeEventListener('kite:select-workspace', handleSelectWorkspace);
      window.removeEventListener('kite:select-thread', handleSelectThread);
      window.removeEventListener('kite:open-right-dock-file', handleOpenFilePreview);
      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);
      window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagentInDock);
      window.removeEventListener('kite:open-right-dock-diffs', handleOpenDiffsInDock);
      window.removeEventListener('kite:open-diffs', handleOpenDiffsInDock);
      window.removeEventListener('keydown', handleDockShortcutKeyDown);
      window.removeEventListener('kite:open-voice-transcript', handleOpenVoiceTranscriptInDock);
      window.removeEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);
      window.removeEventListener('kite:op-request', handleOpRequest);
      window.removeEventListener('kite:add-workspace', handleAddWorkspaceEvent);
      window.removeEventListener('kite:open-command-palette', handleOpenCommandPalette);
    };
  }, [
    setWorkMode,
    setSettingsOpen,
    setSelectedWorkspaceId,
    setSelectedAgentId,
    setSelectedAgentThreadId,
    setSelectedThreadId,
    setAgentViewMode,
    setRoutinesOpen,
    setRightDockVisible,
    onAddWorkspace,
    setIsCommandPaletteOpen,
  ]);

  useEffect(() => {
    const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (!host.__TAURI_INTERNALS__ && !host.__TAURI__) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const timers = new Set<number>();
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ sessionId?: string; engine?: string; alias?: string | null }>(
          'dispatch-open-pane',
          (event) => {
            const sessionId = event.payload?.sessionId;
            if (!sessionId) return;
            setWorkMode('code');
            setSettingsOpen(false);
            setRoutinesOpen(false);
            const timer = window.setTimeout(() => {
              timers.delete(timer);
              const alias = event.payload?.alias || undefined;
              window.dispatchEvent(
                new CustomEvent('kite:spawn-agent-terminal', {
                  detail: {
                    sessionId,
                    engine: event.payload?.engine || undefined,
                    title: alias,
                    agentName: alias,
                    attachOnly: true,
                  },
                })
              );
            }, 200);
            timers.add(timer);
          }
        )
      )
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [setWorkMode, setSettingsOpen, setRoutinesOpen]);

  useEffect(() => {
    const handleAgentsChanged = () => {
      void loadBootstrap();
    };
    const handleAgentDeleted = (e: Event) => {
      const custom = e as CustomEvent<{ agentId: string }>;
      const deletedId = custom.detail?.agentId;
      if (deletedId) {
        setAgents((prev) => {
          const remaining = prev.filter((a) => a.id !== deletedId);
          if (selectedAgentId === deletedId) {
            setSelectedAgentId(remaining[0]?.id ?? null);
          }
          return remaining;
        });
      } else {
        void loadBootstrap();
      }
    };
    window.addEventListener('kite:agents-changed', handleAgentsChanged);
    window.addEventListener('kite:agent-deleted', handleAgentDeleted);
    return () => {
      window.removeEventListener('kite:agents-changed', handleAgentsChanged);
      window.removeEventListener('kite:agent-deleted', handleAgentDeleted);
    };
  }, [loadBootstrap, selectedAgentId, setAgents, setSelectedAgentId]);

  useEffect(() => {
    const handleThreadsChanged = () => {
      void loadThreads();
    };
    window.addEventListener('kite:threads-changed', handleThreadsChanged);
    return () => window.removeEventListener('kite:threads-changed', handleThreadsChanged);
  }, [loadThreads]);

  const confirmationToastsRef = useRef<Map<string, string>>(new Map());
  const loadThreadsRef = useRef(loadThreads);
  loadThreadsRef.current = loadThreads;

  useEffect(() => {
    const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (!host.__TAURI_INTERNALS__ && !host.__TAURI__) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const register = (stop: () => void) => {
      if (cancelled) {
        stop();
      } else {
        unlisteners.push(stop);
      }
    };

    const runConfirmFromToast = async (
      payload: PendingAutoSwitchConfirmation,
      fallbackModel: string | undefined,
      activeToastId: string
    ) => {
      toast.dismiss(activeToastId);
      confirmationToastsRef.current.delete(payload.confirmationId);

      const confirmOpts = {
        confirmationId: payload.confirmationId,
        ...(fallbackModel ? { selectedModelId: fallbackModel } : {}),
        ...(payload.reason === 'busy_terminals_ask' ? { forceBusy: true } : {}),
      };

      const res = await accountVaultStore.confirmPendingAutoSwitch(
        confirmOpts,
        payload.provider
      );

      if (res.success) {
        return;
      }

      if (res.code === 'PROVIDER_BUSY' && res.canCloseProcesses) {
        let cleanupToastId = '';
        cleanupToastId = toast.action(
          'Cierra los procesos residuales de Antigravity para completar el cambio',
          {
            title: 'Cerrar procesos Antigravity',
            onClick: async () => {
              if (cleanupToastId) {
                toast.dismiss(cleanupToastId);
              }
              const closeRes = await closeResidualProviderProcesses(
                payload.provider || 'antigravity'
              );
              if (!closeRes?.success) {
                toast.error(
                  'No se pudieron cerrar los procesos de Antigravity',
                  closeRes?.error ||
                    'Cierra el IDE manualmente y confirma desde Notificaciones.'
                );
                return;
              }
              const retryRes = await accountVaultStore.confirmPendingAutoSwitch(
                confirmOpts,
                payload.provider
              );
              if (!retryRes.success) {
                toast.error(
                  'No se pudo confirmar el cambio automático',
                  retryRes.error
                );
              }
            },
          },
          res.error ||
            'Quedaron procesos secundarios abiertos bloqueando el cambio de sesión.',
          { duration: 15000 }
        );
        return;
      }

      if (res.baseAppTitles?.length) {
        toast.error(
          'Cierra el IDE antes de cambiar de cuenta',
          `${res.baseAppTitles.join(', ')}${res.error ? ` — ${res.error}` : ''}`
        );
        return;
      }

      toast.error(
        'No se pudo confirmar el cambio automático',
        res.error || 'Abre Notificaciones para intentarlo de nuevo.'
      );
    };

    void Promise.resolve()
      .then(async () => {
        const stopConfirm = await listen<PendingAutoSwitchConfirmation>(
          'kite://auto-switch-confirmation',
          (event) => {
            const payload = event?.payload;
            if (!payload?.confirmationId) return;

            accountVaultStore.applyPendingConfirmationEvent(payload);
            window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));

            const existingToast = confirmationToastsRef.current.get(
              payload.confirmationId
            );
            if (existingToast) {
              toast.dismiss(existingToast);
            }

            const fallbackModel =
              payload.suggestedFallbackModel ||
              payload.availableTargetModels?.[0] ||
              undefined;
            const fromLabel =
              payload.fromAccountLabel || payload.fromEmail || 'cuenta actual';
            const toLabel =
              payload.toAccountLabel || payload.toEmail || 'otra cuenta';

            const title =
              payload.reason === 'busy_terminals_ask'
                ? `Terminales activas bloquean cambio de «${fromLabel}» a «${toLabel}»`
                : `Cuota agotada en «${fromLabel}» — cambiar a «${toLabel}»`;

            let description: string;
            if (payload.reason === 'busy_terminals_ask') {
              const count = payload.busySessions?.length || 1;
              description = `${count} sesión(es) ocupada(s). Confirma aquí o abre Notificaciones para revisar modelos.`;
            } else if (fallbackModel && payload.requestedModel) {
              const planInfo = payload.toPlanName ? ` (${payload.toPlanName})` : '';
              description = `«${payload.requestedModel}» no está disponible en ${toLabel}${planInfo}. Se usará «${fallbackModel}» (abre Notificaciones para elegir otro modelo).`;
            } else if (payload.availableTargetModels?.length) {
              description = `Abre Notificaciones para elegir modelo en ${toLabel} o confirma ahora.`;
            } else {
              description = `Confirma el cambio automático hacia ${toLabel}.`;
            }

            const buttonTitle =
              payload.reason === 'busy_terminals_ask'
                ? fallbackModel
                  ? `Confirmar y usar «${fallbackModel}»`
                  : 'Confirmar cambio'
                : fallbackModel
                  ? `Cambiar y usar «${fallbackModel}»`
                  : 'Confirmar cambio';

            let createdToastId = '';
            createdToastId = toast.action(
              title,
              {
                title: buttonTitle,
                onClick: () => runConfirmFromToast(payload, fallbackModel, createdToastId),
              },
              description,
              { duration: 30000 }
            );
            if (createdToastId) {
              confirmationToastsRef.current.set(
                payload.confirmationId,
                createdToastId
              );
            }
          }
        );
        register(stopConfirm);

        const stopExecuted = await listen<AutoSwitchExecutedEvent>(
          'kite://auto-switch-executed',
          (event) => {
            const payload = event?.payload;
            if (!payload?.toAccountId) return;

            if (payload.confirmationId) {
              const tracked = confirmationToastsRef.current.get(
                payload.confirmationId
              );
              if (tracked) {
                toast.dismiss(tracked);
                confirmationToastsRef.current.delete(payload.confirmationId);
              }
            }

            accountVaultStore.handleAutoSwitchExecutedEvent(payload);
            if (payload.resumedThreadId || payload.threadId) {
              void loadThreadsRef.current();
            }
            window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));

            const targetName = payload.toAccountLabel || payload.toAccountId;
            toast.success(
              `Cuenta cambiada automáticamente a ${targetName}`,
              payload.appliedModel ? `Modelo activo: ${payload.appliedModel}` : undefined
            );
          }
        );
        register(stopExecuted);

        const stopStatus = await listen<AutoSwitchStatusEvent>(
          'kite://auto-switch-status',
          (event) => {
            const payload = event?.payload;
            if (!payload?.status) return;
            accountVaultStore.applyAutoSwitchStatusEvent(
              payload.provider || 'antigravity',
              payload.status
            );
          }
        );
        register(stopStatus);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      for (const stop of unlisteners) {
        stop();
      }
      for (const toastId of confirmationToastsRef.current.values()) {
        toast.dismiss(toastId);
      }
      confirmationToastsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const alertedQuotaKeys = new Set<string>();
    const initialProviderUpdates = new Map<string, number>();
    let firstSubscribePass = true;

    const notifyModelQuotaExhausted = (
      providerId: string,
      displayName: string,
      windowName: string,
      resetsAt?: string | null
    ) => {
      const canon = canonicalQuotaProviderId(providerId) || providerId;
      const key = `${canon}|${windowName}|${resetsAt ?? 'none'}`;
      if (alertedQuotaKeys.has(key)) return;
      alertedQuotaKeys.add(key);

      const providerLabel = PROVIDER_LABELS[canon] || displayName || canon;
      const resetNote = resetsAt ? ` Reinicio: ${resetsAt}.` : '';
      toast.action(
        `Cuota agotada: ${windowName}`,
        {
          title: 'Ver cuotas',
          onClick: () => openSettingsTab('quotas', canon),
        },
        `${providerLabel} llegó al 0% en este modelo/pool.${resetNote} Cambiá de modelo o revisá tus cuentas.`,
        { duration: 15000 }
      );
    };

    const unsubQuota = subscriptionQuotaManager.subscribe(
      (quotas: Record<string, ProviderQuotaStatus>) => {
        if (firstSubscribePass) {
          firstSubscribePass = false;
          for (const [prov, status] of Object.entries(quotas)) {
            if (status?.lastUpdatedMs) {
              initialProviderUpdates.set(prov, status.lastUpdatedMs);
            }
          }
          return;
        }
        for (const hit of collectExhaustedModelWindows(quotas)) {
          const prevTs = initialProviderUpdates.get(hit.providerId) ?? 0;
          const currentTs = quotas[hit.providerId]?.lastUpdatedMs ?? 0;
          if (currentTs > prevTs || prevTs === 0) {
            initialProviderUpdates.set(hit.providerId, currentTs || Date.now());
            notifyModelQuotaExhausted(
              hit.providerId,
              hit.displayName,
              hit.window.name,
              hit.window.resetsAt
            );
          }
        }
      }
    );

    const handleRuntimeUsageLimit = (e: Event) => {
      const detail = (e as CustomEvent<{
        provider?: string | null;
        message?: string;
        resetAtUnixMs?: number | null;
      }>).detail;
      if (!detail) return;
      const canon = canonicalQuotaProviderId(detail.provider);
      const targets = canon ? [canon] : undefined;
      void subscriptionQuotaManager.fetchAll(true, targets);

      const key = `runtime|${canon || 'provider'}|${detail.message || ''}`;
      if (!alertedQuotaKeys.has(key)) {
        alertedQuotaKeys.add(key);
        const label = (canon && PROVIDER_LABELS[canon]) || canon || 'el proveedor actual';
        toast.action(
          `Cuota agotada en ${label}`,
          {
            title: 'Ver cuotas',
            onClick: () => openSettingsTab('quotas', canon || undefined),
          },
          detail.message || 'El modelo o proveedor actual alcanzó su límite de uso.',
          { duration: 15000 }
        );
      }
    };
    window.addEventListener('kite:usage-limit-detected', handleRuntimeUsageLimit);

    let cancelled = false;
    let stopExhausted: (() => void) | null = null;
    void Promise.resolve()
      .then(async () => {
        const stop = await listen<{
          providerId: string;
          displayName: string;
          windowName: string;
          resetsAt?: string | null;
        }>('kite://model-quota-exhausted', (event) => {
          const p = event?.payload;
          if (!p?.windowName) return;
          window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));
          notifyModelQuotaExhausted(p.providerId, p.displayName, p.windowName, p.resetsAt);
        });
        if (cancelled) {
          stop();
        } else {
          stopExhausted = stop;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubQuota();
      window.removeEventListener('kite:usage-limit-detected', handleRuntimeUsageLimit);
      stopExhausted?.();
    };
  }, []);

  useEffect(() => {
    interface ThreadCreatedPayload {
      threadId?: string;
      open?: boolean;
    }

    interface AgentAnnouncePayload {
      source?: string;
      agentId?: string;
      agentName?: string;
      status?: string;
      message?: string;
      summary?: string;
      threadId?: string | null;
      threadTitle?: string | null;
      workspaceId?: string | null;
      failed?: boolean;
      alreadyPersisted?: boolean;
    }

    const handleAgentAnnounce = (payload: AgentAnnouncePayload | null | undefined) => {
      if (!payload || typeof payload !== 'object') return;
      const {
        source,
        agentId,
        agentName,
        status,
        message,
        summary,
        threadId,
        threadTitle,
        workspaceId,
        failed,
        alreadyPersisted,
      } = payload;
      const actor =
        (agentName || '').trim() ||
        (source === 'routine'
          ? 'Routine'
          : source === 'autopilot'
            ? 'AutoPilot'
            : 'Agent');
      const isError =
        Boolean(failed) ||
        status === 'failed' ||
        status === 'error' ||
        status === 'stuck';
      const rawDetail = (summary || message || '').trim();
      const title =
        (message || '').trim() ||
        (isError ? `${actor} needs attention` : `${actor} finished`);

      if (alreadyPersisted) {
        window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));
      } else if (typeof invokeCommand === 'function') {
        void Promise.resolve(
          invokeCommand('notifications_report_attention', {
            payload: {
              kind: isError ? 'error' : 'settled',
              source: agentId ? 'agentChat' : 'terminal',
              module: agentId ? 'agent' : 'code',
              profileId: agentId || undefined,
              actorName: actor,
              threadId: threadId || undefined,
              ...(threadTitle ? { threadTitle } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              title,
              body: rawDetail || title,
              sessionId: threadId || agentId || 'agent',
            },
          })
        )
          .then(() => {
            window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));
          })
          .catch((err) => {
            console.warn('[useAppGlobalEvents] notifications_report_attention failed:', err);
          });
      }

      const vs = voiceSessionStore.getSnapshot();
      const isVoiceActive = vs.phase === 'active' || vs.phase === 'starting';
      if (isVoiceActive && !vs.speakerMuted) {
        const spoken = normalizeForVoiceSpeech(rawDetail || title, { maxSentences: 2 });
        if (spoken) {
          const opCfg = loadOperatorConfig();
          voiceTurnArbitrator.requestProactiveSpeech(
            spoken,
            (text) => {
              void ttsNarrator
                .speak(text, {
                  voiceName: opCfg.persona?.voice || 'Ara',
                  rate: opCfg.ttsRate || 1.0,
                  lang: opCfg.persona?.language === 'en' ? 'en-US' : 'es-ES',
                })
                .catch((err) => {
                  console.warn('[useAppGlobalEvents] Failed to speak agent announcement:', err);
                });
            },
            Date.now(),
            { role: actor, summary: spoken, foldable: true }
          );
        }
      }
    };

    const onWindowAnnounce = (event: Event) => {
      const custom = event as CustomEvent<AgentAnnouncePayload>;
      handleAgentAnnounce(custom.detail);
    };

    window.addEventListener('kite:agent-announce', onWindowAnnounce);

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const register = (stop: () => void) => {
      if (cancelled) stop();
      else unlisteners.push(stop);
    };

    void Promise.resolve()
      .then(async () => {
        const stopThreadCreated = await listen<ThreadCreatedPayload>(
          'chat:thread-created',
          (event) => {
            const payload = event?.payload;
            void loadThreadsRef.current();
            window.dispatchEvent(new CustomEvent('kite:threads-changed'));
            if (payload?.open && payload?.threadId) {
              setWorkMode('chat');
              setSelectedThreadId(payload.threadId);
              setSettingsOpen(false);
              setRoutinesOpen(false);
            }
          }
        );
        register(stopThreadCreated);

        const stopAnnounce = await listen<AgentAnnouncePayload>(
          'kite:agent-announce',
          (event) => {
            handleAgentAnnounce(event?.payload);
          }
        );
        register(stopAnnounce);
      })
      .catch((err) => {
        const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
        if (host.__TAURI_INTERNALS__ || host.__TAURI__) {
          console.warn('[useAppGlobalEvents] Failed to subscribe to thread/announce events:', err);
        }
      });

    return () => {
      cancelled = true;
      window.removeEventListener('kite:agent-announce', onWindowAnnounce);
      for (const stop of unlisteners) {
        stop();
      }
    };
  }, [setWorkMode, setSelectedAgentThreadId, setSelectedThreadId, setSelectedAgentId, setAgentViewMode, setSettingsOpen, setRoutinesOpen]);
}
