import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { setAgentSkillEnabled, writeAgentSkill } from '../../../lib/ipc/agents';
import type { Workspace } from '../../../types';
import { SelectMenu } from '../../ui/SelectMenu';
import {
  AgentMindSnapshot,
  DiscoverableSkill,
  LearnedSkillDocument,
  StarterSummary,
  formatRelativeAge,
} from './types';

// Inline SVG icons
const FileTextSvg: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const WandSparklesSvg: React.FC<{ size?: number; className?: string }> = ({ size = 24, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.21 1.21 0 0 0 1.72 0L21.64 5.36a1.21 1.21 0 0 0 0-1.72Z" />
    <path d="m14 7 3 3" />
    <path d="M5 6v4" />
    <path d="M19 14v4" />
    <path d="M10 2v2" />
    <path d="M7 8H3" />
    <path d="M21 16h-4" />
    <path d="M11 3H9" />
  </svg>
);

const Trash2Svg: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const ChevronLeftSvg: React.FC<{ size?: number; className?: string }> = ({ size = 11, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronDownSvg: React.FC<{ size?: number; className?: string }> = ({ size = 10, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const PlusSvg: React.FC<{ size?: number; className?: string }> = ({ size = 12, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const CircleAlertSvg: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const SpinnerSvg: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// Strips YAML frontmatter (---\n...\n---) for reader presentation
function stripFrontmatter(source: string): string {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return source;
  const endIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  return endIdx < 0
    ? source
    : lines.slice(endIdx + 1).join('\n').replace(/^[\n\r]+|[\n\r]+$/gu, '');
}

// Formats timestamp for display
function formatTimestamp(timestampMs: number): string {
  if (timestampMs <= 0) return 'Just updated';
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
    : 'Updated recently';
}

// Checks if a skill or the skills folder has safety or read issues
function hasSkillReadIssue(mind: AgentMindSnapshot | null, skillId: string): boolean {
  if (!mind?.readIssues) return false;
  return mind.readIssues.some(
    (issue) =>
      issue.code === 'skillsUnreadable' ||
      (issue.skillId === skillId &&
        ['skillUnreadable', 'skillInvalid', 'skillPathRejected', 'skillCaseNonCanonical'].includes(issue.code))
  );
}

// Render formatted markdown safely without external HTML injections using authentic chat-markdown styles
function renderProcedureMarkdown(source: string): React.ReactNode {
  if (!source || source.trim().length === 0) {
    return <p className="chat-markdown__plain">No procedure body defined.</p>;
  }

  const sections = source.split(/\n\n+/);
  return (
    <div className="chat-markdown">
      {sections.map((section, sIdx) => {
        const trimmed = section.trim();
        if (!trimmed) return null;

        // Code block
        if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
          const lines = trimmed.slice(3, -3).trim().split('\n');
          const lang = lines[0].trim().match(/^[a-z0-9_-]+/i) ? lines[0].trim() : '';
          const code = (lang ? lines.slice(1) : lines).join('\n');
          return (
            <div key={sIdx} className="chat-code-block">
              {lang && (
                <div className="chat-code-block__bar">
                  <span className="chat-code-block__lang">{lang}</span>
                </div>
              )}
              <pre data-language={lang || undefined}>
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Headings (in chat-markdown h2 is title, h3 is heading, h4 is body)
        if (trimmed.startsWith('### ')) {
          return <h4 key={sIdx}>{trimmed.slice(4)}</h4>;
        }
        if (trimmed.startsWith('## ')) {
          return <h3 key={sIdx}>{trimmed.slice(3)}</h3>;
        }
        if (trimmed.startsWith('# ')) {
          return <h2 key={sIdx}>{trimmed.slice(2)}</h2>;
        }

        // Bullet lists
        const lines = trimmed.split('\n');
        if (lines.every((line) => line.trim().startsWith('- ') || line.trim().startsWith('* '))) {
          return (
            <ul key={sIdx} role="list">
              {lines.map((line, lIdx) => (
                <li key={lIdx} className="chat-markdown__list-item">
                  <span className="chat-markdown__item-text">{line.trim().replace(/^[-*]\s+/, '')}</span>
                </li>
              ))}
            </ul>
          );
        }

        // Standard paragraph
        return <p key={sIdx}>{trimmed}</p>;
      })}
    </div>
  );
}

export interface AgentSkillsTabProps {
  agentId?: string;
  agentName: string;
  mind: AgentMindSnapshot | null;
  workspaceId?: string | null;
  workspaces?: Workspace[];
  selectedSkillId: string | null;
  skillDocument: LearnedSkillDocument | null;
  skillLoading: boolean;
  skillSaving: boolean;
  onSelectSkill: (skillId: string) => Promise<void>;
  onSaveSkill: (source: string) => Promise<void>;
  onDeleteSkill: () => Promise<void>;
  onClearSelectedSkill: () => void;
  onNavigateToStarters?: () => void;
  starters?: StarterSummary[];
  onInstallStarter?: (starterId: string) => Promise<void>;
  onMindUpdated?: (nextMind: AgentMindSnapshot) => void;
  readOnly?: boolean;
}

function slugifySkillId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return slug || 'custom-skill';
}

function formatLastUsedLabel(lastUsed: string | null): string | null {
  if (!lastUsed) return null;
  const numeric = Number(lastUsed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return formatRelativeAge(numeric);
  }
  const parsed = Date.parse(lastUsed);
  if (Number.isFinite(parsed) && parsed > 0) {
    return formatRelativeAge(parsed);
  }
  return lastUsed;
}

export const AgentSkillsTab: React.FC<AgentSkillsTabProps> = ({
  agentId: agentIdProp,
  agentName,
  mind,
  workspaceId = null,
  workspaces = [],
  selectedSkillId,
  skillDocument,
  skillLoading,
  skillSaving,
  onSelectSkill,
  onSaveSkill,
  onDeleteSkill,
  onClearSelectedSkill,
  starters: startersProp,
  onInstallStarter: onInstallStarterProp,
  onMindUpdated,
  readOnly = false,
}) => {
  const effectiveAgentId = agentIdProp || mind?.agentId || '';
  const [isEditingSkill, setIsEditingSkill] = useState<boolean>(false);
  const [skillSourceDraft, setSkillSourceDraft] = useState<string>('');
  const [isConfirmingDeleteSkill, setIsConfirmingDeleteSkill] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isCreatingSkill, setIsCreatingSkill] = useState<boolean>(false);
  const [newSkillName, setNewSkillName] = useState<string>('');
  const [newSkillDescription, setNewSkillDescription] = useState<string>('');
  const [newSkillBody, setNewSkillBody] = useState<string>('');
  const [creatingSkill, setCreatingSkill] = useState<boolean>(false);
  const [togglingSkillId, setTogglingSkillId] = useState<string | null>(null);

  // Discoverable repo & global skills state
  const [discoveryWorkspaceId, setDiscoveryWorkspaceId] = useState<string | null>(
    workspaceId ?? workspaces[0]?.id ?? null
  );
  const [discoverableSkills, setDiscoverableSkills] = useState<DiscoverableSkill[]>([]);
  const [workspaceRootLabel, setWorkspaceRootLabel] = useState<string | null>(null);
  const [linkedRefsLocal, setLinkedRefsLocal] = useState<string[]>(mind?.linkedSkillRefs ?? []);
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(false);
  const [linkingRefKey, setLinkingRefKey] = useState<string | null>(null);

  // Capture from Chat state
  const [isCapturingFromChat, setIsCapturingFromChat] = useState<boolean>(false);
  const [captureName, setCaptureName] = useState<string>('');
  const [captureDescription, setCaptureDescription] = useState<string>('');
  const [captureMessagesText, setCaptureMessagesText] = useState<string>('');
  const [captureManualOnly, setCaptureManualOnly] = useState<boolean>(false);
  const [capturingSkill, setCapturingSkill] = useState<boolean>(false);
  const [loadingLatestChat, setLoadingLatestChat] = useState<boolean>(false);

  // Starters state
  const [startersList, setStartersList] = useState<StarterSummary[]>(startersProp || []);
  const [startersLoading, setStartersLoading] = useState<boolean>(false);
  const [isStarterMenuOpen, setIsStarterMenuOpen] = useState<boolean>(false);
  const [installingStarterId, setInstallingStarterId] = useState<string | null>(null);

  const starterMenuRef = useRef<HTMLDivElement>(null);
  const starterButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (workspaceId !== undefined) {
      setDiscoveryWorkspaceId(workspaceId ?? workspaces[0]?.id ?? null);
    }
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (Array.isArray(mind?.linkedSkillRefs)) {
      setLinkedRefsLocal(mind.linkedSkillRefs);
    }
  }, [mind?.linkedSkillRefs]);

  const loadDiscoverableSkills = useCallback(async () => {
    if (!effectiveAgentId) return;
    setDiscoverLoading(true);
    try {
      const res = await invokeCommand<{
        skills?: DiscoverableSkill[];
        workspaceRoot?: string | null;
        linkedSkillRefs?: string[];
      }>('list_discoverable_skills', {
        workspaceId: discoveryWorkspaceId ?? undefined,
        agentId: effectiveAgentId,
      });
      if (Array.isArray(res?.skills)) {
        setDiscoverableSkills(res.skills);
      }
      if (res?.workspaceRoot !== undefined) {
        setWorkspaceRootLabel(res.workspaceRoot ?? null);
      }
      if (Array.isArray(res?.linkedSkillRefs)) {
        setLinkedRefsLocal(res.linkedSkillRefs);
      }
    } catch (err) {
      console.warn('[AgentSkillsTab] Could not load discoverable skills:', err);
    } finally {
      setDiscoverLoading(false);
    }
  }, [effectiveAgentId, discoveryWorkspaceId]);

  useEffect(() => {
    void loadDiscoverableSkills();
  }, [loadDiscoverableSkills]);

  // Load starter skills if not passed via props
  useEffect(() => {
    if (startersProp && startersProp.length > 0) {
      setStartersList(startersProp);
      return;
    }

    let isMounted = true;
    setStartersLoading(true);
    invokeCommand<StarterSummary[]>('list_agent_starters', { supportedCatalogVersion: 1 })
      .then((items) => {
        if (isMounted && Array.isArray(items)) {
          setStartersList(items);
        }
      })
      .catch((err) => {
        console.warn('[AgentSkillsTab] Could not load starters catalog:', err);
      })
      .finally(() => {
        if (isMounted) {
          setStartersLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [startersProp]);

  // Close starter dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        starterMenuRef.current &&
        !starterMenuRef.current.contains(event.target as Node) &&
        starterButtonRef.current &&
        !starterButtonRef.current.contains(event.target as Node)
      ) {
        setIsStarterMenuOpen(false);
      }
    }

    if (isStarterMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isStarterMenuOpen]);

  // Reset local state when selected skill or agent changes
  useEffect(() => {
    setIsEditingSkill(false);
    setIsConfirmingDeleteSkill(false);
    setLocalError(null);
  }, [selectedSkillId, mind?.agentId]);

  // Filter starters that are not already installed
  const availableStarters = useMemo(() => {
    const installedIds = new Set(mind?.skills?.map((s) => s.id) || []);
    return startersList.filter((s) => !installedIds.has(s.id));
  }, [mind?.skills, startersList]);

  // Read issue flags
  const hasSkillsFolderIssue = mind?.readIssues?.some((issue) => issue.code === 'skillsUnreadable') ?? false;
  const isSkillsTruncated = mind?.readIssues?.some((issue) => issue.code === 'skillsTruncated') ?? false;
  const selectedSkillHasIssue = selectedSkillId ? hasSkillReadIssue(mind, selectedSkillId) : false;
  const isOperationLocked = readOnly || hasSkillsFolderIssue || selectedSkillHasIssue;

  // Selected skill reference
  const activeSkillSummary = mind?.skills?.find((s) => s.id === selectedSkillId) ?? null;

  const handleEditClick = () => {
    if (skillDocument && !isOperationLocked) {
      setSkillSourceDraft(skillDocument.source);
      setIsEditingSkill(true);
      setLocalError(null);
    }
  };

  const handleSave = async () => {
    if (isOperationLocked || !skillDocument) return;

    if (skillDocument.source.length > 0 && skillSourceDraft.trim().length === 0) {
      setLocalError('An empty draft cannot replace a non-empty skill. Re-open it before saving.');
      return;
    }

    const byteLength = new TextEncoder().encode(skillSourceDraft).length;
    if (byteLength > 1048576) {
      setLocalError('This skill is too large for the bounded agent-data file.');
      return;
    }

    setLocalError(null);
    try {
      await onSaveSkill(skillSourceDraft);
      setIsEditingSkill(false);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to save skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to save skill');
    }
  };

  const handleDelete = async () => {
    if (isOperationLocked || !skillDocument) return;

    setLocalError(null);
    try {
      await onDeleteSkill();
      setIsConfirmingDeleteSkill(false);
      setIsEditingSkill(false);
      onClearSelectedSkill();
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to delete skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  };

  const handleInstallStarter = async (starterId: string) => {
    setInstallingStarterId(starterId);
    setLocalError(null);
    try {
      if (onInstallStarterProp) {
        await onInstallStarterProp(starterId);
      } else if (mind?.agentId) {
        await invokeCommand<{ installed: boolean; mind: AgentMindSnapshot }>('install_agent_starter', {
          agentId: mind.agentId,
          starterId,
          confirmedByBuilder: true,
        });
      }
      setIsStarterMenuOpen(false);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to install starter:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to install starter skill');
    } finally {
      setInstallingStarterId(null);
    }
  };

  const handleCreateNewSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || hasSkillsFolderIssue || !mind?.agentId) return;
    const trimmedName = newSkillName.trim();
    const trimmedDesc = newSkillDescription.trim();
    const trimmedBody = newSkillBody.trim();
    if (!trimmedName || !trimmedBody) {
      setLocalError('Provide a skill name and instructions body.');
      return;
    }
    const baseSlug = slugifySkillId(trimmedName);
    const existingIds = new Set((mind.skills ?? []).map((s) => s.id));
    let skillId = baseSlug;
    let suffix = 2;
    while (existingIds.has(skillId)) {
      skillId = `${baseSlug.slice(0, 58)}-${suffix}`;
      suffix += 1;
    }
    const source = `---\nname: ${trimmedName}\ndescription: ${trimmedDesc}\n---\n\n${trimmedBody}\n`;
    setCreatingSkill(true);
    setLocalError(null);
    try {
      const nextMind = await writeAgentSkill(
        mind.agentId,
        skillId,
        source,
        null as unknown as string,
        true
      );
      onMindUpdated?.(nextMind);
      setIsCreatingSkill(false);
      setNewSkillName('');
      setNewSkillDescription('');
      setNewSkillBody('');
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to create skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setCreatingSkill(false);
    }
  };

  const handleToggleSkillEnabled = async (skillId: string, currentEnabled: boolean) => {
    if (readOnly || !effectiveAgentId || togglingSkillId) return;
    setTogglingSkillId(skillId);
    setLocalError(null);
    try {
      const nextMind = await setAgentSkillEnabled(effectiveAgentId, skillId, !currentEnabled, true);
      onMindUpdated?.(nextMind);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to toggle skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to update skill status');
    } finally {
      setTogglingSkillId(null);
    }
  };

  const activeLinkedRefs = mind?.linkedSkillRefs ?? linkedRefsLocal;

  const handleToggleLinkedSkill = async (refKey: string) => {
    if (readOnly || !effectiveAgentId || linkingRefKey) return;
    setLinkingRefKey(refKey);
    setLocalError(null);
    const isLinked = activeLinkedRefs.includes(refKey);
    const nextRefs = isLinked
      ? activeLinkedRefs.filter((r) => r !== refKey)
      : [...activeLinkedRefs, refKey];
    try {
      const nextMind = await invokeCommand<AgentMindSnapshot>('set_agent_linked_skills', {
        agentId: effectiveAgentId,
        linkedSkillRefs: nextRefs,
      });
      setLinkedRefsLocal(nextMind?.linkedSkillRefs ?? nextRefs);
      if (nextMind) {
        onMindUpdated?.(nextMind);
      }
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to update linked skills:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to update linked skills');
    } finally {
      setLinkingRefKey(null);
    }
  };

  const prefillLatestChat = async () => {
    if (!effectiveAgentId || loadingLatestChat) return;
    setLoadingLatestChat(true);
    try {
      const summaryRes = await invokeCommand<{
        summaries?: Array<{ id: string; title?: string }>;
      }>('list_agent_chat_summaries', { agentId: effectiveAgentId });
      const latestThreadId = summaryRes?.summaries?.[0]?.id;
      if (!latestThreadId) return;
      const threadRes = await invokeCommand<{
        items?: Array<{ kind?: string; text?: string }>;
      }>('load_agent_chat_thread', {
        agentId: effectiveAgentId,
        threadId: latestThreadId,
      });
      const relevant = (threadRes?.items ?? [])
        .filter((it) => (it.kind === 'user' || it.kind === 'assistant') && (it.text ?? '').trim())
        .slice(-8)
        .map((it) => `${it.kind === 'user' ? 'User' : 'Assistant'}: ${(it.text ?? '').trim()}`);
      if (relevant.length > 0) {
        setCaptureMessagesText(relevant.join('\n'));
      }
    } catch (err) {
      console.warn('[AgentSkillsTab] Could not prefill latest chat:', err);
    } finally {
      setLoadingLatestChat(false);
    }
  };

  const handleOpenCaptureFromChat = () => {
    setIsCreatingSkill(false);
    setIsCapturingFromChat(true);
    setLocalError(null);
    if (!captureMessagesText.trim()) {
      void prefillLatestChat();
    }
  };

  const handleCaptureFromChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || hasSkillsFolderIssue || !effectiveAgentId) return;
    const trimmedName = captureName.trim();
    const lines = captureMessagesText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!trimmedName || lines.length === 0) {
      setLocalError('Provide a skill name and at least one conversation step.');
      return;
    }
    const messages = lines.map((line) => {
      const userMatch = line.match(/^(?:user|human|request)\s*:\s*(.+)$/i);
      if (userMatch) return { role: 'user', text: userMatch[1].trim() };
      const assistantMatch = line.match(/^(?:assistant|agent|procedure)\s*:\s*(.+)$/i);
      if (assistantMatch) return { role: 'assistant', text: assistantMatch[1].trim() };
      const cmdMatch = line.match(/^(?:command|tool)\s*:\s*(.+)$/i);
      if (cmdMatch) return { role: 'tool', text: cmdMatch[1].trim() };
      return { role: 'assistant', text: line };
    });

    setCapturingSkill(true);
    setLocalError(null);
    try {
      const nextMind = await invokeCommand<AgentMindSnapshot & { capturedSkillId?: string }>(
        'capture_agent_skill_from_chat',
        {
          agentId: effectiveAgentId,
          name: trimmedName,
          description: captureDescription.trim(),
          messages,
          manualOnly: captureManualOnly,
        }
      );
      onMindUpdated?.(nextMind);
      setIsCapturingFromChat(false);
      setCaptureName('');
      setCaptureDescription('');
      setCaptureMessagesText('');
      setCaptureManualOnly(false);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to capture skill from chat:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to capture skill from chat');
    } finally {
      setCapturingSkill(false);
    }
  };

  const renderNewSkillButton = () => (
    <button
      type="button"
      className="secondary-button action-button--row"
      disabled={readOnly || hasSkillsFolderIssue}
      onClick={() => {
        setIsCapturingFromChat(false);
        setIsCreatingSkill(true);
        setLocalError(null);
      }}
    >
      <span aria-hidden="true" className="action-button__icon">
        <PlusSvg size={11} />
      </span>
      + New Skill
    </button>
  );

  const renderCaptureFromChatButton = () => (
    <button
      type="button"
      className="secondary-button action-button--row"
      disabled={readOnly || hasSkillsFolderIssue || !effectiveAgentId}
      onClick={handleOpenCaptureFromChat}
    >
      Capture from Chat
    </button>
  );

  // Starter menu and button component
  const hasAvailableStarters = availableStarters.length > 0 || startersLoading;

  const renderStarterControl = (ariaLabel?: string) => (
    <div className="agent-skills__starter-control">
      <button
        ref={starterButtonRef}
        type="button"
        aria-expanded={isStarterMenuOpen}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="secondary-button action-button--row agent-skills__starter-trigger"
        disabled={readOnly || startersLoading || installingStarterId !== null || hasSkillsFolderIssue}
        onClick={() => setIsStarterMenuOpen((prev) => !prev)}
        title={`Give ${agentName} its own copy of a starter skill`}
      >
        <span aria-hidden="true" className="action-button__icon">
          {installingStarterId !== null ? <SpinnerSvg size={12} /> : <PlusSvg size={11} />}
        </span>
        {startersLoading ? 'Loading starters…' : 'Add starter'}
        <ChevronDownSvg size={10} />
      </button>

      {isStarterMenuOpen && (
        <div
          ref={starterMenuRef}
          className="ui-menu ui-menu--plain agent-skills__starter-menu"
          role="menu"
          aria-label="Starter skills"
        >
          {availableStarters.map((starter) => (
            <button
              key={starter.id}
              type="button"
              role="menuitem"
              className="ui-menu__row"
              disabled={installingStarterId === starter.id}
              onClick={() => void handleInstallStarter(starter.id)}
            >
              <span className="ui-menu__row-title">{starter.title || (starter as any).name}</span>
              <span className="ui-menu__row-detail">{starter.summary || (starter as any).description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (selectedSkillId && activeSkillSummary) {
    return (
      <div className="agent-face agent-skills agent-skills--detail">
        <header className="agent-skills__toolbar">
          <button
            type="button"
            className="agent-skills__back"
            onClick={() => {
              setIsEditingSkill(false);
              setIsConfirmingDeleteSkill(false);
              setLocalError(null);
              onClearSelectedSkill();
            }}
          >
            <ChevronLeftSvg size={11} />
            Skills
          </button>

          <span className="agent-skills__toolbar-spacer" />

          {isEditingSkill ? (
            <>
              <button
                type="button"
                className="secondary-button action-button--row"
                onClick={() => {
                  setIsEditingSkill(false);
                  setLocalError(null);
                }}
                disabled={skillSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button action-button--row"
                onClick={() => void handleSave()}
                disabled={
                  skillSaving ||
                  isOperationLocked ||
                  (skillDocument !== null && skillSourceDraft === skillDocument.source)
                }
              >
                {skillSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : isConfirmingDeleteSkill ? (
            <>
              <span className="agent-skills__delete-copy">
                Delete &ldquo;{skillDocument?.name || activeSkillSummary.name}&rdquo;?
              </span>
              <button
                type="button"
                className="secondary-button action-button--row"
                onClick={() => setIsConfirmingDeleteSkill(false)}
                disabled={skillSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button action-button--row agent-skills__delete"
                onClick={() => void handleDelete()}
                disabled={skillSaving || isOperationLocked}
              >
                {skillSaving ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label="Delete this skill"
                className="chrome-button"
                disabled={isOperationLocked || skillLoading || !skillDocument}
                onClick={() => setIsConfirmingDeleteSkill(true)}
              >
                <Trash2Svg size={13} />
              </button>
              <button
                type="button"
                className="secondary-button action-button--row"
                disabled={isOperationLocked || skillLoading || !skillDocument}
                onClick={handleEditClick}
              >
                Edit
              </button>
            </>
          )}
        </header>

        {localError && (
          <p className="agent-feedback agent-feedback--error agent-skills__feedback" role="alert">
            {localError}
          </p>
        )}

        {selectedSkillHasIssue && (
          <div className="agent-skills__read-issue" role="alert">
            This skill could not be read safely. Editing and deletion stay locked; no recovery write is exposed to the renderer.
          </div>
        )}

        {skillLoading ? (
          <div className="agent-detail-state">
            <div className="ui-status-notice" data-tone="loading" role="status">
              <div className="ui-status-notice__copy">
                <strong>Opening skill…</strong>
                <p>Source loads only for the skill you chose.</p>
              </div>
            </div>
          </div>
        ) : !skillDocument ? (
          <div className="agent-detail-state">
            <div className="ui-status-notice" data-tone="warning" role="alert">
              <span aria-hidden="true" className="ui-status-notice__glyph">
                <CircleAlertSvg size={16} />
              </span>
              <div className="ui-status-notice__copy">
                <strong>Skill couldn’t be opened</strong>
                <p>The source response was incomplete.</p>
              </div>
              <div className="ui-status-notice__action">
                <button
                  type="button"
                  className="primary-button action-button--row"
                  onClick={() => void onSelectSkill(selectedSkillId)}
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : isEditingSkill ? (
          <div className="agent-skills__editor">
            <label className="sr-only" htmlFor="agent-skill-source">
              Skill source
            </label>
            <textarea
              id="agent-skill-source"
              value={skillSourceDraft}
              onChange={(e) => setSkillSourceDraft(e.currentTarget.value)}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="agent-skills__detail-scroll">
            <article className="agent-skills__document">
              <header>
                <div>
                  <h1>{skillDocument.name}</h1>
                  <time>{formatTimestamp(skillDocument.updatedAtUnixMs)}</time>
                </div>
                <p>
                  <strong>Fires when</strong>
                  <span>
                    {skillDocument.description || 'No description — the agent should add one; retrieval keys on it.'}
                  </span>
                </p>
              </header>
              <div className="agent-skills__document-body">
                {renderProcedureMarkdown(stripFrontmatter(skillDocument.source))}
              </div>
            </article>
          </div>
        )}
      </div>
    );
  }

  const skillsCount = mind?.skills?.length ?? 0;

  return (
    <div className="agent-face agent-skills">
      <div className="agent-mind-bar">
        <div className="ui-tabs">
          <div aria-label="Skills" className="ui-tabs__list" role="tablist">
            <button
              className="ui-tab ui-tab--selected"
              role="tab"
              type="button"
              tabIndex={0}
              aria-selected="true"
            >
              <span className="ui-tab__label" data-label="Skills">
                Skills
              </span>
              {skillsCount > 0 ? (
                <span className="ui-tab__count" data-count="">
                  {skillsCount}
                </span>
              ) : null}
            </button>
          </div>
          {skillsCount > 0 ? (
            <div className="ui-tabs__trailing">
              {renderNewSkillButton()}
              {renderCaptureFromChatButton()}
              {hasAvailableStarters ? renderStarterControl() : null}
            </div>
          ) : null}
        </div>
      </div>

      {localError && (
        <p className="agent-feedback agent-feedback--error agent-skills__feedback" role="alert">
          {localError}
        </p>
      )}

      {hasSkillsFolderIssue && (
        <div className="agent-skills__read-issue" role="alert">
          The skills folder could not be read safely. Existing data was left unchanged and writes stay disabled.
        </div>
      )}

      {isSkillsTruncated && (
        <div className="agent-skills__read-issue" role="status">
          The bounded list is incomplete. No hidden skill was removed or overwritten.
        </div>
      )}

      <div className="agent-skills__list-scroll">
        {isCreatingSkill && (
          <div className="agent-mind-column">
            <form className="ui-card agent-skills__new-form" onSubmit={(e) => void handleCreateNewSkill(e)}>
              <div className="agent-skills__new-field">
                <label htmlFor="new-skill-name">Skill name</label>
                <input
                  id="new-skill-name"
                  type="text"
                  className="ui-field"
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.currentTarget.value)}
                  placeholder="e.g. Release checklist"
                  disabled={creatingSkill}
                />
              </div>
              <div className="agent-skills__new-field">
                <label htmlFor="new-skill-description">When it fires</label>
                <input
                  id="new-skill-description"
                  type="text"
                  className="ui-field"
                  value={newSkillDescription}
                  onChange={(e) => setNewSkillDescription(e.currentTarget.value)}
                  placeholder="Use when preparing a release or changelog"
                  disabled={creatingSkill}
                />
              </div>
              <div className="agent-skills__new-field">
                <label htmlFor="new-skill-body">Instructions</label>
                <textarea
                  id="new-skill-body"
                  className="ui-field ui-field--area"
                  rows={5}
                  value={newSkillBody}
                  onChange={(e) => setNewSkillBody(e.currentTarget.value)}
                  placeholder="Write the step-by-step procedure..."
                  disabled={creatingSkill}
                />
              </div>
              <div className="agent-skills__new-actions">
                <button
                  type="button"
                  className="secondary-button action-button--row"
                  disabled={creatingSkill}
                  onClick={() => {
                    setIsCreatingSkill(false);
                    setLocalError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button action-button--row"
                  disabled={creatingSkill || !newSkillName.trim() || !newSkillBody.trim()}
                >
                  {creatingSkill ? 'Creating…' : 'Create skill'}
                </button>
              </div>
            </form>
          </div>
        )}

        {isCapturingFromChat && (
          <div className="agent-mind-column">
            <form className="ui-card agent-skills__new-form" onSubmit={(e) => void handleCaptureFromChat(e)}>
              <div className="agent-skills__section-header">
                <strong>Capture skill from chat</strong>
                <button
                  type="button"
                  className="chrome-button"
                  disabled={loadingLatestChat || capturingSkill}
                  onClick={() => void prefillLatestChat()}
                >
                  {loadingLatestChat ? 'Loading chat…' : 'Load latest chat'}
                </button>
              </div>
              <div className="agent-skills__new-field">
                <label htmlFor="capture-skill-name">Skill name</label>
                <input
                  id="capture-skill-name"
                  type="text"
                  className="ui-field"
                  value={captureName}
                  onChange={(e) => setCaptureName(e.currentTarget.value)}
                  placeholder="e.g. Pre-push Clean-Room Audit"
                  disabled={capturingSkill}
                />
              </div>
              <div className="agent-skills__new-field">
                <label htmlFor="capture-skill-description">When it fires</label>
                <input
                  id="capture-skill-description"
                  type="text"
                  className="ui-field"
                  value={captureDescription}
                  onChange={(e) => setCaptureDescription(e.currentTarget.value)}
                  placeholder="Run when preparing a clean-room commit or push"
                  disabled={capturingSkill}
                />
              </div>
              <div className="agent-skills__new-field">
                <label htmlFor="capture-skill-messages">Conversation steps</label>
                <textarea
                  id="capture-skill-messages"
                  className="ui-field ui-field--area"
                  rows={5}
                  value={captureMessagesText}
                  onChange={(e) => setCaptureMessagesText(e.currentTarget.value)}
                  placeholder="Paste conversation turns or steps (one per line, optionally prefixed with User: / Assistant: / Command:)"
                  disabled={capturingSkill}
                />
              </div>
              <label className="agent-skills__capture-check">
                <input
                  type="checkbox"
                  checked={captureManualOnly}
                  onChange={(e) => setCaptureManualOnly(e.currentTarget.checked)}
                  disabled={capturingSkill}
                />
                <span>Manual-only (disable automatic invocation)</span>
              </label>
              <div className="agent-skills__new-actions">
                <button
                  type="button"
                  className="secondary-button action-button--row"
                  disabled={capturingSkill}
                  onClick={() => {
                    setIsCapturingFromChat(false);
                    setLocalError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button action-button--row"
                  disabled={capturingSkill || !captureName.trim() || !captureMessagesText.trim()}
                >
                  {capturingSkill ? 'Capturing…' : 'Save captured skill'}
                </button>
              </div>
            </form>
          </div>
        )}

        {mind && mind.skills && mind.skills.length > 0 ? (
          <div className="agent-mind-column">
            <p className="agent-mind-lede">
              Procedures {agentName} wrote for itself, and reads back when the work matches.
            </p>

            <div className="ui-card agent-skills__rows">
              {mind.skills.map((skill) => {
                const hasIssue = hasSkillReadIssue(mind, skill.id);
                const isEnabled = skill.enabled !== false;
                const lastUsedLabel = formatLastUsedLabel(skill.lastUsed);
                const isIneligible = skill.eligible === false;
                return (
                  <div
                    key={skill.id}
                    className={
                      hasIssue
                        ? 'ui-card__row agent-skills__row--read-issue'
                        : !isEnabled
                          ? 'ui-card__row agent-skills__row--disabled'
                          : 'ui-card__row'
                    }
                  >
                    <button
                      type="button"
                      className="agent-skills__row-main"
                      aria-label={`${skill.name}. ${skill.description}`}
                      title={
                        hasIssue
                          ? 'This skill opened read-only because its source could not be verified'
                          : `Updated ${formatTimestamp(skill.updatedAtUnixMs)}`
                      }
                      onClick={() => void onSelectSkill(skill.id)}
                    >
                      <span aria-hidden="true" className="agent-skills__row-icon">
                        <FileTextSvg size={14} />
                      </span>

                      <span className="agent-skills__row-copy">
                        <strong>{skill.name}</strong>
                        <span>{skill.description || 'No description — the agent should add one.'}</span>
                        {(skill.manualOnly || skill.contextMode === 'fork' || isIneligible) ? (
                          <span className="agent-skills__badges">
                            {skill.manualOnly ? (
                              <span className="agent-skills__badge">manual-only</span>
                            ) : null}
                            {skill.contextMode === 'fork' ? (
                              <span className="agent-skills__badge">context: fork</span>
                            ) : null}
                            {isIneligible ? (
                              <span
                                className="agent-skills__badge agent-skills__badge--warn"
                                title={skill.missingRequirements?.join(', ') || 'Missing prerequisites'}
                              >
                                ineligible
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                        {(skill.uses > 0 || lastUsedLabel) ? (
                          <small>
                            {skill.uses > 0 ? (skill.uses === 1 ? 'Fired once' : `Fired ${skill.uses}×`) : ''}
                            {skill.uses > 0 && lastUsedLabel ? ' · ' : ''}
                            {lastUsedLabel ? `Last used ${lastUsedLabel}` : ''}
                          </small>
                        ) : null}
                      </span>

                      <span aria-hidden="true" className="agent-skills__stamp">
                        <span className="agent-skills__stamp-age">
                          {formatRelativeAge(skill.updatedAtUnixMs)}
                        </span>
                        <span className="agent-skills__stamp-open">Open</span>
                      </span>
                    </button>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={isEnabled}
                      aria-label={`Enable ${skill.name}`}
                      className={`agent-skills__switch${isEnabled ? ' is-checked' : ''}`}
                      disabled={readOnly || hasIssue || togglingSkillId === skill.id}
                      onClick={() => void handleToggleSkillEnabled(skill.id, isEnabled)}
                    >
                      <span className="agent-skills__switch-thumb" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <section className="empty-surface empty-surface--embedded agent-skills__empty">
            <span aria-hidden="true" className="empty-surface__icon">
              <WandSparklesSvg size={24} />
            </span>
            <div className="empty-surface__copy">
              <h1>{agentName} hasn’t written a skill yet</h1>
              <p>
                When it works out how to do something you’ll ask for again, it writes the procedure here and reads it back when the work matches. Add a starter to give it something to pattern-match against.
              </p>
            </div>
            <div className="agent-skills__empty-actions">
              {renderNewSkillButton()}
              {renderCaptureFromChatButton()}
              {hasAvailableStarters ? renderStarterControl('Add starter skill') : null}
            </div>
          </section>
        )}

        {effectiveAgentId ? (
          <div className="agent-mind-column agent-skills__section">
            <div className="agent-skills__section-header">
              <div>
                <h2 className="ui-eyebrow">Repo &amp; Global Skills</h2>
                <p className="agent-knowledge__meta">
                  Link workspace <code>.agents/skills/*</code> and global <code>SKILL.md</code> skills directly without copying files.
                  {workspaceRootLabel ? ` · Root: ${workspaceRootLabel}` : ''}
                </p>
              </div>
              <div className="agent-modal-row">
                {workspaces.length > 0 ? (
                  <SelectMenu
                    variant="toolbar"
                    label="Skill discovery workspace"
                    value={discoveryWorkspaceId ?? workspaces[0].id}
                    triggerLabel={
                      workspaces.find((w) => w.id === discoveryWorkspaceId)?.displayName ||
                      workspaces[0].displayName
                    }
                    rows={workspaces.map((ws) => ({
                      id: ws.id,
                      title: ws.displayName,
                    }))}
                    onSelect={(id) => setDiscoveryWorkspaceId(id)}
                  />
                ) : null}
                <button
                  type="button"
                  className="chrome-button"
                  disabled={discoverLoading}
                  onClick={() => void loadDiscoverableSkills()}
                >
                  {discoverLoading ? 'Scanning…' : 'Refresh'}
                </button>
              </div>
            </div>

            {discoverableSkills.length === 0 ? (
              <div className="ui-card agent-knowledge__empty">
                No workspace or global SKILL.md entries discovered yet.
              </div>
            ) : (
              <div className="ui-card agent-skills__rows">
                {discoverableSkills.map((dSkill) => {
                  const isLinked = activeLinkedRefs.includes(dSkill.refKey);
                  return (
                    <div
                      key={dSkill.refKey}
                      className={`ui-card__row${!dSkill.eligible ? ' agent-skills__row--disabled' : ''}`}
                    >
                      <div className="agent-skills__row-main">
                        <span aria-hidden="true" className="agent-skills__row-icon">
                          <FileTextSvg size={14} />
                        </span>
                        <span className="agent-skills__row-copy">
                          <strong>{dSkill.name}</strong>
                          <span>{dSkill.description || dSkill.path}</span>
                          <span className="agent-skills__badges">
                            <span className="agent-skills__badge agent-skills__badge--scope">
                              {dSkill.scope}
                            </span>
                            {dSkill.manualOnly ? (
                              <span className="agent-skills__badge">manual-only</span>
                            ) : null}
                            {dSkill.contextMode === 'fork' ? (
                              <span className="agent-skills__badge">context: fork</span>
                            ) : null}
                            {!dSkill.eligible ? (
                              <span
                                className="agent-skills__badge agent-skills__badge--warn"
                                title={dSkill.missingRequirements?.join(', ') || 'Missing prerequisites'}
                              >
                                ineligible
                              </span>
                            ) : null}
                          </span>
                          {!dSkill.eligible && dSkill.missingRequirements?.length > 0 ? (
                            <small>Missing: {dSkill.missingRequirements.join(', ')}</small>
                          ) : null}
                        </span>
                      </div>

                      <button
                        type="button"
                        role="switch"
                        aria-checked={isLinked}
                        aria-label={`Link ${dSkill.name}`}
                        className={`agent-skills__switch${isLinked ? ' is-checked' : ''}`}
                        disabled={readOnly || linkingRefKey === dSkill.refKey}
                        onClick={() => void handleToggleLinkedSkill(dSkill.refKey)}
                      >
                        <span className="agent-skills__switch-thumb" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
