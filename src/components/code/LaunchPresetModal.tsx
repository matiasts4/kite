import React, { useState } from 'react';
import type { AgentEngineDescriptor, LaunchPreset } from './types';
import { SquareTerminalIcon, PlusIcon, TrashIcon } from './codeIcons';
import { Sheet } from '../ui/Sheet';

export interface LaunchPresetModalProps {
  open: boolean;
  onClose: () => void;
  availableEngines: AgentEngineDescriptor[];
  presets?: LaunchPreset[];
  onLaunch: (preset: { title: string; engines: string[]; task: string }) => void;
}

export const LaunchPresetModal: React.FC<LaunchPresetModalProps> = ({
  open,
  onClose,
  availableEngines,
  presets = [],
  onLaunch,
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [customEngines, setCustomEngines] = useState<string[]>(() => {
    const defaultEng = availableEngines[0]?.wireId || 'terminal';
    return [defaultEng];
  });
  const [taskPrompt, setTaskPrompt] = useState<string>('');
  const [customTitle, setCustomTitle] = useState<string>('');

  if (!open) return null;

  const handleSelectPreset = (p: LaunchPreset) => {
    setSelectedPresetId(p.id);
    setCustomEngines([...p.engines]);
    setCustomTitle(p.title);
  };

  const handleSeatEngineChange = (index: number, newEngine: string) => {
    const updated = [...customEngines];
    updated[index] = newEngine;
    setCustomEngines(updated);
  };

  const handleAddSeat = () => {
    if (customEngines.length >= 6) return;
    setCustomEngines([...customEngines, 'terminal']);
  };

  const handleRemoveSeat = (index: number) => {
    if (customEngines.length <= 1) return;
    setCustomEngines(customEngines.filter((_, i) => i !== index));
  };

  const handleCommitLaunch = () => {
    const title = customTitle.trim() || 'Multi-seat Session';
    onLaunch({
      title,
      engines: customEngines,
      task: taskPrompt.trim(),
    });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onCancel={onClose}
      width={580}
      title="Launch Multi-Seat Lineup"
      description="Select a multi-pane preset or configure customized terminal and agent seats."
      primary={{
        label: `Launch ${customEngines.length} ${customEngines.length === 1 ? 'Session' : 'Sessions'}`,
        onClick: handleCommitLaunch,
      }}
      secondary={{
        label: 'Cancel',
        onClick: onClose,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {presets.length > 0 && (
          <div>
            <label
              style={{
                fontSize: 'var(--text-meta)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                display: 'block',
                marginBottom: 'var(--space-2)',
              }}
            >
              Preset Layout
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 'var(--space-2)',
              }}
            >
              {presets.map((p) => {
                const active = selectedPresetId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectPreset(p)}
                    style={{
                      padding: 'var(--space-3)',
                      borderRadius: 'var(--radius-card)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--block-stroke)'}`,
                      background: active ? 'var(--selected-fill)' : 'var(--block-fill)',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'border-color var(--duration-ink) var(--ease-ink), background-color var(--duration-ink) var(--ease-ink)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span
                        style={{
                          fontWeight: 'var(--weight-semibold)',
                          fontSize: 'var(--text-row)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {p.title}
                      </span>
                      <span
                        style={{
                          fontSize: 'var(--text-badge)',
                          padding: '1.5px 6px',
                          borderRadius: 'var(--radius-chip)',
                          background: 'var(--chip-fill)',
                          fontFamily: 'monospace',
                        }}
                      >
                        {p.seats} {p.seats === 1 ? 'seat' : 'seats'}
                      </span>
                    </div>
                    <p
                      style={{
                        fontSize: 'var(--text-caption)',
                        marginTop: 'var(--space-1)',
                        opacity: 0.8,
                        lineHeight: 'var(--leading-caption)',
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {p.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-2)',
            }}
          >
            <label
              style={{
                fontSize: 'var(--text-meta)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Seat Lineup ({customEngines.length} of 6)
            </label>
            {customEngines.length < 6 && (
              <button
                type="button"
                onClick={handleAddSeat}
                style={{
                  fontSize: 'var(--text-caption)',
                  color: 'var(--accent)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: 0,
                }}
              >
                <PlusIcon size={12} />
                <span>Add Seat</span>
              </button>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              maxHeight: '190px',
              overflowY: 'auto',
              paddingRight: '4px',
            }}
          >
            {customEngines.map((engine, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-chip)',
                  background: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  fontSize: 'var(--text-row)',
                }}
              >
                <span
                  style={{
                    width: '20px',
                    textAlign: 'center',
                    fontFamily: 'monospace',
                    color: 'var(--text-secondary)',
                    fontWeight: 'var(--weight-semibold)',
                  }}
                >
                  {idx + 1}
                </span>
                <SquareTerminalIcon size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <select
                  value={engine}
                  onChange={(e) => handleSeatEngineChange(idx, e.target.value)}
                  style={{
                    flex: 1,
                    fontSize: 'var(--text-row)',
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-chip)',
                    background: 'var(--composer)',
                    border: '1px solid var(--block-stroke)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                >
                  <option value="terminal">Interactive Terminal (ConPTY / PowerShell)</option>
                  {availableEngines.map((eng) => (
                    <option key={eng.wireId} value={eng.wireId}>
                      {eng.displayName} ({eng.vendor})
                    </option>
                  ))}
                </select>
                {customEngines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveSeat(idx)}
                    style={{
                      color: 'var(--text-secondary)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '4px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'var(--radius-chip)',
                    }}
                    title="Remove seat"
                  >
                    <TrashIcon size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="task-prompt-input"
            style={{
              fontSize: 'var(--text-meta)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              display: 'block',
              marginBottom: 'var(--space-1)',
            }}
          >
            Shared Task Prompt (Optional)
          </label>
          <textarea
            id="task-prompt-input"
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            rows={3}
            placeholder="Give your team an initial prompt or instruction to execute on startup…"
            style={{
              width: '100%',
              fontSize: 'var(--text-row)',
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-chip)',
              background: 'var(--composer)',
              border: '1px solid var(--block-stroke)',
              color: 'var(--text-primary)',
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>
    </Sheet>
  );
};
