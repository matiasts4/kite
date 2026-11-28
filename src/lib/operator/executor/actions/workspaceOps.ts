// Kite Code — Workspace Diff Inspection, Safe Allowlisted Verification & Navigation (`read_diff`, `run_check`, `navigate_view`)
// Compresses diffs via `reactEnvelope` + `CcrStore`, runs strictly allowlisted check presets,
// and dispatches typed UI navigation requests without touching TitleBar geometry.

import * as ipc from '../../../ipc';
import type { WorkspaceChanges, WorkspaceFileDiff } from '../../../ipc';
import { ctxClient } from '../../context/ctxClient';
import { formatReactObservation } from '../../context/reactEnvelope';
import type {
  ActionReceipt,
  NavigateViewAction,
  ReadDiffAction,
  RunCheckAction,
  TurnContext,
} from '../../contract';
import { sendUiRequest } from '../ui-bus';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return false;
  }
}

export type AllowlistedCheckPreset = 'tsc' | 'vitest' | 'cargo_test' | 'sanitizer';

export const ALLOWLISTED_CHECK_PRESETS: Record<
  AllowlistedCheckPreset,
  { label: string; baseCommand: string; supportsFilter: boolean }
> = {
  tsc: {
    label: 'TypeScript (tsc)',
    baseCommand: 'npx tsc --noEmit',
    supportsFilter: false,
  },
  vitest: {
    label: 'Vitest',
    baseCommand: 'npx vitest run',
    supportsFilter: true,
  },
  cargo_test: {
    label: 'Cargo Test',
    baseCommand: 'cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code',
    supportsFilter: true,
  },
  sanitizer: {
    label: 'Clean-Room Sanitizer',
    baseCommand: 'node .kite/sanitizer/audit-references.mjs --check',
    supportsFilter: false,
  },
};

const SAFE_FILTER_RE = /^[a-zA-Z0-9_./:-]+$/;

export function sanitizeCheckTargetFilter(raw?: string): { ok: boolean; filter?: string } {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: true };
  if (
    trimmed.includes('..') ||
    trimmed.includes(';') ||
    trimmed.includes('|') ||
    trimmed.includes('&') ||
    trimmed.includes('`') ||
    trimmed.includes('$') ||
    !SAFE_FILTER_RE.test(trimmed)
  ) {
    return { ok: false };
  }
  return { ok: true, filter: trimmed };
}

function basenameOf(rawPath: string): string {
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || rawPath;
}

export async function executeReadDiffAction(
  action: ReadDiffAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const workspaceId = action.workspaceId || context?.workspaceId;
  if (!workspaceId || !hasTauriRuntime()) {
    const msg = workspaceId
      ? 'La lectura de diffs requiere el entorno nativo de Kite Code.'
      : 'No hay un workspace activo para leer diffs.';
    return {
      actionIdx,
      type: 'read_diff',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: workspaceId ? 'tauri_unavailable' : 'missing_workspace',
    };
  }

  const changes: WorkspaceChanges = await ipc.readWorkspaceChanges(workspaceId);
  const files = changes?.files || [];
  if (files.length === 0) {
    const msg = 'El repositorio está limpio, sin diffs pendientes.';
    return {
      actionIdx,
      type: 'read_diff',
      ok: true,
      summaryEs: msg,
      spokenSummaryEs: msg,
      data: { branch: changes?.branch || null, files: [], diffs: [] },
    };
  }

  const pathFilter = (action.path || '').trim().toLowerCase();
  const matched = pathFilter
    ? files.filter(
        (f) =>
          f.path.toLowerCase() === pathFilter ||
          f.path.toLowerCase().endsWith(pathFilter) ||
          basenameOf(f.path).toLowerCase() === pathFilter
      )
    : files;

  if (pathFilter && matched.length === 0) {
    const msg = `No encontré cambios pendientes para "${action.path}".`;
    return {
      actionIdx,
      type: 'read_diff',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'diff_file_not_found',
    };
  }

  const targets = matched.slice(0, 3);
  const rawChunks: string[] = [];
  const diffs: Array<{
    path: string;
    added: number;
    removed: number;
    hunks: string[];
    preview: string;
  }> = [];

  for (const f of targets) {
    const diffRes: WorkspaceFileDiff = await ipc.readWorkspaceFileDiff(
      workspaceId,
      f.path,
      f.status === 'untracked'
    );
    const lines = diffRes?.lines || [];
    let added = 0;
    let removed = 0;
    const hunks: string[] = [];
    const previewLines: string[] = [];
    const fileRaw: string[] = [`--- ${f.path} (${f.status})`];

    for (const l of lines) {
      if (l.kind === 'added') {
        added += 1;
        fileRaw.push(`+ ${l.text}`);
        if (previewLines.length < 24) previewLines.push(`+ ${l.text}`);
      } else if (l.kind === 'removed') {
        removed += 1;
        fileRaw.push(`- ${l.text}`);
        if (previewLines.length < 24) previewLines.push(`- ${l.text}`);
      } else if (l.kind === 'hunk') {
        if (hunks.length < 6) hunks.push(l.text);
        fileRaw.push(l.text);
        if (previewLines.length < 24) previewLines.push(l.text);
      } else {
        fileRaw.push(`  ${l.text}`);
      }
    }

    rawChunks.push(fileRaw.join('\n'));
    diffs.push({
      path: f.path,
      added,
      removed,
      hunks,
      preview: previewLines.join('\n').slice(0, 900),
    });
  }

  const ccrHash = ctxClient.ccrStoreLocal(rawChunks.join('\n\n'));
  const totalAdded = diffs.reduce((acc, d) => acc + d.added, 0);
  const totalRemoved = diffs.reduce((acc, d) => acc + d.removed, 0);
  const names = diffs.map((d) => basenameOf(d.path)).join(', ');
  const spoken = `En ${names} hay ${totalAdded} líneas agregadas y ${totalRemoved} eliminadas.`;

  const baseReceipt: ActionReceipt = {
    actionIdx,
    type: 'read_diff',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      branch: changes?.branch || null,
      ccrHash,
      diffs,
    },
  };
  const envelope = formatReactObservation(baseReceipt);

  return {
    ...baseReceipt,
    data: {
      branch: changes?.branch || null,
      ccrHash,
      diffs,
      envelopeText: envelope.text,
    },
  };
}

export async function executeRunCheckAction(
  action: RunCheckAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const presetSpec = ALLOWLISTED_CHECK_PRESETS[action.preset];
  if (!presetSpec) {
    return {
      actionIdx,
      type: 'run_check',
      ok: false,
      summaryEs: `Preset de verificación no permitido: ${String(action.preset)}.`,
      spokenSummaryEs: 'Ese comando de verificación no está en la lista segura.',
      error: 'disallowed_preset',
    };
  }

  const filterCheck = sanitizeCheckTargetFilter(action.targetFilter);
  if (!filterCheck.ok) {
    const spoken = 'El filtro contiene caracteres no permitidos para ejecución segura.';
    return {
      actionIdx,
      type: 'run_check',
      ok: false,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      error: 'unsafe_target_filter',
    };
  }

  if (!hasTauriRuntime()) {
    const msg = 'La ejecución de verificaciones requiere el entorno nativo de Kite Code.';
    return {
      actionIdx,
      type: 'run_check',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'tauri_unavailable',
    };
  }

  const command =
    presetSpec.supportsFilter && filterCheck.filter
      ? `${presetSpec.baseCommand} ${filterCheck.filter}`
      : presetSpec.baseCommand;

  try {
    const res = await ipc.invokeCommand<{
      ok?: boolean;
      exitCode?: number;
      passed?: number;
      failed?: number;
      output?: string;
      stdout?: string;
      stderr?: string;
      ccrHash?: string;
    }>('ctx_exec', {
      preset: action.preset,
      command,
      ...(filterCheck.filter ? { targetFilter: filterCheck.filter } : {}),
      ...(context?.workspaceId ? { workspaceId: context.workspaceId } : {}),
    });

    const rawOutput = [res?.output, res?.stdout, res?.stderr]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join('\n')
      .trim();
    const ccrHash =
      res?.ccrHash ||
      (rawOutput ? ctxClient.ccrStoreLocal(rawOutput) : ctxClient.ccrStoreLocal(command));

    const passedOk = res?.ok !== undefined ? Boolean(res.ok) : res?.exitCode === 0;
    const countsPart =
      typeof res?.passed === 'number' || typeof res?.failed === 'number'
        ? ` (${res?.passed ?? 0} pasaron, ${res?.failed ?? 0} fallaron)`
        : '';
    const spoken = passedOk
      ? `${presetSpec.label} pasó correctamente${countsPart}.`
      : `${presetSpec.label} falló${countsPart}. Revisá los detalles con <<ccr:${ccrHash}>>.`;

    return {
      actionIdx,
      type: 'run_check',
      ok: passedOk,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      ...(passedOk ? {} : { error: 'check_failed' }),
      data: {
        preset: action.preset,
        command,
        exitCode: res?.exitCode ?? (passedOk ? 0 : 1),
        passed: res?.passed,
        failed: res?.failed,
        ccrHash,
      },
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    return {
      actionIdx,
      type: 'run_check',
      ok: false,
      summaryEs: `No pude ejecutar ${presetSpec.label}: ${errMsg}`,
      spokenSummaryEs: `No pude correr ${presetSpec.label} en este entorno.`,
      error: errMsg,
    };
  }
}

const VIEW_LABELS: Record<NavigateViewAction['view'], string> = {
  threads: 'Threads',
  code: 'Code',
  agents: 'Agents',
  diffs: 'Diffs',
  tasks: 'Tasks',
  routines: 'Routines',
  settings: 'Settings',
};

export async function executeNavigateViewAction(
  action: NavigateViewAction,
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const ack = await sendUiRequest('navigate-view', {
    view: action.view,
    ...(action.threadId ? { threadId: action.threadId } : {}),
    ...(action.filePath ? { filePath: action.filePath } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
  });

  const label = VIEW_LABELS[action.view] || action.view;
  if (!ack.ok) {
    const msg = `No pude abrir la vista ${label}: ${ack.reason || 'sin respuesta de UI'}.`;
    return {
      actionIdx,
      type: 'navigate_view',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: ack.reason || 'navigate_view_failed',
    };
  }

  const spoken = `Abrí la vista ${label}.`;
  return {
    actionIdx,
    type: 'navigate_view',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      view: action.view,
      ...(action.threadId ? { threadId: action.threadId } : {}),
      ...(action.filePath ? { filePath: action.filePath } : {}),
      ...(action.taskId ? { taskId: action.taskId } : {}),
    },
  };
}
