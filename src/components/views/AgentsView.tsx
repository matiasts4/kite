import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invokeCommand } from '../../lib/ipc';
import type { AgentProfile } from '../../types';
import { AgentAvatar } from '../AgentAvatar';
import { ChatView } from './ChatView';
import {
  LearnedSkillDocument,
  AgentMindSnapshot,
  StarterSummary,
  FullAgentProfile,
  TabType,
  MemoryTarget,
  MEMORY_DELIMITER,
  parseMemoryEntries,
} from './agents/types';
import { AgentMemoryTab } from './agents/AgentMemoryTab';
import { AgentSkillsTab } from './agents/AgentSkillsTab';
import { AgentStartersTab } from './agents/AgentStartersTab';
import { AgentSettingsTab } from './agents/AgentSettingsTab';
import { AgentTerminalPane } from './agents/AgentTerminalPane';
import { AgentCreatePane } from './agents/AgentCreatePane';
import {
  getEngineDisplayName as getCanonicalEngineDisplayName,
  supportsAgentChat,
} from './agents/engineMetadata';

export type {
  LearnedSkillDocument,
  AgentMindSnapshot,
  StarterSummary,
  FullAgentProfile,
  TabType,
  MemoryTarget,
};

import {
  SettingsIcon,
  CloseIcon,
  BrainIcon,
  WandIcon,
  SlidersIcon,
  BotIcon,
} from './agents/agentIcons';

export function getEngineDisplayName(engine?: string | null): string {
  return getCanonicalEngineDisplayName(engine);
}

export const CHAT_SUPPORTED_ENGINES = new Set([
  'claude-code',
  'claude',
  'codex',
  'antigravity',
  'grok',
  'open-code',
  'opencode',
  'cursor',
  'gemini',
]);

export function isLlmEngine(engine?: string | null): boolean {
  return supportsAgentChat(engine);
}

// Subcomponent: AgentChatSurface
export interface AgentChatSurfaceProps {
  agent: AgentProfile;
  agents: AgentProfile[];
}

export const AgentChatSurface: React.FC<AgentChatSurfaceProps> = ({ agent, agents }) => {
  return (
    <ChatView
      workspaceId={null}
      agentId={agent.id}
      agentName={agent.name}
      agentEngine={agent.engine}
      engineLabel={getEngineDisplayName(agent.engine)}
      agents={agents}
    />
  );
};

export interface AgentsViewProps {
  agents?: AgentProfile[];
  workspaceId?: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  agentEditorOpen?: boolean;
  onCloseAgentEditor?: () => void;
  onAgentCreated?: (agent: AgentProfile) => void;
  onAgentUpdated?: (agent: AgentProfile) => void;
  onAgentDeleted?: (agentId: string) => void;
  initialMode?: 'chats' | 'settings' | 'memory' | 'skills' | 'starters';
  viewMode?: 'chats' | 'settings' | 'memory' | 'skills' | 'starters';
  onViewModeChange?: (mode: 'chats' | 'settings' | 'memory' | 'skills' | 'starters') => void;
  onOpenRoutines?: () => void;
  runningCount?: number;
}

export const AgentsView: React.FC<AgentsViewProps> = ({
  agents: agentsProp,
  workspaceId,
  selectedAgentId,
  onSelectAgent,
  agentEditorOpen,
  onCloseAgentEditor,
  onAgentCreated,
  onAgentUpdated,
  onAgentDeleted: _onAgentDeleted,
  initialMode = 'chats',
  viewMode: controlledViewMode,
  onViewModeChange,
  onOpenRoutines,
  runningCount: runningCountProp,
}) => {
  const [internalAgents, setInternalAgents] = useState<AgentProfile[]>([]);
  const agents = agentsProp ?? internalAgents;

  const [internalViewMode, setInternalViewMode] = useState<'chats' | 'settings' | 'memory' | 'skills' | 'starters'>(initialMode);
  const viewMode = controlledViewMode ?? internalViewMode;

  const setViewMode = useCallback(
    (mode: 'chats' | 'settings' | 'memory' | 'skills' | 'starters') => {
      setInternalViewMode(mode);
      onViewModeChange?.(mode);
    },
    [onViewModeChange]
  );

  const [lastSettingsTab, setLastSettingsTab] = useState<'settings' | 'memory' | 'skills'>('settings');
  const [surfacePreference, setSurfacePreference] = useState<'chat' | 'terminal'>('chat');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [liveRunningCount, setLiveRunningCount] = useState<number>(0);

  // Active agent state
  const [profile, setProfile] = useState<FullAgentProfile | null>(null);
  const [mind, setMind] = useState<AgentMindSnapshot | null>(null);
  const [starters, setStarters] = useState<StarterSummary[]>([]);

  // Memory tab state
  const [memoryTarget, setMemoryTarget] = useState<MemoryTarget>('memory');
  const [lastDeletedEntry, setLastDeletedEntry] = useState<{ target: MemoryTarget; index: number; text: string } | null>(null);
  const [memorySaving, setMemorySaving] = useState<boolean>(false);

  // Skills tab state
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<LearnedSkillDocument | null>(null);
  const [skillLoading, setSkillLoading] = useState<boolean>(false);
  const [skillSaving, setSkillSaving] = useState<boolean>(false);

  // Starters tab state
  const [installingStarterId, setInstallingStarterId] = useState<string | null>(null);

  // Settings tab state
  const [settingsDraft, setSettingsDraft] = useState<{
    name: string;
    purpose: string;
    engine: string;
    memoryBudget: number;
    reflectionMode: string;
    allowAgentScheduling: boolean;
    allowAgentMessaging: boolean;
    defaultMode?: string | null;
    defaultPlan?: boolean;
    defaultModel?: string | null;
    avatar?: any;
  }>({
    name: '',
    purpose: '',
    engine: 'antigravity',
    memoryBudget: 2200,
    reflectionMode: 'ask',
    allowAgentScheduling: true,
    allowAgentMessaging: true,
    defaultMode: null,
    defaultPlan: false,
    defaultModel: null,
    avatar: null,
  });
  const [settingsDirty, setSettingsDirty] = useState<boolean>(false);
  const [internalCreatingAgent, setInternalCreatingAgent] = useState(false);
  const isCreating = agentEditorOpen !== undefined ? agentEditorOpen : internalCreatingAgent;

  const showNotification = useCallback((message: string) => {
    setSuccessNotice(message);
    setTimeout(() => {
      setSuccessNotice((current) => (current === message ? null : current));
    }, 3500);
  }, []);

  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;

  // 1. Load initial agent list & starters
  const fetchAgentsAndStarters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [roster, startersList] = await Promise.all([
        agentsProp ? Promise.resolve(agentsProp) : invokeCommand<AgentProfile[]>('list_agent_profiles'),
        invokeCommand<StarterSummary[]>('list_agent_starters', { supportedCatalogVersion: 1 }).catch(() => []),
      ]);
      if (!agentsProp) {
        setInternalAgents(roster);
      }
      setStarters(startersList);

      if (roster.length > 0) {
        const targetId = selectedAgentId && roster.some((a) => a.id === selectedAgentId)
          ? selectedAgentId
          : roster[0].id;
        if (targetId !== selectedAgentId) {
          onSelectAgentRef.current(targetId);
        }
      }
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to load agents roster:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to agent roster');
    } finally {
      setLoading(false);
    }
  }, [agentsProp, selectedAgentId]);

  useEffect(() => {
    void fetchAgentsAndStarters();
  }, [fetchAgentsAndStarters]);

  useEffect(() => {
    const openCreate = () => setInternalCreatingAgent(true);
    window.addEventListener('studio-new-agent', openCreate);
    return () => window.removeEventListener('studio-new-agent', openCreate);
  }, []);

  useEffect(() => {
    setInternalCreatingAgent(false);
  }, [selectedAgentId]);

  // 2. Load selected agent profile and mind
  const loadAgentData = useCallback(async (agentId: string) => {
    setError(null);
    try {
      const [fullProf, mindSnap] = await Promise.all([
        invokeCommand<FullAgentProfile>('load_agent_profile', { agentId }).catch(() => null),
        invokeCommand<AgentMindSnapshot>('load_agent_mind', { agentId }),
      ]);

      if (fullProf) {
        setProfile(fullProf);
        setSettingsDraft({
          name: fullProf.name || '',
          purpose: fullProf.purpose || fullProf.brief || '',
          engine: fullProf.engine || 'antigravity',
          memoryBudget: fullProf.memoryBudget || 2200,
          reflectionMode: fullProf.reflectionMode || 'ask',
          allowAgentScheduling: fullProf.allowAgentScheduling ?? true,
          allowAgentMessaging: fullProf.allowAgentMessaging ?? true,
          defaultMode: fullProf.defaultMode || null,
          defaultPlan: Boolean(fullProf.defaultPlan),
          defaultModel: fullProf.defaultModel || null,
          avatar: fullProf.avatar || null,
        });
        setSettingsDirty(false);
      }
      setMind(mindSnap);
      setSelectedSkillId(null);
      setSkillDocument(null);
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to load agent mind/profile:', err);
      setError(err instanceof Error ? err.message : 'Failed to load agent memory');
    }
  }, []);

  useEffect(() => {
    if (selectedAgentId) {
      void loadAgentData(selectedAgentId);
    }
  }, [selectedAgentId, loadAgentData]);

  // Poll live running tasks for active agent
  useEffect(() => {
    let isMounted = true;
    const pollLiveRuns = async () => {
      try {
        const runs = await invokeCommand<Array<{ agentId?: string; status?: string }>>('list_live_chat_runs');
        if (isMounted && Array.isArray(runs) && selectedAgentId) {
          const count = runs.filter(
            (r) => r.agentId === selectedAgentId && (r.status === 'running' || r.status === 'waiting')
          ).length;
          setLiveRunningCount(count);
        }
      } catch {
        // Silent background fallback
      }
    };

    void pollLiveRuns();
    const timer = setInterval(() => {
      void pollLiveRuns();
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [selectedAgentId]);

  // 4. Memory Handlers
  const handleSaveRawMemory = async (draft: string) => {
    const activeRevision = memoryTarget === 'memory' ? mind?.memoryRevision : mind?.userRevision;
    if (!profile || !mind || !activeRevision) return;
    setMemorySaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_memory', {
        agentId: profile.id,
        target: memoryTarget,
        text: draft,
        editKind: 'rawBuilderEdit',
        expectedRevision: activeRevision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      showNotification('Raw memory file saved.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to save raw memory:', err);
      setError(err instanceof Error ? err.message : 'Failed to save raw memory');
    } finally {
      setMemorySaving(false);
    }
  };

  const handleAddMemoryNote = async (text: string) => {
    const activeText = memoryTarget === 'memory' ? mind?.memory : mind?.user;
    const activeRevision = memoryTarget === 'memory' ? mind?.memoryRevision : mind?.userRevision;
    if (!profile || !mind || !activeRevision) return;

    const currentEntries = parseMemoryEntries(activeText || '');
    if (currentEntries.includes(text)) return;

    const nextEntries = [...currentEntries, text];
    const joinedText = nextEntries.join(MEMORY_DELIMITER);

    setMemorySaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_memory', {
        agentId: profile.id,
        target: memoryTarget,
        text: joinedText,
        editKind: 'structured',
        expectedRevision: activeRevision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      showNotification('Note added to agent memory.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to add note:', err);
      setError(err instanceof Error ? err.message : 'Failed to add note');
    } finally {
      setMemorySaving(false);
    }
  };

  const handleSaveInlineEntry = async (index: number, draft: string) => {
    const activeText = memoryTarget === 'memory' ? mind?.memory : mind?.user;
    const activeRevision = memoryTarget === 'memory' ? mind?.memoryRevision : mind?.userRevision;
    if (!profile || !mind || !activeRevision) return;

    const currentEntries = parseMemoryEntries(activeText || '');
    const trimmed = draft.trim();
    const nextEntries = [...currentEntries];

    if (trimmed.length === 0) {
      nextEntries.splice(index, 1);
    } else {
      nextEntries[index] = trimmed;
    }
    const joinedText = nextEntries.join(MEMORY_DELIMITER);

    setMemorySaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_memory', {
        agentId: profile.id,
        target: memoryTarget,
        text: joinedText,
        editKind: 'structured',
        expectedRevision: activeRevision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      showNotification('Memory entry updated.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to edit entry:', err);
      setError(err instanceof Error ? err.message : 'Failed to update entry');
    } finally {
      setMemorySaving(false);
    }
  };

  const handleDeleteEntry = async (index: number, text: string) => {
    const activeText = memoryTarget === 'memory' ? mind?.memory : mind?.user;
    const activeRevision = memoryTarget === 'memory' ? mind?.memoryRevision : mind?.userRevision;
    if (!profile || !mind || !activeRevision) return;

    const currentEntries = parseMemoryEntries(activeText || '');
    const nextEntries = [...currentEntries];
    nextEntries.splice(index, 1);
    const joinedText = nextEntries.join(MEMORY_DELIMITER);

    setMemorySaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_memory', {
        agentId: profile.id,
        target: memoryTarget,
        text: joinedText,
        editKind: 'structured',
        expectedRevision: activeRevision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      setLastDeletedEntry({ target: memoryTarget, index, text });
      showNotification('Memory entry removed.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to delete entry:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete entry');
    } finally {
      setMemorySaving(false);
    }
  };

  const handleUndoDeleteEntry = async () => {
    const activeText = memoryTarget === 'memory' ? mind?.memory : mind?.user;
    const activeRevision = memoryTarget === 'memory' ? mind?.memoryRevision : mind?.userRevision;
    if (!lastDeletedEntry || lastDeletedEntry.target !== memoryTarget || !profile || !mind || !activeRevision) return;

    const currentEntries = parseMemoryEntries(activeText || '');
    const nextEntries = [...currentEntries];
    const targetIdx = Math.min(lastDeletedEntry.index, nextEntries.length);
    nextEntries.splice(targetIdx, 0, lastDeletedEntry.text);
    const joinedText = nextEntries.join(MEMORY_DELIMITER);

    setMemorySaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_memory', {
        agentId: profile.id,
        target: memoryTarget,
        text: joinedText,
        editKind: 'structured',
        expectedRevision: activeRevision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      setLastDeletedEntry(null);
      showNotification('Restored deleted entry.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to undo delete:', err);
      setError(err instanceof Error ? err.message : 'Failed to restore entry');
    } finally {
      setMemorySaving(false);
    }
  };

  // 5. Skills Handlers
  const handleSelectSkill = async (skillId: string) => {
    if (!profile) return;
    setSelectedSkillId(skillId);
    setSkillLoading(true);
    setError(null);
    try {
      const doc = await invokeCommand<LearnedSkillDocument>('load_agent_skill', {
        agentId: profile.id,
        skillId,
      });
      setSkillDocument(doc);
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to load skill document:', err);
      setError(err instanceof Error ? err.message : 'Failed to open skill');
    } finally {
      setSkillLoading(false);
    }
  };

  const handleSaveSkill = async (source: string) => {
    if (!profile || !skillDocument) return;
    if (source.trim().length === 0) {
      setError('Skill draft cannot be empty.');
      return;
    }
    setSkillSaving(true);
    setError(null);
    try {
      const updatedMind = await invokeCommand<AgentMindSnapshot>('write_agent_skill', {
        agentId: profile.id,
        skillId: skillDocument.id,
        source,
        expectedRevision: skillDocument.revision,
        confirmedByBuilder: true,
      });
      setMind(updatedMind);
      await handleSelectSkill(skillDocument.id);
      showNotification(`Skill "${skillDocument.name}" saved.`);
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to save skill:', err);
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSkillSaving(false);
    }
  };

  const handleDeleteSkill = async () => {
    if (!profile || !skillDocument) return;
    setSkillSaving(true);
    setError(null);
    try {
      const result = await invokeCommand<{ removed: boolean; mind: AgentMindSnapshot }>('remove_agent_skill', {
        agentId: profile.id,
        skillId: skillDocument.id,
        expectedRevision: skillDocument.revision,
        confirmedByBuilder: true,
      });
      setMind(result.mind);
      setSelectedSkillId(null);
      setSkillDocument(null);
      showNotification(`Skill "${skillDocument.name}" deleted.`);
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to delete skill:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete skill');
    } finally {
      setSkillSaving(false);
    }
  };

  // 6. Starters Handler
  const handleInstallStarter = async (starterId: string) => {
    if (!profile) return;
    setInstallingStarterId(starterId);
    setError(null);
    try {
      const res = await invokeCommand<{ installed: boolean; mind: AgentMindSnapshot }>('install_agent_starter', {
        agentId: profile.id,
        starterId,
        confirmedByBuilder: true,
      });
      setMind(res.mind);
      showNotification(`Starter "${starterId}" installed successfully.`);
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to install starter:', err);
      setError(err instanceof Error ? err.message : 'Failed to install starter');
    } finally {
      setInstallingStarterId(null);
    }
  };

  // 7. Settings Handlers
  const handleSaveSettings = async () => {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      const updatedProfile = await invokeCommand<AgentProfile>('update_agent_profile', {
        agentId: profile.id,
        name: settingsDraft.name,
        brief: settingsDraft.purpose,
        engine: settingsDraft.engine,
        avatar: settingsDraft.avatar ? (typeof settingsDraft.avatar === 'string' ? settingsDraft.avatar : JSON.stringify(settingsDraft.avatar)) : null,
        memoryBudget: settingsDraft.memoryBudget,
        reflectionMode: settingsDraft.reflectionMode,
        allowAgentScheduling: settingsDraft.allowAgentScheduling,
        allowAgentMessaging: settingsDraft.allowAgentMessaging,
        defaultMode: settingsDraft.defaultMode,
        defaultPlan: settingsDraft.defaultPlan ? 'true' : 'false',
        defaultModel: settingsDraft.defaultModel,
      });
      if (onAgentUpdated && updatedProfile) {
        onAgentUpdated(updatedProfile);
      } else {
        const updatedRoster = await invokeCommand<AgentProfile[]>('list_agent_profiles');
        setInternalAgents(updatedRoster);
      }
      setSettingsDirty(false);
      showNotification('Agent settings saved.');
    } catch (err: unknown) {
      console.error('[AgentsView] Failed to save settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  const handleRevertSettings = () => {
    if (!profile) return;
    setSettingsDraft({
      name: profile.name || '',
      purpose: profile.purpose || profile.brief || '',
      engine: profile.engine || 'antigravity',
      memoryBudget: profile.memoryBudget || 2200,
      reflectionMode: profile.reflectionMode || 'ask',
      allowAgentScheduling: profile.allowAgentScheduling ?? true,
      allowAgentMessaging: profile.allowAgentMessaging ?? true,
      defaultMode: profile.defaultMode || null,
      defaultPlan: Boolean(profile.defaultPlan),
      defaultModel: profile.defaultModel || null,
      avatar: profile.avatar || null,
    });
    setSettingsDirty(false);
  };

  const handleSelectTab = (tab: 'settings' | 'memory' | 'skills' | 'starters') => {
    setViewMode(tab);
    if (tab !== 'starters') {
      setLastSettingsTab(tab);
    }
  };

  const handleToggleSettings = () => {
    if (viewMode === 'chats') {
      setViewMode(lastSettingsTab);
    } else {
      setViewMode('chats');
    }
  };

  if (isCreating) {
    return (
      <AgentCreatePane
        agents={agents}
        onCancel={() => {
          if (onCloseAgentEditor) {
            onCloseAgentEditor();
          } else {
            setInternalCreatingAgent(false);
          }
        }}
        onCreated={(agent) => {
          if (onAgentCreated) {
            onAgentCreated(agent);
          } else {
            setInternalAgents((current) => (current.some((item) => item.id === agent.id) ? current : [...current, agent]));
          }
          onSelectAgent(agent.id);
          if (onCloseAgentEditor) {
            onCloseAgentEditor();
          } else {
            setInternalCreatingAgent(false);
          }
          window.dispatchEvent(new CustomEvent('studio-agent-created', { detail: agent }));
        }}
      />
    );
  }

  if (loading && agents.length === 0) {
    return (
      <section className="pane agent-pane">
        <div className="agent-detail-state">
          <div className="ui-status-notice" data-tone="loading" role="status">
            <div className="ui-status-notice__copy">
              <strong>Opening Agent view…</strong>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0] || null;

  if (!selectedAgent) {
    return (
      <section className="pane empty-roster-surface empty-surface">
        <span aria-hidden="true" className="empty-surface__icon">
          <BotIcon size={30} />
        </span>
        <div className="empty-surface__copy">
          <h1>No agents yet</h1>
          <p>
            An agent is a teammate you name — “X content expert”, “Release notes writer”, “Inbox triage” — and hand real work to. It remembers what it learns about your work and writes down the procedures it figures out, so it’s better next month than it is today. Claude Code or Codex is only the engine underneath.
          </p>
        </div>
        <div className="empty-surface__action">
          <button
            type="button"
            className="primary-button"
            onClick={() => setInternalCreatingAgent(true)}
          >
            New Agent
          </button>
        </div>
      </section>
    );
  }

  const memoryNoteCount = mind ? parseMemoryEntries(mind.memory).length + parseMemoryEntries(mind.user).length : 0;
  const skillsCount = mind ? mind.skills.length : 0;
  const currentRunningCount = runningCountProp ?? liveRunningCount;
  const isLlm = isLlmEngine(selectedAgent.engine);

  return (
    <section className="pane agent-pane">
      {/* Pane TitleBar Header */}
      <header className="agent-pane__header">
        <AgentAvatar
          id={selectedAgent.id}
          choice={selectedAgent.avatar}
          size={28}
          state={currentRunningCount > 0 ? 'running' : 'idle'}
        />

        <span className="agent-pane__identity">
          <h1>{profile?.id === selectedAgent.id && profile.name ? profile.name : selectedAgent.name}</h1>
          <small>
            Powered by {getEngineDisplayName(selectedAgent.engine)}
          </small>
        </span>

        {viewMode === 'chats' && (
          <span className={`running-pill${currentRunningCount > 0 ? ' running-pill--live' : ''}`}>
            <i />
            {currentRunningCount} working
          </span>
        )}

        {viewMode === 'chats' && isLlm && (
          <div
            role="group"
            aria-label="Interaction surface"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px',
              borderRadius: '6px',
              background: 'var(--chip-fill, rgba(255,255,255,0.06))',
              border: '1px solid var(--block-stroke, rgba(255,255,255,0.08))',
              gap: '2px',
            }}
          >
            <button
              type="button"
              onClick={() => setSurfacePreference('chat')}
              aria-pressed={surfacePreference === 'chat'}
              title="Use conversational Chat UI"
              style={{
                height: '22px',
                padding: '0 8px',
                fontSize: '11px',
                fontWeight: 500,
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                background: surfacePreference === 'chat' ? 'var(--selected-fill, rgba(255,255,255,0.12))' : 'transparent',
                color: surfacePreference === 'chat' ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setSurfacePreference('terminal')}
              aria-pressed={surfacePreference === 'terminal'}
              title="Open interactive CLI Terminal"
              style={{
                height: '22px',
                padding: '0 8px',
                fontSize: '11px',
                fontWeight: 500,
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                background: surfacePreference === 'terminal' ? 'var(--selected-fill, rgba(255,255,255,0.12))' : 'transparent',
                color: surfacePreference === 'terminal' ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              Terminal
            </button>
          </div>
        )}

        <button
          type="button"
          className="agent-settings-toggle"
          onClick={handleToggleSettings}
          aria-label={viewMode === 'chats' ? 'Agent settings' : 'Close agent settings'}
          aria-pressed={viewMode !== 'chats'}
          title={viewMode === 'chats' ? 'Settings, memory, and skills' : 'Close settings and go back to the chats'}
        >
          {viewMode === 'chats' ? <SettingsIcon size={13} /> : <CloseIcon size={13} />}
          {viewMode === 'chats' && memoryNoteCount + skillsCount > 0 && (
            <i aria-hidden="true" className="agent-settings-toggle__dot" />
          )}
        </button>
      </header>

      <div className="agent-pane__rule" />

      {/* Navigation Tabs (Hidden when in 'chats' mode) */}
      {viewMode !== 'chats' && (
        <nav aria-label={`${selectedAgent.name} settings sections`} className="agent-face-tabs ui-tabs">
          <div className="ui-tabs__list">
            <button
              type="button"
              aria-label="Agent Settings"
              className={viewMode === 'settings' ? 'ui-tab ui-tab--selected' : 'ui-tab'}
              onClick={() => handleSelectTab('settings')}
              aria-current={viewMode === 'settings' ? 'page' : undefined}
              title="Name, face, engine, brief, and the defaults new chats inherit"
            >
              <SlidersIcon size={12} />
              <span className="ui-tab__label" data-label="Settings">Settings</span>
            </button>

            <button
              type="button"
              aria-label={memoryNoteCount > 0 ? `Agent Memory, ${memoryNoteCount}` : 'Agent Memory'}
              className={viewMode === 'memory' ? 'ui-tab ui-tab--selected' : 'ui-tab'}
              onClick={() => handleSelectTab('memory')}
              aria-current={viewMode === 'memory' ? 'page' : undefined}
              title={
                memoryNoteCount > 0
                  ? `What this agent knows between chats — ${memoryNoteCount}`
                  : 'What this agent knows between chats'
              }
            >
              <BrainIcon size={12} />
              <span className="ui-tab__label" data-label="Memory">Memory</span>
              {memoryNoteCount > 0 && <span className="ui-tab__count" data-count="">{memoryNoteCount}</span>}
            </button>

            <button
              type="button"
              aria-label={skillsCount > 0 ? `Agent Skills, ${skillsCount}` : 'Agent Skills'}
              className={viewMode === 'skills' || viewMode === 'starters' ? 'ui-tab ui-tab--selected' : 'ui-tab'}
              onClick={() => {
                handleSelectTab('skills');
                setSelectedSkillId(null);
              }}
              aria-current={viewMode === 'skills' || viewMode === 'starters' ? 'page' : undefined}
              title={
                skillsCount > 0
                  ? `Procedures this agent wrote for itself — ${skillsCount}`
                  : 'Procedures this agent wrote for itself'
              }
            >
              <WandIcon size={12} />
              <span className="ui-tab__label" data-label="Skills">Skills</span>
              {skillsCount > 0 && <span className="ui-tab__count" data-count="">{skillsCount}</span>}
            </button>
          </div>
        </nav>
      )}

      {/* Content Surfaces */}
      {viewMode === 'chats' && isLlm && surfacePreference === 'chat' && (
        <AgentChatSurface agent={selectedAgent} agents={agents} />
      )}

      {viewMode === 'chats' && (!isLlm || surfacePreference === 'terminal') && (
        <AgentTerminalPane
          agentId={selectedAgent.id}
          agentName={selectedAgent.name}
          engine={selectedAgent.engine}
          workspaceId={workspaceId}
        />
      )}

      {viewMode === 'memory' && (
        <AgentMemoryTab
          agentName={selectedAgent.name}
          mind={mind}
          memoryTarget={memoryTarget}
          setMemoryTarget={setMemoryTarget}
          memoryBudget={settingsDraft.memoryBudget}
          memorySaving={memorySaving}
          lastDeletedEntry={lastDeletedEntry}
          error={error}
          successMessage={successNotice}
          onSaveRawMemory={handleSaveRawMemory}
          onAddMemoryNote={handleAddMemoryNote}
          onSaveInlineEntry={handleSaveInlineEntry}
          onDeleteEntry={handleDeleteEntry}
          onUndoDeleteEntry={handleUndoDeleteEntry}
        />
      )}

      {viewMode === 'skills' && (
        <AgentSkillsTab
          agentName={selectedAgent.name}
          mind={mind}
          selectedSkillId={selectedSkillId}
          skillDocument={skillDocument}
          skillLoading={skillLoading}
          skillSaving={skillSaving}
          starters={starters}
          onInstallStarter={handleInstallStarter}
          onSelectSkill={handleSelectSkill}
          onSaveSkill={handleSaveSkill}
          onDeleteSkill={handleDeleteSkill}
          onClearSelectedSkill={() => {
            setSelectedSkillId(null);
            setSkillDocument(null);
          }}
          onNavigateToStarters={() => handleSelectTab('starters')}
        />
      )}

      {viewMode === 'starters' && (
        <AgentStartersTab
          agentName={selectedAgent.name}
          mind={mind}
          starters={starters}
          installingStarterId={installingStarterId}
          onInstallStarter={handleInstallStarter}
        />
      )}

      {viewMode === 'settings' && (
        <AgentSettingsTab
          agentId={selectedAgent.id}
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          settingsDirty={settingsDirty}
          setSettingsDirty={setSettingsDirty}
          error={error}
          successMessage={successNotice}
          onSaveSettings={handleSaveSettings}
          onRevertSettings={handleRevertSettings}
          onOpenRoutines={onOpenRoutines}
        />
      )}
    </section>
  );
};
