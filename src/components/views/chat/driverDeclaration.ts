import type { DriverDeclaration, DriverChoice } from '../../../lib/session/types';
import {
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
}: CatalogDeclarationInput): DriverDeclaration {
  const meta = PROVIDER_CATALOG[provider] ?? PROVIDER_CATALOG.claude;
  const catalogModels =
    meta.isDynamic && dynamicModels.length > 0 ? dynamicModels : meta.models;
  const models = catalogModels.map((model) => ({
    id: model.id,
    label: model.name,
    detail: model.description,
    supportsEffort: model.supportsEffort,
  }));

  const selectedOption = models.find((model) => model.id === selectedModel);
  const supportsEffort = Boolean(meta.supportsEffort || selectedOption?.supportsEffort);

  const permission = meta.modes.map((mode) => ({
    id: mode,
    label: MODE_LABELS[mode].title,
    detail: MODE_LABELS[mode].detail,
  }));

  return {
    driver: provider,
    provider,
    sessionMode: 'oneShot',
    defaultModel: meta.defaultModel,
    defaultEffort: supportsEffort ? 'medium' : null,
    providers: providerRows(),
    models,
    effort: supportsEffort
      ? DEFAULT_EFFORT_CHOICES.map(({ id, label, detail }) => ({ id, label, detail }))
      : null,
    permission,
    workMode: [
      { id: 'plan', label: 'Plan', detail: 'Reads and plans, changes nothing', plan: true },
      { id: 'build', label: 'Build', detail: 'Works with the permission mode below', plan: false },
    ],
    unlistedReasons: supportsEffort
      ? undefined
      : {
          effort: `${
            selectedOption?.label ?? selectedModel ?? meta.label
          } does not advertise reasoning effort levels.`,
        },
  };
}
