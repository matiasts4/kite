import type { DriverDeclaration, DriverChoice } from '../../../lib/session/types';
import type { WorkModeOption } from './hooks/useChatAgents';
import {
  AUTOMATIC_MODEL_ID,
  MODE_LABELS,
  PROVIDER_CATALOG,
  SPANISH_EFFORT_LABELS,
  SPANISH_EFFORT_DETAILS,
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
    const choices: DriverChoice[] = model.effortLevels.map((lvl) => {
      if (typeof lvl === 'string') {
        const key = lvl.toLowerCase();
        const label = SPANISH_EFFORT_LABELS[key] || lvl.charAt(0).toUpperCase() + lvl.slice(1);
        const detail = SPANISH_EFFORT_DETAILS[key] || `${lvl} reasoning effort`;
        return { id: lvl, label, detail };
      }
      const key = lvl.id.toLowerCase();
      const label = lvl.label || SPANISH_EFFORT_LABELS[key] || lvl.id.charAt(0).toUpperCase() + lvl.id.slice(1);
      const detail = lvl.detail || SPANISH_EFFORT_DETAILS[key] || `${lvl.id} reasoning effort`;
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
    label: SPANISH_EFFORT_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1),
    detail: SPANISH_EFFORT_DETAILS[id] || `${id} reasoning effort`,
  }));

  const defaultEffort = choices.find((c) => c.id === 'medium')?.id || choices[0]?.id || 'medium';
  return { choices, defaultEffort };
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
