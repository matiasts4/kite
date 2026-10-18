import React, { useEffect, useState } from 'react';
import { invokeCommand } from '../../lib/ipc';
import type { AgentEngineDescriptor } from './types';
import { BrandLogo, getEngineDisplayName } from '../views/agents/engineMetadata';
import { CloseIcon, FolderIcon, PlusIcon } from './codeIcons';

interface LaunchPreset {
  id: string;
  name: string;
  engine: string;
  count: number;
}

export interface NewSessionPaneProps {
  workspaceId: string;
  workspaceName: string;
  engines: AgentEngineDescriptor[];
  onCancel: () => void;
  onLaunch: (engineId: string, count: number) => void;
}

function presetKey(workspaceId: string) {
  return `kite.launchPresets.${workspaceId}`;
}

function readPresets(workspaceId: string): LaunchPreset[] {
  try {
    const raw = localStorage.getItem(presetKey(workspaceId));
    const parsed = raw ? (JSON.parse(raw) as LaunchPreset[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const BookmarkIcon = () => (
  <svg
    aria-hidden="true"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />
  </svg>
);

const CircleCheckIcon = () => (
  <svg
    aria-hidden="true"
    className="workspace-launcher__check"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const PlayIcon = () => (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="6 4 20 12 6 20" />
  </svg>
);

export const NewSessionPane: React.FC<NewSessionPaneProps> = ({
  workspaceId,
  workspaceName,
  engines,
  onCancel,
  onLaunch,
}) => {
  const [presets, setPresets] = useState<LaunchPreset[]>(() => readPresets(workspaceId));
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [engineId, setEngineId] = useState(engines[0]?.wireId || 'claude-code');
  const [count, setCount] = useState(1);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let alive = true;
    invokeCommand<{ teammates?: Array<{ engine?: string; installed?: boolean }> }>('get_agent_availability', {
      supportedSchemaVersion: 1,
    })
      .then((res) => {
        if (!alive) return;
        const next: Record<string, boolean> = {};
        for (const teammate of res?.teammates || []) {
          if (teammate.engine) next[teammate.engine] = teammate.installed !== false;
        }
        setInstalled(next);
        setProbed(true);
      })
      .catch(() => {
        if (alive) setProbed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onLaunch(engineId, count);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel, onLaunch, engineId, count]);

  const selectedName = getEngineDisplayName(engineId);
  const missing = probed
    ? engines.filter((engine) => installed[engine.wireId] === false).map((engine) => engine.displayName)
    : [];

  useEffect(() => {
    setPresets(readPresets(workspaceId));
    setSelectedPresetId(null);
  }, [workspaceId]);

  const savePreset = () => {
    const existing = presets.find((p) => p.engine === engineId && p.count === count);
    if (existing) {
      setSelectedPresetId(existing.id);
      return;
    }

    const preset: LaunchPreset = {
      id: globalThis.crypto.randomUUID(),
      name: count === 1 ? selectedName : `${selectedName} × ${count}`,
      engine: engineId,
      count,
    };
    const next = [...presets, preset].slice(-50);
    setPresets(next);
    setSelectedPresetId(preset.id);
    localStorage.setItem(presetKey(workspaceId), JSON.stringify(next));
  };

  const deletePreset = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    if (selectedPresetId === id) setSelectedPresetId(null);
    localStorage.setItem(presetKey(workspaceId), JSON.stringify(next));
  };

  const applyPreset = (preset: LaunchPreset) => {
    if (selectedPresetId === preset.id) {
      setSelectedPresetId(null);
      return;
    }
    setSelectedPresetId(preset.id);
    setEngineId(preset.engine);
    setCount(preset.count);
  };

  const renderAgentChoice = (wireId: string, label: string) => {
    const isPressed = engineId === wireId;
    return (
      <button
        key={wireId}
        type="button"
        aria-pressed={isPressed}
        className="workspace-launcher__agent"
        onClick={() => {
          setSelectedPresetId(null);
          setEngineId(wireId);
        }}
      >
        <span className="workspace-launcher__logo">
          <BrandLogo engine={wireId} size={15} />
        </span>
        <span className="workspace-launcher__name">{label}</span>
        {isPressed ? <CircleCheckIcon /> : null}
      </button>
    );
  };

  return (
    <section className="pane workspace-launcher" aria-label={`New session in ${workspaceName}`}>
      <header className="workspace-launcher__header">
        <span className="workspace-pill">
          <FolderIcon size={12} />
          {workspaceName}
        </span>
        <span>New session</span>
        <span className="pane-titlebar__spacer" />
        <button
          type="button"
          className="chrome-button"
          aria-label="Cancel new session"
          title="Cancel"
          onClick={onCancel}
        >
          <CloseIcon size={12} />
        </button>
      </header>

      <div className="workspace-launcher__scroll">
        <div className="workspace-launcher__form">
          <section className="workspace-launcher__section" aria-labelledby="workspace-launch-presets">
            <div className="workspace-launcher__section-head">
              <h2 className="ui-eyebrow" id="workspace-launch-presets">
                Preset
              </h2>
            </div>
            <div className="workspace-launcher__presets">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  style={{ position: 'relative', display: 'flex' }}
                >
                  <button
                    type="button"
                    className="workspace-launcher__preset"
                    style={{ width: '100%' }}
                    aria-pressed={selectedPresetId === preset.id}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="workspace-launcher__preset-title">
                      <BookmarkIcon />
                      <span>{preset.name}</span>
                      <b>{preset.count}</b>
                    </span>
                    <small>
                      {preset.count > 1
                        ? `${getEngineDisplayName(preset.engine)} ×${preset.count}`
                        : getEngineDisplayName(preset.engine)}
                    </small>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${preset.name} preset`}
                    title="Delete preset"
                    className="workspace-launcher__preset-delete"
                    style={{
                      position: 'absolute',
                      top: '6px',
                      right: '6px',
                      background: 'transparent',
                      border: 0,
                      color: 'var(--text-secondary, #9da2b4)',
                      cursor: 'pointer',
                      padding: '2px',
                      borderRadius: '4px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: 0.6,
                      transition: 'opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease',
                      zIndex: 2,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.opacity = '1';
                      e.currentTarget.style.background = 'var(--hover-fill, rgba(255,255,255,0.08))';
                      e.currentTarget.style.color = 'var(--danger-text, #f85149)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.opacity = '0.6';
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--text-secondary, #9da2b4)';
                    }}
                    onClick={(e) => deletePreset(preset.id, e)}
                  >
                    <CloseIcon size={10} />
                  </button>
                </div>
              ))}
              <button type="button" className="workspace-launcher__preset" onClick={savePreset}>
                <span className="workspace-launcher__preset-title">
                  <PlusIcon size={12} />
                  <span>New preset</span>
                </span>
                <small>Save this lineup, or build one seat by seat.</small>
              </button>
            </div>
            {missing.length > 0 ? (
              <small role="status">Not installed: {missing.join(', ')}.</small>
            ) : null}
          </section>

          <fieldset className="workspace-launcher__section">
            <legend className="ui-eyebrow">Agent</legend>
            <div className="workspace-launcher__agents">
              {engines.map((engine) => renderAgentChoice(engine.wireId, engine.displayName))}
              {renderAgentChoice('terminal', 'Terminal')}
            </div>
          </fieldset>

          <fieldset className="workspace-launcher__section">
            <legend className="ui-eyebrow">How many</legend>
            <div className="workspace-launcher__counts">
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`${value} ${value === 1 ? 'session' : 'sessions'}`}
                  aria-pressed={count === value}
                  onClick={() => {
                    setSelectedPresetId(null);
                    setCount(value);
                  }}
                >
                  {value}
                </button>
              ))}
              <span>{count === 1 ? 'session' : 'parallel sessions'}</span>
            </div>
          </fieldset>

          <section className="workspace-launcher__section" aria-labelledby="workspace-launch-lineup">
            <h2 className="ui-eyebrow" id="workspace-launch-lineup">
              Will launch
            </h2>
            <div className="workspace-launcher__lineup">
              {Array.from({ length: count }, (_, index) => (
                <div key={index} className="workspace-launcher__slot" title="Starts with no prompt">
                  <b>{index + 1}</b>
                  <BrandLogo engine={engineId} size={13} />
                  <span>{selectedName}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <footer className="workspace-launcher__footer">
        <span>
          {count} {count === 1 ? 'session' : 'sessions'} in {workspaceName}
        </span>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => onLaunch(engineId, count)}
        >
          <span aria-hidden="true" className="action-button__icon">
            <PlayIcon />
          </span>
          {count === 1 ? `Launch ${selectedName}` : `Launch ${count} sessions`}
        </button>
      </footer>
    </section>
  );
};
