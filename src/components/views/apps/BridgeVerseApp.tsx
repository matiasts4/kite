import React, { useState } from 'react';
import {
  IconGamepad,
  IconActivity,
  IconCheck,
  IconZap,
  IconTerminal,
  IconSparkles,
  IconCoffee,
  IconSend,
  IconVolume,
  IconVolumeX,
} from './appIcons';

interface VerseAgent {
  id: string;
  name: string;
  room: 'War Room' | 'Coding Lab' | 'Review Lounge' | 'Coffee Bar';
  state: 'working' | 'idle' | 'waiting' | 'stuck';
  currentTask: string;
  avatarColor: string;
  level: number;
  tokensPerSec: number;
  contextDepth: string;
  pendingApproval?: string;
}

const INITIAL_VERSE_AGENTS: VerseAgent[] = [
  {
    id: 'claude',
    name: 'Claude 3.7 Sonnet',
    room: 'Coding Lab',
    state: 'working',
    currentTask: 'Refactoring WebSocket async reconnect loop in rust backend',
    avatarColor: 'var(--brand-amber, #d97757)',
    level: 9,
    tokensPerSec: 134.5,
    contextDepth: '38.2k tokens',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    room: 'Coding Lab',
    state: 'working',
    currentTask: 'Synthesizing edge-case assertions for terminal ConPTY',
    avatarColor: 'var(--brand-bolt-blue, #3b82f6)',
    level: 7,
    tokensPerSec: 112.0,
    contextDepth: '18.4k tokens',
  },
  {
    id: 'gemini',
    name: 'Gemini 2.5 Pro',
    room: 'War Room',
    state: 'waiting',
    currentTask: 'Awaiting operator approval for SQLite database schema migration',
    avatarColor: 'var(--accent, #8b5cf6)',
    level: 10,
    tokensPerSec: 168.2,
    contextDepth: '64.0k tokens',
    pendingApproval: 'cargo run --release migrate-db --schema v2.0',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek R1',
    room: 'Review Lounge',
    state: 'working',
    currentTask: 'Verifying mathematical proof for zero-alloc byte buffer slicing',
    avatarColor: 'var(--brand-electric-blue, #06b6d4)',
    level: 8,
    tokensPerSec: 94.8,
    contextDepth: '24.1k tokens',
  },
  {
    id: 'grok',
    name: 'Grok 3 Reasoning',
    room: 'Coffee Bar',
    state: 'idle',
    currentTask: 'Chilling out after indexing 420 code repositories in 3 seconds',
    avatarColor: 'var(--text-secondary, #a1a1aa)',
    level: 6,
    tokensPerSec: 0,
    contextDepth: '12.0k tokens',
  },
];

const ROOMS: Array<VerseAgent['room']> = [
  'War Room',
  'Coding Lab',
  'Review Lounge',
  'Coffee Bar',
];

export interface BridgeVerseAppProps {
  embedded?: boolean;
}

export const BridgeVerseApp: React.FC<BridgeVerseAppProps> = ({ embedded = false }) => {
  const [agents, setAgents] = useState<VerseAgent[]>(INITIAL_VERSE_AGENTS);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('claude');
  const [newTaskInput, setNewTaskInput] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [pingNotice, setPingNotice] = useState<string | null>(null);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];

  const handleMoveAgent = (agentId: string, newRoom: VerseAgent['room']) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, room: newRoom } : a))
    );
  };

  const handleToggleState = (agentId: string) => {
    setAgents((prev) =>
      prev.map((a) => {
        if (a.id !== agentId) return a;
        const nextState =
          a.state === 'working' ? 'idle' : a.state === 'idle' ? 'working' : 'working';
        return { ...a, state: nextState };
      })
    );
  };

  const handleApprove = (agentId: string) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.id === agentId
          ? {
              ...a,
              state: 'working',
              pendingApproval: undefined,
              currentTask: `Executing approved operation: ${a.pendingApproval || 'task'}`,
            }
          : a
      )
    );
  };

  const handleDispatchTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskInput.trim()) return;
    setAgents((prev) =>
      prev.map((a) =>
        a.id === selectedAgent.id
          ? {
              ...a,
              currentTask: newTaskInput.trim(),
              state: 'working',
            }
          : a
      )
    );
    setNewTaskInput('');
  };

  const handlePing = (agentName: string) => {
    setPingNotice(`Ping sent to ${agentName} · acknowledged!`);
    setTimeout(() => setPingNotice(null), 3000);
  };

  const totalWorking = agents.filter((a) => a.state === 'working').length;
  const totalWaiting = agents.filter((a) => a.state === 'waiting').length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        userSelect: 'none',
        background: embedded ? 'transparent' : 'var(--pane)',
        overflow: 'hidden',
        color: 'var(--text-primary)',
      }}
    >
      {/* Top Header Status Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--separator)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <IconGamepad size={16} style={{ color: 'var(--accent)' }} />
          <h3
            style={{
              fontSize: 'var(--text-row)',
              fontWeight: 'var(--weight-semibold)',
              margin: 0,
            }}
          >
            KiteVerse Campus
          </h3>
          <span
            style={{
              fontSize: 'var(--text-badge)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--selected-fill)',
              color: 'var(--accent)',
              fontFamily: 'monospace',
              fontWeight: 'var(--weight-semibold)',
            }}
          >
            {totalWorking} active
          </span>
          {totalWaiting > 0 && (
            <span
              style={{
                fontSize: 'var(--text-badge)',
                padding: '1px 6px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--warning-tint)',
                color: 'var(--warning-text)',
                fontFamily: 'monospace',
                fontWeight: 'var(--weight-semibold)',
              }}
            >
              {totalWaiting} waiting
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <IconActivity size={12} style={{ color: 'var(--status-running)' }} />
            <span style={{ fontSize: 'var(--text-meta)' }}>Realtime Simulation</span>
          </div>
          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="chrome-button"
            title={soundEnabled ? 'Mute ambiance' : 'Enable ambiance'}
          >
            {soundEnabled ? <IconVolume size={13} /> : <IconVolumeX size={13} />}
          </button>
        </div>
      </div>

      {/* Ping Notification Toast */}
      {pingNotice && (
        <div
          style={{
            padding: 'var(--space-1) var(--space-4)',
            background: 'var(--selected-fill)',
            borderBottom: '1px solid var(--accent)',
            color: 'var(--accent)',
            fontSize: 'var(--text-caption)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <IconCheck size={12} />
            <span>{pingNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setPingNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: 'var(--text-badge)',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Campus Map & Side Inspector */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Rooms Grid */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: 'var(--space-3)',
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 'var(--space-3)',
            overflowY: 'auto',
            background: 'var(--block-fill)',
          }}
        >
          {ROOMS.map((room) => {
            const roomAgents = agents.filter((a) => a.room === room);
            return (
              <div
                key={room}
                style={{
                  background: 'var(--pane)',
                  border: '1px solid var(--block-stroke)',
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  minHeight: '150px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingBottom: 'var(--space-2)',
                    borderBottom: '1px solid var(--separator)',
                    marginBottom: 'var(--space-2)',
                    flexShrink: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {room === 'War Room' ? (
                      <IconZap size={13} style={{ color: 'var(--warning-text)' }} />
                    ) : room === 'Coding Lab' ? (
                      <IconTerminal size={13} style={{ color: 'var(--accent)' }} />
                    ) : room === 'Review Lounge' ? (
                      <IconSparkles size={13} style={{ color: 'var(--brand-amber)' }} />
                    ) : (
                      <IconCoffee size={13} style={{ color: 'var(--status-running)' }} />
                    )}
                    <span style={{ fontSize: 'var(--text-caption)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                      {room}
                    </span>
                  </div>
                  <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {roomAgents.length} desks
                  </span>
                </div>

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '2px 0' }}>
                  {roomAgents.length === 0 ? (
                    <div
                      style={{
                        height: '56px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 'var(--text-caption)',
                        color: 'var(--text-secondary)',
                        fontStyle: 'italic',
                      }}
                    >
                      Empty zone · Drag or assign agents here
                    </div>
                  ) : (
                    roomAgents.map((ag) => (
                      <div
                        key={ag.id}
                        onClick={() => setSelectedAgentId(ag.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: 'var(--space-2)',
                          borderRadius: 'var(--radius-row)',
                          cursor: 'pointer',
                          border: `1px solid ${selectedAgent.id === ag.id ? 'var(--accent)' : 'var(--block-stroke)'}`,
                          background: selectedAgent.id === ag.id ? 'var(--selected-fill)' : 'var(--block-fill)',
                          transition: 'background-color var(--duration-ink) var(--ease-ink)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
                          <span
                            style={{
                              width: '24px',
                              height: '24px',
                              borderRadius: 'var(--radius-chip)',
                              background: ag.avatarColor,
                              color: '#ffffff',
                              fontSize: '11px',
                              fontWeight: 'bold',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            {ag.name.charAt(0)}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <h4
                              style={{
                                fontSize: 'var(--text-caption)',
                                fontWeight: 'var(--weight-medium)',
                                color: 'var(--text-primary)',
                                margin: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ag.name}
                            </h4>
                            <p
                              style={{
                                fontSize: 'var(--text-meta)',
                                color: 'var(--text-secondary)',
                                margin: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '130px',
                              }}
                            >
                              {ag.currentTask}
                            </p>
                          </div>
                        </div>

                        <span
                          style={{
                            width: '7px',
                            height: '7px',
                            borderRadius: '50%',
                            flexShrink: 0,
                            background:
                              ag.state === 'working'
                                ? 'var(--status-running)'
                                : ag.state === 'waiting'
                                ? 'var(--warning)'
                                : ag.state === 'stuck'
                                ? 'var(--status-failed)'
                                : 'var(--text-faint)',
                          }}
                          title={`Status: ${ag.state}`}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected Agent Inspector */}
        <div
          style={{
            width: '240px',
            borderLeft: '1px solid var(--separator)',
            background: 'var(--pane)',
            padding: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flexShrink: 0,
            overflowY: 'auto',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <span
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: 'var(--radius-card)',
                  background: selectedAgent.avatarColor,
                  color: '#ffffff',
                  fontWeight: 'bold',
                  fontSize: '15px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selectedAgent.name.charAt(0)}
              </span>
              <div style={{ minWidth: 0 }}>
                <h4
                  style={{
                    fontSize: 'var(--text-row)',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)',
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selectedAgent.name}
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: 'var(--radius-chip)',
                      background: 'var(--chip-fill)',
                      color: 'var(--accent)',
                      fontFamily: 'monospace',
                    }}
                  >
                    Lvl {selectedAgent.level}
                  </span>
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: 'var(--radius-chip)',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      background:
                        selectedAgent.state === 'working'
                          ? 'var(--selected-fill)'
                          : selectedAgent.state === 'waiting'
                          ? 'var(--warning-tint)'
                          : 'var(--chip-fill)',
                      color:
                        selectedAgent.state === 'working'
                          ? 'var(--accent)'
                          : selectedAgent.state === 'waiting'
                          ? 'var(--warning-text)'
                          : 'var(--text-secondary)',
                    }}
                  >
                    {selectedAgent.state}
                  </span>
                </div>
              </div>
            </div>

            {selectedAgent.state === 'waiting' && selectedAgent.pendingApproval && (
              <div
                style={{
                  marginBottom: 'var(--space-3)',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--warning-tint)',
                  border: '1px solid var(--warning)',
                  color: 'var(--warning-text)',
                }}
              >
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 'bold',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    display: 'block',
                    marginBottom: '4px',
                  }}
                >
                  Action Requires Approval
                </span>
                <p
                  style={{
                    fontSize: 'var(--text-meta)',
                    fontFamily: 'monospace',
                    background: 'var(--block-fill)',
                    padding: '4px 6px',
                    borderRadius: 'var(--radius-chip)',
                    border: '1px solid var(--block-stroke)',
                    wordBreak: 'break-all',
                    margin: '0 0 var(--space-2)',
                  }}
                >
                  {selectedAgent.pendingApproval}
                </p>
                <button
                  type="button"
                  onClick={() => handleApprove(selectedAgent.id)}
                  className="primary-button"
                  style={{ width: '100%', fontSize: 'var(--text-caption)' }}
                >
                  <IconCheck size={12} />
                  <span>Approve &amp; Resume</span>
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <label
                  style={{
                    fontSize: '10px',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    display: 'block',
                    marginBottom: '4px',
                  }}
                >
                  Assigned Zone
                </label>
                <select
                  value={selectedAgent.room}
                  onChange={(e) =>
                    handleMoveAgent(selectedAgent.id, e.target.value as VerseAgent['room'])
                  }
                  className="ui-field"
                  style={{ width: '100%', fontSize: 'var(--text-caption)', height: '28px' }}
                >
                  {ROOMS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  style={{
                    fontSize: '10px',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    display: 'block',
                    marginBottom: '4px',
                  }}
                >
                  Active Thought / Task
                </label>
                <p
                  style={{
                    fontSize: 'var(--text-caption)',
                    color: 'var(--text-secondary)',
                    background: 'var(--block-fill)',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-chip)',
                    border: '1px solid var(--block-stroke)',
                    lineHeight: 'var(--leading-caption)',
                    margin: 0,
                  }}
                >
                  {selectedAgent.currentTask}
                </p>
              </div>

              <div>
                <label
                  style={{
                    fontSize: '10px',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    display: 'block',
                    marginBottom: '4px',
                  }}
                >
                  Telemetry
                </label>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: 'var(--text-meta)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'monospace',
                    background: 'var(--block-fill)',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-chip)',
                    border: '1px solid var(--block-stroke)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Speed:</span>
                    <span style={{ color: 'var(--text-primary)' }}>{selectedAgent.tokensPerSec} t/s</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Context:</span>
                    <span style={{ color: 'var(--text-primary)' }}>{selectedAgent.contextDepth}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Heartbeat:</span>
                    <span style={{ color: 'var(--status-running)' }}>38ms OK</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions & Prompt Dispatch */}
          <div style={{ paddingTop: 'var(--space-3)', borderTop: '1px solid var(--separator)', marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <form onSubmit={handleDispatchTask} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="text"
                value={newTaskInput}
                onChange={(e) => setNewTaskInput(e.target.value)}
                placeholder="Assign task to agent…"
                className="ui-field"
                style={{ flex: 1, height: '28px', fontSize: 'var(--text-caption)' }}
              />
              <button
                type="submit"
                className="primary-button"
                style={{ height: '28px', padding: '0 8px' }}
                title="Dispatch Task"
              >
                <IconSend size={12} />
              </button>
            </form>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' }}>
              <button
                type="button"
                onClick={() => handlePing(selectedAgent.name)}
                className="primary-button"
                style={{ height: '28px', fontSize: 'var(--text-caption)', padding: '0 8px' }}
              >
                <IconSend size={11} />
                <span>Ping</span>
              </button>
              <button
                type="button"
                onClick={() => handleToggleState(selectedAgent.id)}
                className="secondary-button"
                style={{ height: '28px', fontSize: 'var(--text-caption)', padding: '0 8px' }}
              >
                {selectedAgent.state === 'working' ? 'Set Idle' : 'Activate'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
