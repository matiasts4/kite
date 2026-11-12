import React from 'react';
import { ModelPickerPopover } from './ModelPickerPopover';
import { EffortSliderPopover } from './EffortSliderPopover';
import { WorkModePickerPopover } from './WorkModePickerPopover';
import { PermissionPickerPopover } from './PermissionPickerPopover';
import { ConnectionPickerPopover } from './ConnectionPickerPopover';
import { ComposerControlSeparator } from './ComposerControl';
import { ControlReason } from './ControlReason';
import { AUTOMATIC_MODEL_ID, type ChatMode, type ChatProvider } from '../types';
import type { DriverDeclaration } from '../../../../lib/session/types';
import type { ConnectionCandidate } from '../connectionBinding';
import { isControlDeclared, isProviderDeclared, undeclaredReason } from '../../../../lib/session/declaration';
import { catalogEmptyMessage } from '../catalogEmptyState';

export interface ComposerConfigControlsProps {
  threadProvider: ChatProvider;
  threadModel: string | null;
  threadEffort?: string | null;
  threadAgent?: string | null;
  threadPlan?: boolean;
  threadMode: ChatMode;
  threadConnectionId?: string | null;
  declaration: DriverDeclaration;
  running: boolean;
  catalogState?: 'missing-binary' | 'signed-out' | 'loading' | 'empty' | null;
  connectionCandidates: ConnectionCandidate[];
  ensureDynamicModels?: (provider: ChatProvider) => void;
  onUpdateConfig: (patch: {
    provider?: ChatProvider;
    mode?: ChatMode;
    model?: string | null;
    effort?: string | null;
    plan?: boolean;
    agent?: string | null;
    connectionId?: string | null;
  }) => void;
  onSelectConnection?: (connectionId: string) => void;
}

export const ComposerConfigControls: React.FC<ComposerConfigControlsProps> = ({
  threadProvider,
  threadModel,
  threadEffort,
  threadAgent,
  threadPlan,
  threadMode,
  threadConnectionId,
  declaration,
  running,
  catalogState = null,
  connectionCandidates,
  ensureDynamicModels,
  onUpdateConfig,
  onSelectConnection,
}) => {
  const providerDeclared = isProviderDeclared(declaration, threadProvider);
  const providerReason = providerDeclared ? null : undeclaredReason(declaration, 'provider');

  const declaredModels = declaration.models ?? [];
  const liveModels = declaredModels.filter((model) => model.id !== AUTOMATIC_MODEL_ID);
  const modelReason =
    liveModels.length > 0
      ? null
      : catalogState
        ? catalogEmptyMessage(catalogState, threadProvider)
        : undeclaredReason(declaration, 'model');
  const currentModelOption = declaredModels.find((model) => model.id === threadModel);
  const currentModelName =
    !threadModel || threadModel === AUTOMATIC_MODEL_ID
      ? 'Automatic'
      : currentModelOption?.label || threadModel;

  const effortDeclared = isControlDeclared(declaration.effort);
  const effortReason = effortDeclared ? null : undeclaredReason(declaration, 'effort');

  const permissions = declaration.permission ?? [];
  const permissionDeclared = isControlDeclared(declaration.permission);
  const permissionReason = permissionDeclared ? null : undeclaredReason(declaration, 'permission');

  return (
    <div className="kite-composer-footer-left">
      {/* Model & Provider Picker Popover */}
      <ModelPickerPopover
        provider={threadProvider}
        model={threadModel}
        declaration={declaration}
        disabled={running}
        modelReason={modelReason}
        catalogState={catalogState}
        ensureDynamicModels={ensureDynamicModels}
        onSelectModel={(modelId, targetProv) => {
          if (targetProv && targetProv !== threadProvider) {
            onUpdateConfig({ provider: targetProv, model: modelId });
          } else {
            onUpdateConfig({ model: modelId });
          }
        }}
        onSelectProvider={(provider) => onUpdateConfig({ provider })}
      />
      {modelReason && <ControlReason reason={modelReason} />}
      {providerReason && <ControlReason reason={providerReason} />}

      <ComposerControlSeparator />

      {/* Effort Slider Popover (Discrete Effort Level Control) */}
      <EffortSliderPopover
        effort={threadEffort}
        modelName={currentModelName}
        declaration={declaration}
        disabled={running}
        unlistedReason={effortReason}
        onChangeEffort={(effortId) => onUpdateConfig({ effort: effortId })}
      />

      <ComposerControlSeparator />

      {/* Work Mode & Dynamic Agents Popover */}
      <WorkModePickerPopover
        workModes={declaration.workMode || []}
        currentAgent={threadAgent}
        currentPlan={threadPlan}
        currentMode={threadMode}
        disabled={running}
        onSelectWorkMode={(patch) => onUpdateConfig(patch)}
      />

      <ComposerControlSeparator />

      {/* Runtime / Permission Mode Popover */}
      <PermissionPickerPopover
        threadMode={threadMode}
        permissions={permissions}
        permissionDeclared={permissionDeclared}
        permissionReason={permissionReason}
        disabled={running}
        onSelectPermission={(mode) =>
          onUpdateConfig({
            mode,
            plan: mode === 'readOnly',
            ...(mode === 'readOnly' ? {} : { agent: null }),
          })
        }
      />

      {/* Connection Selector (when multiple accounts verified the spawn endpoint) */}
      {connectionCandidates.length > 1 && onSelectConnection && (
        <>
          <ComposerControlSeparator />
          <ConnectionPickerPopover
            threadConnectionId={threadConnectionId ?? null}
            candidates={connectionCandidates}
            disabled={running}
            onSelectConnection={onSelectConnection}
          />
        </>
      )}
    </div>
  );
};
