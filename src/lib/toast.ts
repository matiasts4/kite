import type { ReactNode } from 'react';
import { sileo, Toaster as SileoToaster } from 'sileo';
import type { SileoOptions, SileoPosition, SileoState, SileoButton } from 'sileo';
import type { NotificationRecord } from '../types';
import './toast.css';

export interface ToastNavigationHandlers {
  onNavigateAgent?: (agentId: string) => void;
  onNavigateThread?: (threadId: string, agentId?: string | null) => void;
  onNavigateMode?: (mode: 'agent' | 'code' | 'chat') => void;
}

let activeNavigator: ToastNavigationHandlers | null = null;

/**
 * Register global navigation handlers so that toasts can trigger in-app navigation
 * when their action buttons are clicked.
 */
export function registerToastNavigator(handlers: ToastNavigationHandlers | null): () => void {
  activeNavigator = handlers;
  return () => {
    if (activeNavigator === handlers) {
      activeNavigator = null;
    }
  };
}

/**
 * Default visual configuration for Kite Toasts
 */
const DEFAULT_FILL = '#161922'; // Obsidian capsule matching Kite dark cards

export interface KiteToastOptions extends Omit<SileoOptions, 'title'> {
  title?: string;
  fill?: string;
}

export interface PromiseToastMessages<T = unknown> {
  loading: string | SileoOptions;
  success: string | SileoOptions | ((data: T) => SileoOptions);
  error: string | SileoOptions | ((err: unknown) => SileoOptions);
}

function resolveOptions(
  title: string,
  description?: ReactNode | string,
  options?: KiteToastOptions
): SileoOptions {
  return {
    title,
    description,
    fill: DEFAULT_FILL,
    duration: 4500,
    ...options,
  };
}

/**
 * Formats human-readable actor name from NotificationRecord
 */
function getNotificationActor(rec: NotificationRecord): string {
  if (rec.routineId) return 'Routine Automation';
  if (rec.target?.source === 'agentChat') return 'Agent chat';
  if (rec.target?.source === 'codeThread') return 'Code thread';
  if (rec.target?.source === 'codeTerminal') return 'Terminal runner';
  if (rec.target?.source === 'task') return 'Background task';
  return 'Kite Agent';
}

/**
 * Formats detail description for a notification record
 */
function getNotificationDetail(rec: NotificationRecord): string {
  const kind = rec.kind;
  if (!kind) return 'System notice received.';

  if (kind.kind === 'needsInput') {
    switch (kind.requestKind) {
      case 'toolApproval':
        return 'Waiting for your approval to proceed.';
      case 'question':
        return 'The agent has a question for you.';
      default:
        return 'Waiting for your input.';
    }
  }

  if (kind.kind === 'settled') {
    if (kind.outcome === 'failed') return 'Agent execution stopped with errors.';
    if (kind.outcome === 'cancelled') return 'Operation was cancelled.';
    return 'Execution completed successfully.';
  }

  return 'Agent status updated.';
}

/**
 * Kite Toast API
 */
export const toast = {
  /**
   * Display a success toast
   */
  success(title: string, description?: ReactNode | string, options?: KiteToastOptions): string {
    return sileo.success(resolveOptions(title, description, options));
  },

  /**
   * Display an error toast
   */
  error(title: string, description?: ReactNode | string, options?: KiteToastOptions): string {
    return sileo.error(
      resolveOptions(title, description, {
        duration: 6000,
        ...options,
      })
    );
  },

  /**
   * Display a warning toast
   */
  warning(title: string, description?: ReactNode | string, options?: KiteToastOptions): string {
    return sileo.warning(
      resolveOptions(title, description, {
        duration: 5000,
        ...options,
      })
    );
  },

  /**
   * Display an info toast
   */
  info(title: string, description?: ReactNode | string, options?: KiteToastOptions): string {
    return sileo.info(resolveOptions(title, description, options));
  },

  /**
   * Display an interactive action toast
   */
  action(
    title: string,
    button: SileoButton,
    description?: ReactNode | string,
    options?: KiteToastOptions
  ): string {
    return sileo.action({
      ...resolveOptions(title, description, options),
      button,
    });
  },

  /**
   * Display a morphing promise toast that automatically transitions through loading, success, and error
   */
  promise<T>(
    promise: Promise<T> | (() => Promise<T>),
    messages: PromiseToastMessages<T>,
    options?: KiteToastOptions
  ): Promise<T> {
    const loadingOpts: SileoOptions =
      typeof messages.loading === 'string'
        ? resolveOptions(messages.loading, undefined, options)
        : { fill: DEFAULT_FILL, ...messages.loading };

    const rawSuccess = messages.success;
    const successOpts =
      typeof rawSuccess === 'function'
        ? (data: T) => ({ fill: DEFAULT_FILL, ...rawSuccess(data) })
        : typeof rawSuccess === 'string'
        ? resolveOptions(rawSuccess, undefined, options)
        : { fill: DEFAULT_FILL, ...rawSuccess };

    const rawError = messages.error;
    const errorOpts =
      typeof rawError === 'function'
        ? (err: unknown) => ({ fill: DEFAULT_FILL, ...rawError(err) })
        : typeof rawError === 'string'
        ? resolveOptions(rawError, undefined, options)
        : { fill: DEFAULT_FILL, ...rawError };

    return sileo.promise(promise, {
      loading: loadingOpts,
      success: successOpts,
      error: errorOpts,
      position: options?.position,
    });
  },

  /**
   * Copy text to clipboard and trigger a confirmation toast
   */
  async copy(textToCopy: string, customLabel?: string): Promise<boolean> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(textToCopy);
      }
      toast.success(
        customLabel || 'Copied to clipboard',
        textToCopy.length > 60 ? `${textToCopy.slice(0, 57)}...` : undefined,
        { duration: 2500 }
      );
      return true;
    } catch {
      toast.error('Failed to copy', 'Clipboard write permission was denied.');
      return false;
    }
  },

  /**
   * Trigger an ambient notification toast for an agent approval request
   */
  agentApproval(rec: NotificationRecord, onAction?: () => void): string {
    const actor = getNotificationActor(rec);
    const detail = getNotificationDetail(rec);

    const handleNavigate = () => {
      if (onAction) {
        onAction();
        return;
      }
      const targetThreadId = rec.target?.source === 'codeThread' ? rec.target.id : rec.runId;
      if (activeNavigator?.onNavigateThread && targetThreadId) {
        activeNavigator.onNavigateThread(targetThreadId, rec.profileId);
      } else if (rec.target?.source === 'agentChat' && rec.profileId && activeNavigator?.onNavigateAgent) {
        activeNavigator.onNavigateAgent(rec.profileId);
      } else if (activeNavigator?.onNavigateMode) {
        activeNavigator.onNavigateMode('code');
      }
    };

    return sileo.action({
      title: `${actor}: Approval Required`,
      description: detail,
      fill: DEFAULT_FILL,
      duration: null, // Persistent until attended
      button: {
        title: 'Review',
        onClick: handleNavigate,
      },
    });
  },

  /**
   * Trigger an ambient notification toast for an agent run completion
   */
  agentSettled(rec: NotificationRecord, onView?: () => void): string {
    const actor = getNotificationActor(rec);
    const detail = getNotificationDetail(rec);
    const isError = rec.kind?.outcome === 'failed';

    const handleView = () => {
      if (onView) {
        onView();
        return;
      }
      const targetThreadId = rec.target?.source === 'codeThread' ? rec.target.id : rec.runId;
      if (activeNavigator?.onNavigateThread && targetThreadId) {
        activeNavigator.onNavigateThread(targetThreadId, rec.profileId);
      } else if (rec.target?.source === 'agentChat' && rec.profileId && activeNavigator?.onNavigateAgent) {
        activeNavigator.onNavigateAgent(rec.profileId);
      } else if (activeNavigator?.onNavigateMode) {
        activeNavigator.onNavigateMode('code');
      }
    };

    if (isError) {
      return sileo.error({
        title: `${actor}: Attention Required`,
        description: detail,
        fill: DEFAULT_FILL,
        duration: 7000,
        button: {
          title: 'Inspect',
          onClick: handleView,
        },
      });
    }

    return sileo.success({
      title: `${actor}: Completed`,
      description: detail,
      fill: DEFAULT_FILL,
      duration: 5000,
      button: {
        title: 'Open',
        onClick: handleView,
      },
    });
  },

  /**
   * Dismiss a specific toast by its ID
   */
  dismiss(id: string): void {
    sileo.dismiss(id);
  },

  /**
   * Clear all toasts or toasts at a specific position
   */
  clear(position?: SileoPosition): void {
    sileo.clear(position);
  },
};

export { SileoToaster as Toaster, sileo };
export type { SileoOptions, SileoPosition, SileoState, SileoButton };
