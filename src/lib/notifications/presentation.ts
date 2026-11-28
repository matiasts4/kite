import type { NotificationRecord, PendingAutoSwitchConfirmation } from '../../types';

export type NotificationModule = 'agent' | 'code' | 'chat';

export interface NotificationDisplayLookups {
  agents?: Array<{ id: string; name: string }>;
  threads?: Array<{ id: string; title?: string | null }>;
}

export interface NotificationToastContent {
  title: string;
  description?: string;
  isError: boolean;
}

export interface OsNotificationContent {
  title: string;
  body: string;
}

const GENERIC_THREAD_TITLES = new Set(['new thread', 'new chat', 'untitled']);

function trimNonEmpty(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateToastLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function cleanNonGenericThreadTitle(value?: string | null): string | null {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) return null;
  return GENERIC_THREAD_TITLES.has(trimmed.toLowerCase()) ? null : trimmed;
}

function resolveThreadTitle(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): string | null {
  const direct = cleanNonGenericThreadTitle(rec.threadTitle);
  if (direct) return direct;
  const targetId = rec.target?.id;
  if (!targetId || !lookups?.threads?.length) return null;
  const matched = lookups.threads.find((t) => t.id === targetId);
  return cleanNonGenericThreadTitle(matched?.title);
}

function resolveAgentLookupName(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): string | null {
  if (!rec.profileId || !lookups?.agents?.length) return null;
  const matched = lookups.agents.find((a) => a.id === rec.profileId);
  return trimNonEmpty(matched?.name);
}

function resolveCharacteristicIdentity(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): { name: string; isCharacteristic: boolean } {
  const actorName = trimNonEmpty(rec.actorName);
  if (actorName) {
    return { name: actorName, isCharacteristic: true };
  }

  const agentName = resolveAgentLookupName(rec, lookups);
  if (agentName) {
    return { name: agentName, isCharacteristic: true };
  }

  if (rec.target?.source === 'codeThread') {
    const threadTitle = resolveThreadTitle(rec, lookups);
    if (threadTitle) {
      return { name: threadTitle, isCharacteristic: true };
    }
  }

  const explicitTitle = trimNonEmpty(rec.title);
  if (explicitTitle) {
    return { name: explicitTitle, isCharacteristic: true };
  }

  if (rec.routineId) return { name: 'Routine Automation', isCharacteristic: false };
  if (rec.target?.source === 'agentChat') return { name: 'Agent chat', isCharacteristic: false };
  if (rec.target?.source === 'codeThread') return { name: 'Code thread', isCharacteristic: false };
  if (rec.target?.source === 'codeTerminal' || rec.target?.source === 'terminal') {
    return { name: 'Terminal runner', isCharacteristic: false };
  }
  if (rec.target?.source === 'task') return { name: 'Background task', isCharacteristic: false };
  return { name: 'Kite', isCharacteristic: false };
}

function formatAutoSwitchSummary(confirm: PendingAutoSwitchConfirmation): string {
  const from = confirm.fromAccountLabel || confirm.fromEmail || 'cuenta actual';
  const to = confirm.toAccountLabel || confirm.toEmail || 'otra cuenta';
  const plan = confirm.toPlanName ? ` (${confirm.toPlanName})` : '';
  if (confirm.reason === 'busy_terminals_ask' || confirm.busySessions.length > 0) {
    const busyCount = confirm.busySessions.length;
    return `Cambio de ${from} a ${to}${plan}. ${busyCount} ${busyCount === 1 ? 'terminal activa' : 'terminales activas'}.`;
  }
  if (confirm.requestedModel && confirm.suggestedFallbackModel) {
    return `Cambio de ${from} a ${to}${plan}. Modelo «${confirm.requestedModel}» no disponible; sugerido: «${confirm.suggestedFallbackModel}».`;
  }
  return `Confirma el cambio de ${from} a ${to}${plan}.`;
}

function getNeedsInputBaseDetail(rec: NotificationRecord): string {
  const isWaiting = rec.isWaitingForInput ?? !rec.isRead;
  switch (rec.kind?.requestKind) {
    case 'toolApproval':
      return isWaiting ? 'Waiting for your approval' : 'Asked for your approval';
    case 'question':
      return isWaiting ? 'Waiting on your answer' : 'Asked you a question';
    case 'unknown':
    default:
      return isWaiting ? 'Waiting for your input' : 'Asked for your input';
  }
}

function getLegacyNeedsInputToastDescription(rec: NotificationRecord): string {
  switch (rec.kind?.requestKind) {
    case 'toolApproval':
      return 'Waiting for your approval to proceed.';
    case 'question':
      return 'The agent has a question for you.';
    default:
      return 'Waiting for your input.';
  }
}

/**
 * Resolves the originating Kite module ('agent' | 'code' | 'chat') for a notification record.
 */
export function resolveNotificationModule(rec: NotificationRecord): NotificationModule | null {
  if (rec.module === 'agent' || rec.module === 'code' || rec.module === 'chat') {
    return rec.module;
  }

  switch (rec.target?.source) {
    case 'agentChat':
      return 'agent';
    case 'codeThread':
      return 'chat';
    case 'terminal':
    case 'codeTerminal':
      return 'code';
    case 'accountVault':
      return null;
    default:
      return rec.profileId ? 'agent' : null;
  }
}

/**
 * Resolves the characteristic actor/title displayed for a notification record.
 */
export function getNotificationActor(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): string {
  if (rec.kind?.kind === 'autoSwitchConfirm') {
    return trimNonEmpty(rec.title) || 'Cambio automático de cuenta';
  }
  if (rec.kind?.kind === 'modelQuotaExhausted') {
    return trimNonEmpty(rec.title) || 'Cuota de modelo agotada';
  }
  return resolveCharacteristicIdentity(rec, lookups).name;
}

/**
 * Resolves the concise secondary detail text displayed in the Notification Center row.
 */
export function getNotificationDetail(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): string {
  const kind = rec.kind;
  if (!kind) return 'System notice updated.';

  if (kind.kind === 'autoSwitchConfirm') {
    if (rec.body) return rec.body;
    if (rec.autoSwitchConfirm) return formatAutoSwitchSummary(rec.autoSwitchConfirm);
    if (rec.resolution === 'attended') return 'Cambio automático confirmado.';
    if (rec.resolution === 'abandoned') return 'Confirmación descartada o expirada.';
    return 'Confirma el cambio automático de cuenta.';
  }

  if (kind.kind === 'modelQuotaExhausted') {
    return rec.body || 'Este modelo alcanzó el 0% de cuota.';
  }

  const { name: actor, isCharacteristic } = resolveCharacteristicIdentity(rec, lookups);
  const bodyText = trimNonEmpty(rec.body);
  const distinctBody =
    bodyText && bodyText.toLowerCase() !== actor.toLowerCase() ? bodyText : null;
  const threadTitle = resolveThreadTitle(rec, lookups);
  const distinctThreadTitle =
    threadTitle && threadTitle.toLowerCase() !== actor.toLowerCase() ? threadTitle : null;

  if (kind.kind === 'needsInput') {
    const base = getNeedsInputBaseDetail(rec);
    if (distinctBody) {
      if (
        rec.target?.source === 'agentChat' &&
        distinctThreadTitle &&
        !distinctBody.toLowerCase().includes(distinctThreadTitle.toLowerCase())
      ) {
        return `${distinctThreadTitle} · ${distinctBody}`;
      }
      return `${base} · ${distinctBody}`;
    }
    if (distinctThreadTitle) {
      return `${base} · ${distinctThreadTitle}`;
    }
    return base;
  }

  if (kind.kind === 'settled') {
    if (distinctBody) return distinctBody;
    if (rec.target?.source === 'agentChat' && distinctThreadTitle) {
      if (kind.outcome === 'failed') return `Needs attention · ${distinctThreadTitle}`;
      if (kind.outcome === 'cancelled') return `Cancelled · ${distinctThreadTitle}`;
      return `Finished · ${distinctThreadTitle}`;
    }
    if (kind.outcome === 'failed') return 'needs attention';
    if (kind.outcome === 'cancelled') return 'cancelled';
    if (rec.target?.source === 'codeThread' && !isCharacteristic) {
      return 'Code thread closed';
    }
    return 'finished';
  }

  return 'System notification record.';
}

/**
 * Formats title, description, and error state for in-app Sileo toast notifications.
 */
export function getNotificationToastContent(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): NotificationToastContent {
  const kind = rec.kind;
  if (kind?.kind === 'autoSwitchConfirm' || kind?.kind === 'modelQuotaExhausted') {
    return {
      title: getNotificationActor(rec, lookups),
      description: getNotificationDetail(rec, lookups),
      isError: kind.kind === 'modelQuotaExhausted',
    };
  }

  const { name: actor, isCharacteristic } = resolveCharacteristicIdentity(rec, lookups);
  const bodyText = trimNonEmpty(rec.body);
  const distinctBody =
    bodyText && bodyText.toLowerCase() !== actor.toLowerCase() ? bodyText : null;
  const threadTitle = resolveThreadTitle(rec, lookups);
  const distinctThreadTitle =
    threadTitle && threadTitle.toLowerCase() !== actor.toLowerCase() ? threadTitle : null;

  if (kind?.kind === 'needsInput') {
    if (!isCharacteristic) {
      const title =
        kind.requestKind === 'question'
          ? 'Agent question'
          : kind.requestKind === 'toolApproval'
            ? 'Approval needed'
            : 'Input needed';
      return {
        title,
        description: distinctBody ?? getLegacyNeedsInputToastDescription(rec),
        isError: false,
      };
    }

    if (rec.target?.source === 'codeThread') {
      const title =
        kind.requestKind === 'question'
          ? 'Question from thread'
          : kind.requestKind === 'toolApproval'
            ? 'Approval needed'
            : 'Input needed';
      const description = distinctBody ? `${actor} · ${distinctBody}` : actor;
      return {
        title,
        description,
        isError: false,
      };
    }

    const compactActor = truncateToastLabel(actor, 24);
    const title =
      kind.requestKind === 'question'
        ? `${compactActor} has a question`
        : kind.requestKind === 'toolApproval'
          ? `${compactActor} needs approval`
          : `${compactActor} needs input`;
    let description: string;
    if (distinctBody) {
      description =
        distinctThreadTitle &&
        !distinctBody.toLowerCase().includes(distinctThreadTitle.toLowerCase())
          ? `${distinctThreadTitle} · ${distinctBody}`
          : distinctBody;
    } else if (distinctThreadTitle) {
      description = `${getNeedsInputBaseDetail(rec)} · ${distinctThreadTitle}`;
    } else {
      description = getNeedsInputBaseDetail(rec);
    }

    return {
      title,
      description,
      isError: false,
    };
  }

  if (kind?.kind === 'settled') {
    const isError = kind.outcome === 'failed';
    const isCancelled = kind.outcome === 'cancelled';

    if (!isCharacteristic) {
      return {
        title: isError ? `${actor}: Attention Required` : `${actor}: Completed`,
        description:
          distinctBody ??
          (isError
            ? 'Agent execution stopped with errors.'
            : isCancelled
              ? 'Operation was cancelled.'
              : 'Execution completed successfully.'),
        isError,
      };
    }

    const alreadyHasOutcomeSuffix =
      !trimNonEmpty(rec.actorName) &&
      /\b(finished|needs attention|was cancelled)$/i.test(actor);
    const actorTruncated = actor.length > 30;
    const compactActor = actorTruncated ? truncateToastLabel(actor, 28) : actor;
    const title = alreadyHasOutcomeSuffix
      ? truncateToastLabel(actor, 36)
      : isError
        ? `${compactActor} needs attention`
        : isCancelled
          ? `${compactActor} was cancelled`
          : `${compactActor} finished`;

    let description: string | undefined;
    if (distinctBody && distinctBody.toLowerCase() !== title.toLowerCase()) {
      description =
        rec.target?.source === 'agentChat' &&
        distinctThreadTitle &&
        !distinctBody.toLowerCase().includes(distinctThreadTitle.toLowerCase())
          ? `${distinctThreadTitle} · ${distinctBody}`
          : distinctBody;
    } else if (rec.target?.source === 'agentChat' && distinctThreadTitle) {
      description = isError ? `Needs attention · ${distinctThreadTitle}` : distinctThreadTitle;
    } else if (actorTruncated) {
      description = actor;
    } else if (isError) {
      description = 'Stopped with errors.';
    }

    return {
      title,
      description,
      isError,
    };
  }

  return {
    title: actor,
    description: distinctBody ?? 'Agent status updated.',
    isError: false,
  };
}

/**
 * Formats concise title and body text for native Windows OS Toast notifications.
 */
export function getOsNotificationContent(
  rec: NotificationRecord,
  lookups?: NotificationDisplayLookups
): OsNotificationContent {
  const toastContent = getNotificationToastContent(rec, lookups);
  if (toastContent.description) {
    return {
      title: toastContent.title,
      body: toastContent.description,
    };
  }

  if (rec.kind?.kind === 'settled') {
    if (rec.kind.outcome === 'failed') {
      return { title: toastContent.title, body: 'Stopped with errors.' };
    }
    if (rec.kind.outcome === 'cancelled') {
      return { title: toastContent.title, body: 'Run was cancelled.' };
    }
    return { title: toastContent.title, body: 'Ready for you in Kite.' };
  }

  return {
    title: toastContent.title,
    body: getNotificationDetail(rec, lookups),
  };
}
