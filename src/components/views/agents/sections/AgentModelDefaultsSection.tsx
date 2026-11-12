import React, { useState, useEffect } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { SelectMenu } from '../../../ui/SelectMenu';
import { EffortPicker } from '../../chat/EffortPicker';
import { resolveEffortChoicesForModel } from '../../chat/driverDeclaration';
import {
  supportsAgentChat,
  getEngineDisplayName,
} from '../engineMetadata';
import { engineToChatProvider, type ModelOption } from '../../chat/types';
import type { AgentSettingsDraft } from '../AgentSettingsTab';

export const AUTOMATIC_MODEL_ID = 'automatic';

export interface AgentModelDefaultsSectionProps {
  settingsDraft: AgentSettingsDraft;
  setSettingsDraft: React.Dispatch<React.SetStateAction<AgentSettingsDraft>>;
  setSettingsDirty: (dirty: boolean) => void;
  readOnly?: boolean;
  saving?: boolean;
}

export const AgentModelDefaultsSection: React.FC<AgentModelDefaultsSectionProps> = ({
  settingsDraft,
  setSettingsDraft,
  setSettingsDirty,
  readOnly = false,
  saving = false,
}) => {
  const isChatCapableEngine = supportsAgentChat(settingsDraft.engine);
  const currentChatProvider = engineToChatProvider(settingsDraft.engine);
  const [liveModels, setLiveModels] = useState<ModelOption[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLiveModels([]);
    setModelsNote(null);
    invokeCommand<{ models?: ModelOption[] }>('list_chat_provider_models', {
      provider: currentChatProvider,
      forceRefresh: false,
    })
      .then((res) => {
        if (!mounted) return;
        const models = Array.isArray(res?.models) ? res.models : [];
        setLiveModels(models.filter((model) => model.id && model.id !== AUTOMATIC_MODEL_ID));
        setModelsNote(
          models.length > 0 ? null : 'This program has not listed its models yet.'
        );
      })
      .catch(() => {
        if (!mounted) return;
        setLiveModels([]);
        setModelsNote('This program has not listed its models yet.');
      });
    return () => {
      mounted = false;
    };
  }, [currentChatProvider]);

  const modelRows = [
    {
      id: AUTOMATIC_MODEL_ID,
      title: 'Automatic',
      detail: 'The connected program chooses.',
    },
    ...liveModels.map((model) => ({
      id: model.id,
      title: model.name,
      detail: model.description || 'Listed by the connected program',
    })),
  ];
  const selectedLiveModel = liveModels.find((model) => model.id === settingsDraft.defaultModel);

  return (
    <section className="agent-setting-group">
      <h2 className="agent-setting-label">New chats start with</h2>
      <div className="ui-card agent-settings__rows">
        {isChatCapableEngine ? (
          <>
            <div className="agent-settings__row">
              <span className="agent-settings__row-copy">
                <strong>Access</strong>
                <small>How far a turn may go without asking.</small>
              </span>
              <span className="agent-settings__control">
                <SelectMenu
                  variant="field"
                  label="Access"
                  value={settingsDraft.defaultMode || 'automatic'}
                  triggerLabel={
                    settingsDraft.defaultMode === 'fullAccess'
                      ? 'Full access'
                      : settingsDraft.defaultMode === 'readOnly'
                      ? 'Read only'
                      : settingsDraft.defaultMode === 'acceptEdits'
                      ? 'Auto-accept edits'
                      : 'Automatic'
                  }
                  disabled={readOnly || saving}
                  rows={[
                    { id: 'automatic', title: 'Automatic', detail: 'Agent picks execution mode based on task' },
                    { id: 'acceptEdits', title: 'Auto-accept edits', detail: 'Edits are applied without prompt' },
                    { id: 'fullAccess', title: 'Full access', detail: 'Full file and command execution permissions' },
                    { id: 'readOnly', title: 'Read only', detail: 'Discussion and planning only, no file edits' },
                  ]}
                  onSelect={(id) => {
                    setSettingsDraft((prev: any) => ({ ...prev, defaultMode: id === 'automatic' ? null : id }));
                    setSettingsDirty(true);
                  }}
                />
              </span>
            </div>
            {(settingsDraft.engine === 'claude-code' || settingsDraft.engine === 'antigravity') ? (
              <div className="agent-settings__row">
                <span className="agent-settings__row-copy">
                  <strong>Plan first</strong>
                  <small>Start in Plan — think it through before touching anything.</small>
                </span>
                <span className="agent-settings__control">
                  <button
                    type="button"
                    role="switch"
                    aria-label="Plan first"
                    aria-checked={Boolean(settingsDraft.defaultPlan)}
                    className="ui-switch"
                    disabled={readOnly || saving}
                    onClick={() => {
                      setSettingsDraft((prev: any) => ({
                        ...prev,
                        defaultPlan: !prev.defaultPlan,
                      }));
                      setSettingsDirty(true);
                    }}
                  >
                    <span aria-hidden="true" className="ui-switch__knob" />
                  </button>
                </span>
              </div>
            ) : null}
            <div className="agent-settings__row">
              <span className="agent-settings__row-copy">
                <strong>Model</strong>
                <small>Which model {getEngineDisplayName(settingsDraft.engine)} uses.</small>
              </span>
              <span className="agent-settings__control">
                <SelectMenu
                  variant="field"
                  label="Model"
                  value={settingsDraft.defaultModel || AUTOMATIC_MODEL_ID}
                  triggerLabel={
                    modelRows.find((r) => r.id === (settingsDraft.defaultModel || AUTOMATIC_MODEL_ID))?.title ||
                    settingsDraft.defaultModel ||
                    'Automatic'
                  }
                  disabled={readOnly || saving}
                  rows={modelRows}
                  onSelect={(id) => {
                    setSettingsDraft((prev: any) => ({
                      ...prev,
                      defaultModel: id === AUTOMATIC_MODEL_ID ? null : id,
                    }));
                    setSettingsDirty(true);
                  }}
                />
                {modelsNote ? <small>{modelsNote}</small> : null}
              </span>
            </div>
            {selectedLiveModel?.supportsEffort ? (
              <div className="agent-settings__row">
                <span className="agent-settings__row-copy">
                  <strong>Reasoning effort</strong>
                  <small>How much reasoning this model uses before it answers.</small>
                </span>
                <span className="agent-settings__control">
                  <EffortPicker
                    variant="field"
                    label="Reasoning effort"
                    detail="How much reasoning this model uses before it answers."
                    disabled={readOnly || saving}
                    choices={resolveEffortChoicesForModel(selectedLiveModel)?.choices}
                    value={
                      settingsDraft.defaultEffort ||
                      settingsDraft.defaultProviderOptions?.find((o: any) => o.effort)?.effort ||
                      resolveEffortChoicesForModel(selectedLiveModel)?.defaultEffort ||
                      'medium'
                    }
                    onSelect={(effortId) => {
                      setSettingsDraft((prev: any) => {
                        const opts = Array.isArray(prev.defaultProviderOptions) ? [...prev.defaultProviderOptions] : [];
                        const provider = prev.engine === 'codex' ? 'openai' : prev.engine === 'claude-code' ? 'anthropic' : prev.engine;
                        const existingIdx = opts.findIndex((o: any) => o.provider === provider || o.effort);
                        if (existingIdx !== -1) {
                          opts[existingIdx] = { ...opts[existingIdx], effort: effortId };
                        } else {
                          opts.push({ provider, effort: effortId });
                        }
                        return {
                          ...prev,
                          defaultEffort: effortId,
                          defaultProviderOptions: opts,
                        };
                      });
                      setSettingsDirty(true);
                    }}
                  />
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="agent-settings__row">
            <span className="agent-settings__row-copy">
              <strong>Chat defaults</strong>
              <small>{getEngineDisplayName(settingsDraft.engine)} runs in a terminal in this release.</small>
            </span>
            <span className="agent-settings__control">
              <strong className="agent-settings__row-value">Not applicable</strong>
            </span>
          </div>
        )}
      </div>
    </section>
  );
};
