import { createElement, type ReactNode } from 'react';
import { sileo, Toaster as SileoToaster } from 'sileo';
import type { SileoOptions, SileoPosition, SileoState, SileoButton } from 'sileo';
import type { NotificationRecord } from '../types';
import {
  getNotificationToastContent,
  resolveNotificationModule,
  type NotificationDisplayLookups,
} from './notifications/presentation';
import './toast.css';

export const APPROVAL_TOAST_DURATION_MS = 12_000;
const KITE_TOAST_ROUNDNESS = 12;

const APPROVAL_SHIELD_ICON = createElement(
  'svg',
  {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  createElement('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
  createElement('path', { d: 'M12 8v4' }),
  createElement('path', { d: 'M12 16h.01' })
);

export interface ToastNavigationHandlers {
  onNavigateAgent?: (agentId: string) => void;
  onNavigateThread?: (threadId: string, agentId?: string | null) => void;
  onNavigateTerminal?: (sessionId: string, workspaceId?: string | null) => void;
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
 * Default fallback background color when theme tokens are unavailable
 */
const DEFAULT_FILL = '#161922';

function resolveToastFill(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return DEFAULT_FILL;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const rootPlate = rootStyle.getPropertyValue('--menu-plate').trim();
  if (rootPlate) return rootPlate;
  const rootPane = rootStyle.getPropertyValue('--pane').trim();
  if (rootPane) return rootPane;

  if (document.body) {
    const bodyStyle = getComputedStyle(document.body);
    const bodyPlate = bodyStyle.getPropertyValue('--menu-plate').trim();
    if (bodyPlate) return bodyPlate;
    const bodyPane = bodyStyle.getPropertyValue('--pane').trim();
    if (bodyPane) return bodyPane;
  }
  return DEFAULT_FILL;
}

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
    fill: resolveToastFill(),
    roundness: KITE_TOAST_ROUNDNESS,
    duration: 4500,
    ...options,
  };
}

function navigateToNotificationTarget(rec: NotificationRecord): void {
  const source = rec.target?.source;
  const targetId = rec.target?.id;

  if (source === 'terminal' || source === 'codeTerminal') {
    if (activeNavigator?.onNavigateTerminal && targetId) {
      activeNavigator.onNavigateTerminal(targetId, rec.workspaceId);
    } else if (activeNavigator?.onNavigateMode) {
      activeNavigator.onNavigateMode('code');
    }
    return;
  }

  const targetThreadId = targetId || rec.runId;
  if (activeNavigator?.onNavigateThread && targetThreadId) {
    activeNavigator.onNavigateThread(targetThreadId, rec.profileId);
  } else if (source === 'agentChat' && rec.profileId && activeNavigator?.onNavigateAgent) {
    activeNavigator.onNavigateAgent(rec.profileId);
  } else if (activeNavigator?.onNavigateMode) {
    activeNavigator.onNavigateMode(resolveNotificationModule(rec) ?? 'code');
  }
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
        : { fill: resolveToastFill(), ...messages.loading };

    const rawSuccess = messages.success;
    const successOpts =
      typeof rawSuccess === 'function'
        ? (data: T) => ({ fill: resolveToastFill(), ...rawSuccess(data) })
        : typeof rawSuccess === 'string'
        ? resolveOptions(rawSuccess, undefined, options)
        : { fill: resolveToastFill(), ...rawSuccess };

    const rawError = messages.error;
    const errorOpts =
      typeof rawError === 'function'
        ? (err: unknown) => ({ fill: resolveToastFill(), ...rawError(err) })
        : typeof rawError === 'string'
        ? resolveOptions(rawError, undefined, options)
        : { fill: resolveToastFill(), ...rawError };

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
  agentApproval(
    rec: NotificationRecord,
    onAction?: () => void,
    lookups?: NotificationDisplayLookups
  ): string {
    const content = getNotificationToastContent(rec, lookups);
    let toastId = '';

    const handleNavigate = () => {
      if (toastId) {
        sileo.dismiss(toastId);
      }
      if (onAction) {
        onAction();
        return;
      }
      navigateToNotificationTarget(rec);
    };

    toastId = sileo.action({
      title: content.title,
      description: content.description,
      fill: resolveToastFill(),
      roundness: KITE_TOAST_ROUNDNESS,
      duration: APPROVAL_TOAST_DURATION_MS,
      autopilot: {
        expand: 120,
        collapse: APPROVAL_TOAST_DURATION_MS - 800,
      },
      icon: APPROVAL_SHIELD_ICON,
      styles: {
        badge: 'kite-toast-approval__badge',
        title: 'kite-toast-approval__title',
        description: 'kite-toast-approval__desc',
        button: 'kite-toast-approval__button',
      },
      button: {
        title: 'Review',
        onClick: handleNavigate,
      },
    });
    return toastId;
  },

  /**
   * Trigger an ambient notification toast for an agent run completion
   */
  agentSettled(
    rec: NotificationRecord,
    onView?: () => void,
    lookups?: NotificationDisplayLookups
  ): string {
    const content = getNotificationToastContent(rec, lookups);
    let toastId = '';

    const handleView = () => {
      if (toastId) {
        sileo.dismiss(toastId);
      }
      if (onView) {
        onView();
        return;
      }
      navigateToNotificationTarget(rec);
    };

    if (content.isError) {
      toastId = sileo.error({
        title: content.title,
        description: content.description,
        fill: resolveToastFill(),
        roundness: KITE_TOAST_ROUNDNESS,
        duration: 7000,
        button: {
          title: 'Inspect',
          onClick: handleView,
        },
      });
      return toastId;
    }

    toastId = sileo.success({
      title: content.title,
      description: content.description,
      fill: resolveToastFill(),
      roundness: KITE_TOAST_ROUNDNESS,
      duration: 5000,
      button: {
        title: 'Open',
        onClick: handleView,
      },
    });
    return toastId;
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
