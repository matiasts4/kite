import type { DriverDeclaration, DriverChoice } from '../../../lib/session/types';
import type { WorkModeOption } from './hooks/useChatAgents';
import {
  AUTOMATIC_MODEL_ID,
  DEFAULT_EFFORT_CHOICES,
  MODE_LABELS,
  PROVIDER_CATALOG,
  type ChatProvider,
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
  const supportsEffort = Boolean(selectedOption?.supportsEffort);

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
        { id: 'plan', label: 'Plan', detail: 'Reads and plans, changes nothing', plan: true },
        { id: 'build', label: 'Build', detail: 'Works with the permission mode below', plan: false },
      ];

  return {
    driver: provider,
    provider,
    sessionMode: 'oneShot',
    defaultModel: null,
    defaultEffort: supportsEffort ? 'medium' : null,
    providers: providerRows(),
    models,
    effort: supportsEffort
      ? DEFAULT_EFFORT_CHOICES.map(({ id, label, detail }) => ({ id, label, detail }))
      : null,
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
