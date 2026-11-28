import type { DriverDeclaration, DriverChoice } from '../../../lib/session/types';
import type { WorkModeOption } from './hooks/useChatAgents';
import {
  AUTOMATIC_MODEL_ID,
  EFFORT_LABELS,
  EFFORT_DETAILS,
  MODE_LABELS,
  PROVIDER_CATALOG,
  type ChatProvider,
  type EffortChoice,
  type ModelOption,
} from './types';

function providerRows(): DriverChoice[] {
  return (Object.keys(PROVIDER_CATALOG) as ChatProvider[]).map((id) => {
    const meta = PROVIDER_CATALOG[id];
    return {
      id,
      label: meta.label,
      detail: meta.vendor,
      engine: meta.engineId ?? id,
    };
  });
}

export interface CatalogDeclarationInput {
  provider: ChatProvider;
  selectedModel?: string | null;
  dynamicModels?: ModelOption[];
  dynamicAgents?: WorkModeOption[];
}

export interface ModelEffortInput {
  id: string;
  name?: string;
  label?: string;
  supportsEffort?: boolean;
  effortLevels?: (EffortChoice | string)[];
  defaultEffort?: string | null;
}

export function resolveEffortChoicesForModel(
  model: ModelEffortInput | undefined | null
): { choices: DriverChoice[]; defaultEffort: string } | null {
  if (!model || !model.supportsEffort) {
    return null;
  }

  // 1. If the model explicitly provides effortLevels, format and map them
  if (Array.isArray(model.effortLevels) && model.effortLevels.length > 0) {
    if (model.effortLevels.length < 2) {
      return null;
    }

    const choices: DriverChoice[] = model.effortLevels.map((lvl) => {
      if (typeof lvl === 'string') {
        const key = lvl.toLowerCase();
        const label = EFFORT_LABELS[key] || lvl.charAt(0).toUpperCase() + lvl.slice(1);
        const detail = EFFORT_DETAILS[key] || `${lvl} reasoning effort`;
        return { id: lvl, label, detail };
      }
      const key = lvl.id.toLowerCase();
      const label = lvl.label || EFFORT_LABELS[key] || lvl.id.charAt(0).toUpperCase() + lvl.id.slice(1);
      const detail = lvl.detail || EFFORT_DETAILS[key] || `${lvl.id} reasoning effort`;
      return { id: lvl.id, label, detail };
    });

    const defaultEffort =
      model.defaultEffort && choices.some((c) => c.id === model.defaultEffort)
        ? model.defaultEffort
        : choices.find((c) => c.id === 'medium')?.id ||
          choices.find((c) => c.id === 'low')?.id ||
          choices[0]?.id ||
          'medium';

    return { choices, defaultEffort };
  }

  // 2. Infer appropriate tiers for known models that support effort
  const idLower = (model.id || '').toLowerCase();
  let tierIds: string[] = ['low', 'medium', 'high'];

  if (idLower.includes('gemini') || idLower.includes('argon')) {
    tierIds = ['minimal', 'low', 'medium', 'high'];
  } else if (idLower.includes('claude') || idLower.includes('thinking')) {
    tierIds = ['low', 'medium', 'high', 'max'];
  } else if (
    idLower.includes('o1') ||
    idLower.includes('o3') ||
    idLower.includes('o4') ||
    idLower.includes('reasoning')
  ) {
    tierIds = ['low', 'medium', 'high', 'xhigh'];
  } else if (idLower.includes('deepseek') || idLower.includes('r1')) {
    tierIds = ['low', 'medium', 'high', 'max'];
  }

  const choices: DriverChoice[] = tierIds.map((id) => ({
    id,
    label: EFFORT_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1),
    detail: EFFORT_DETAILS[id] || `${id} reasoning effort`,
  }));

  const defaultEffort = choices.find((c) => c.id === 'medium')?.id || choices[0]?.id || 'medium';
  return { choices, defaultEffort };
}

const EFFORT_LEVEL_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  med: 3,
  high: 4,
  xhigh: 5,
  'x-high': 5,
  'extra-high': 5,
  extra_high: 5,
  'very-high': 5,
  extra: 5,
  max: 6,
  maximum: 6,
  ultra: 7,
};

/**
 * Reconciles a candidate effort level against a model's advertised capabilities.
 * Returns `null` when the model does not support reasoning effort, preserves exact
 * supported levels, and clamps out-of-range levels to the nearest advertised tier.
 */
export function reconcileEffortForModel(
  model: ModelEffortInput | undefined | null,
  effort: string | null | undefined
): string | null {
  const resolved = resolveEffortChoicesForModel(model);
  if (!resolved || resolved.choices.length < 2) {
    return null;
  }
  const trimmed = typeof effort === 'string' ? effort.trim() : '';
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  const exact = resolved.choices.find((choice) => choice.id.toLowerCase() === lower);
  if (exact) {
    return exact.id;
  }
  const targetRank = EFFORT_LEVEL_RANK[lower];
  if (targetRank === undefined) {
    return resolved.defaultEffort;
  }
  let best = resolved.choices[0];
  let bestDist = Math.abs((EFFORT_LEVEL_RANK[best.id.toLowerCase()] ?? 3) - targetRank);
  for (let i = 1; i < resolved.choices.length; i += 1) {
    const candidate = resolved.choices[i];
    const dist = Math.abs((EFFORT_LEVEL_RANK[candidate.id.toLowerCase()] ?? 3) - targetRank);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best.id;
}

/**
 * Transitional declaration built from the static provider catalog the app
 * already ships. The composer no longer reads that catalog: it renders this
 * value exactly like a declaration a live session will supply later.
 *
 * `sessionMode` is `oneShot` because the current runtime starts one command per
 * send. A driver that can hold a process open declares `persistent` instead.
 */
export function declarationFromCatalog({
  provider,
  selectedModel = null,
  dynamicModels = [],
  dynamicAgents = [],
}: CatalogDeclarationInput): DriverDeclaration {
  const meta = PROVIDER_CATALOG[provider] ?? PROVIDER_CATALOG.claude;
  const liveModels = dynamicModels
    .filter((model) => model.id && model.id !== AUTOMATIC_MODEL_ID)
    .map((model) => ({
      id: model.id,
      label: model.name,
      detail: model.description,
      supportsEffort: model.supportsEffort,
      effortLevels: model.effortLevels,
      defaultEffort: model.defaultEffort,
    }));
  const models = [
    {
      id: AUTOMATIC_MODEL_ID,
      label: 'Automatic',
      detail: 'The connected program chooses.',
      supportsEffort: false,
    },
    ...liveModels,
  ];

  const selectedOption = liveModels.find((model) => model.id === selectedModel);
  const effortResolved = resolveEffortChoicesForModel(selectedOption);
  const supportsEffort = Boolean(selectedOption?.supportsEffort && effortResolved);

  const permission = meta.modes.map((mode) => ({
    id: mode,
    label: MODE_LABELS[mode].title,
    detail: MODE_LABELS[mode].detail,
  }));

  const workModeChoices = (dynamicAgents && dynamicAgents.length > 0)
    ? dynamicAgents.map((a) => ({
        id: a.id,
        label: a.label,
        detail: a.detail,
        plan: Boolean(a.plan),
      }))
    : [
        { id: 'build', label: 'Build', detail: 'Works with the permission mode below', plan: false },
        { id: 'plan', label: 'Plan', detail: 'Reads and plans, changes nothing', plan: true },
      ];

  return {
    driver: provider,
    provider,
    sessionMode: 'oneShot',
    defaultModel: null,
    defaultEffort: effortResolved ? effortResolved.defaultEffort : null,
    providers: providerRows(),
    models,
    effort: effortResolved ? effortResolved.choices : null,
    permission,
    workMode: workModeChoices,
    unlistedReasons: {
      ...(liveModels.length === 0
        ? { model: `${meta.label} has not listed its models yet.` }
        : {}),
      ...(supportsEffort
        ? {}
        : {
            effort: `${
              selectedOption?.label ?? 'Automatic'
            } does not advertise reasoning effort levels.`,
          }),
    },
  };
}
