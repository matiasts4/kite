import React, { useMemo, useRef, useState } from 'react';
import {
  swarmKillWorkerFromUi,
  swarmPostFromUi,
  swarmSwitchWorkerModel,
} from '../../../lib/ipc/chat';
import type { SubagentRun, SwarmMember, SwarmState } from '../../../types';
import { SelectMenu } from '../../ui/SelectMenu';
import { SwarmActivityGraph } from './SwarmActivityGraph';
import { SwarmBoardFeed } from './SwarmBoardFeed';
import {
  buildSwarmChannels,
  buildSwarmGraphData,
  formatInspectorModelName,
  type SwarmTab,
} from './swarmBoardHelpers';
import { SwarmRosterTab } from './SwarmRosterTab';

export { formatInspectorModelName };

export interface SwarmBoardInspectorProps {
  threadId?: string | null;
  swarmState: SwarmState;
  parentModelLabel: string;
  subagentRuns?: SubagentRun[] | null;
  onInspectWorker: (member: SwarmMember) => void;
  onSwarmUpdated?: (nextSwarm: SwarmState) => void;
  onPostMessage?: (message: string, channel: string) => Promise<void> | void;
  onSwitchModel?: (
    name: string,
    model: string,
    provider?: string | null,
    effort?: string | null,
  ) => Promise<void> | void;
  onKillWorker?: (name: string) => Promise<void> | void;
}

export const SwarmBoardInspector: React.FC<SwarmBoardInspectorProps> = ({
  threadId = null,
  swarmState,
  parentModelLabel,
  subagentRuns = null,
  onInspectWorker,
  onSwarmUpdated,
  onPostMessage,
  onSwitchModel,
  onKillWorker,
}) => {
  const [activeTab, setActiveTab] = useState<SwarmTab>('feed');
  const [selectedChannel, setSelectedChannel] = useState<string>('all');
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);
  const [composerChannel, setComposerChannel] = useState<string>('main');
  const [composerText, setComposerText] = useState('');
  const [posting, setPosting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingWorker, setEditingWorker] = useState<string | null>(null);
  const [switchProvider, setSwitchProvider] = useState('');
  const [switchModel, setSwitchModel] = useState('');
  const [switchingWorker, setSwitchingWorker] = useState(false);
  const [killingWorker, setKillingWorker] = useState<string | null>(null);
  const postRefs = useRef<Map<number, HTMLElement>>(new Map());
  const composerInputRef = useRef<HTMLInputElement>(null);

  const members = swarmState.members ?? [];
  const posts = swarmState.posts ?? [];

  const handleSubmitPost = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = composerText.trim();
    if (!trimmed || posting) return;
    const channel = composerChannel.trim().replace(/^#/, '') || 'main';
    setPosting(true);
    setActionError(null);
    try {
      if (onPostMessage) {
        await onPostMessage(trimmed, channel);
      } else if (threadId) {
        const res = await swarmPostFromUi(threadId, trimmed, channel);
        if (res.swarmState && onSwarmUpdated) {
          onSwarmUpdated(res.swarmState);
        }
      }
      setComposerText('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to post swarm message');
    } finally {
      setPosting(false);
    }
  };

  const handleApplySwitch = async (member: SwarmMember) => {
    const nextModel = switchModel.trim();
    if (!nextModel || switchingWorker) return;
    const nextProvider = switchProvider.trim() || member.provider || null;
    setSwitchingWorker(true);
    setActionError(null);
    try {
      if (onSwitchModel) {
        await onSwitchModel(member.name, nextModel, nextProvider);
      } else if (threadId) {
        const res = await swarmSwitchWorkerModel(threadId, {
          name: member.name,
          model: nextModel,
          provider: nextProvider,
        });
        if (res.swarmState && onSwarmUpdated) {
          onSwarmUpdated(res.swarmState);
        }
      }
      setEditingWorker(null);
      setSwitchModel('');
      setSwitchProvider('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to switch worker model');
    } finally {
      setSwitchingWorker(false);
    }
  };

  const handleKillWorker = async (member: SwarmMember) => {
    if (killingWorker) return;
    setKillingWorker(member.name);
    setActionError(null);
    try {
      if (onKillWorker) {
        await onKillWorker(member.name);
      } else if (threadId) {
        const res = await swarmKillWorkerFromUi(threadId, member.name);
        if (res.swarmState && onSwarmUpdated) {
          onSwarmUpdated(res.swarmState);
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to kill swarm worker');
    } finally {
      setKillingWorker(null);
    }
  };

  const channels = useMemo(
    () => buildSwarmChannels(swarmState.channels, posts),
    [swarmState.channels, posts],
  );

  const filteredPosts = useMemo(() => {
    if (selectedChannel === 'all') return posts;
    return posts.filter(
      (p) => (p.channel ?? 'main').replace(/^#/, '') === selectedChannel,
    );
  }, [posts, selectedChannel]);

  const memberByName = useMemo(() => {
    const map = new Map<string, SwarmMember>();
    for (const member of members) {
      map.set(member.name.toLowerCase(), member);
    }
    return map;
  }, [members]);

  const scrollToPost = (seq: number) => {
    setSelectedChannel('all');
    setHighlightedSeq(seq);
    const existing = postRefs.current.get(seq);
    if (existing && typeof existing.scrollIntoView === 'function') {
      existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    requestAnimationFrame(() => {
      const el = postRefs.current.get(seq);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  };

  const insertComposerTarget = (rawTarget: string) => {
    const normalized = rawTarget.startsWith('@') ? rawTarget : `@${rawTarget}`;
    const clean = normalized.toLowerCase();
    setActiveTab('feed');
    if (clean === '@all') {
      setSelectedChannel('all');
    }
    setComposerText((prev) => {
      const trimmed = prev.trimStart();
      if (!trimmed) return `${normalized} `;
      if (trimmed.toLowerCase().startsWith(clean)) return prev;
      return `${normalized} ${trimmed}`;
    });
    composerInputRef.current?.focus();
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  };

  const graphData = useMemo(
    () => buildSwarmGraphData(posts, members),
    [posts, members],
  );

  return (
    <div className="swarm-board" data-testid="swarm-board-inspector">
      <div className="swarm-board__overview">
        <div className="swarm-board__title-row">
          <span className="swarm-board__title">{swarmState.title || 'Swarm Board'}</span>
          <span className="subagent-badge">
            {members.length} {members.length === 1 ? 'worker' : 'workers'}
          </span>
        </div>
        <div className="swarm-board__models-row">
          <span className="subagent-badge subagent-badge--hierarchy">
            Coordinator: {parentModelLabel}
          </span>
          {members.slice(0, 4).map((member) => (
            <span key={member.name} className="subagent-badge">
              @{member.name}: {formatInspectorModelName(member.model, member.provider)}
            </span>
          ))}
        </div>
      </div>

      <div className="swarm-board__subtabs" role="tablist" aria-label="Swarm views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'feed'}
          className={`subagent-inspector__segment-btn${activeTab === 'feed' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('feed')}
        >
          Board Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'roster'}
          className={`subagent-inspector__segment-btn${activeTab === 'roster' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('roster')}
        >
          Roster ({members.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'graph'}
          className={`subagent-inspector__segment-btn${activeTab === 'graph' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('graph')}
        >
          Activity Graph
        </button>
      </div>

      {activeTab === 'feed' && (
        <SwarmBoardFeed
          channels={channels}
          selectedChannel={selectedChannel}
          onSelectChannel={setSelectedChannel}
          filteredPosts={filteredPosts}
          highlightedSeq={highlightedSeq}
          postRefs={postRefs}
          memberByName={memberByName}
          onInspectWorker={onInspectWorker}
          onInsertTarget={insertComposerTarget}
          onScrollToPost={scrollToPost}
        />
      )}

      {activeTab === 'roster' && (
        <SwarmRosterTab
          members={members}
          subagentRuns={subagentRuns}
          editingWorker={editingWorker}
          switchProvider={switchProvider}
          switchModel={switchModel}
          switchingWorker={switchingWorker}
          killingWorker={killingWorker}
          onToggleEditWorker={(member) => {
            setEditingWorker((prev) => (prev === member.name ? null : member.name));
            setSwitchProvider(member.provider ?? '');
            setSwitchModel(member.model ?? '');
          }}
          onChangeSwitchProvider={setSwitchProvider}
          onChangeSwitchModel={setSwitchModel}
          onApplySwitch={(member) => void handleApplySwitch(member)}
          onKillWorker={(member) => void handleKillWorker(member)}
          onInspectWorker={onInspectWorker}
        />
      )}

      {activeTab === 'graph' && (
        <SwarmActivityGraph
          members={members}
          parentModelLabel={parentModelLabel}
          graphData={graphData}
        />
      )}

      {actionError && (
        <div className="subagent-inspector__error" role="alert">
          {actionError}
        </div>
      )}

      <form
        className="swarm-board__composer"
        data-testid="swarm-board-composer"
        onSubmit={(e) => void handleSubmitPost(e)}
      >
        <div
          className="swarm-board__quick-targets"
          role="group"
          aria-label="Quick mention targets"
        >
          <span className="swarm-board__quick-label">Target:</span>
          <button
            type="button"
            className="swarm-mention-pill"
            onClick={() => insertComposerTarget('@coordinator')}
          >
            @coordinator
          </button>
          <button
            type="button"
            className="swarm-mention-pill"
            onClick={() => insertComposerTarget('@all')}
          >
            @all
          </button>
        </div>
        <div className="swarm-board__composer-row">
          <SelectMenu
            label="Target swarm channel"
            variant="field"
            className="swarm-board__channel-select"
            value={composerChannel}
            triggerLabel={`#${composerChannel}`}
            rows={(channels.length > 0 ? channels : ['main']).map((ch) => ({
              id: ch,
              title: `#${ch}`,
            }))}
            onSelect={(id) => setComposerChannel(id)}
          />
          <input
            ref={composerInputRef}
            type="text"
            className="swarm-board__composer-input"
            value={composerText}
            placeholder="Post @worker or @all to swarm board…"
            disabled={posting}
            onChange={(e) => setComposerText(e.target.value)}
          />
          <button
            type="submit"
            className="swarm-board__composer-submit"
            disabled={posting || !composerText.trim()}
          >
            Post
          </button>
        </div>
      </form>
    </div>
  );
};
