import React, { useState } from 'react';
import {
  SendIcon,
  CpuIcon,
  CompassIcon,
  ChevronDownIcon,
  MessageSquareIcon,
} from './ChatIcons';
import {
  ChatProvider,
  ChatMode,
  ExtendedChatThread,
  PROVIDER_CATALOG,
  MODE_LABELS,
} from './types';

export interface ChatHomeProps {
  onStartThread: (prompt: string, provider: ChatProvider, mode: ChatMode, model?: string) => void;
  knownThreads?: ExtendedChatThread[];
  onSelectThread?: (threadId: string) => void;
}

export const ChatHome: React.FC<ChatHomeProps> = ({
  onStartThread,
  knownThreads = [],
  onSelectThread,
}) => {
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<ChatProvider>('claude');
  const [mode, setMode] = useState<ChatMode>('acceptEdits');
  const [activeDropdown, setActiveDropdown] = useState<'provider' | 'mode' | null>(null);

  const providerMeta = PROVIDER_CATALOG[provider] || PROVIDER_CATALOG.claude;
  const currentModeMeta = MODE_LABELS[mode] || MODE_LABELS.acceptEdits;

  const handleSend = () => {
    const text = prompt.trim();
    if (!text) return;
    onStartThread(text, provider, mode, providerMeta.defaultModel);
  };

  return (
    <section className="pane chat-home">
      {/* Hero Header */}
      <div className="chat-home__hero">
        <h1>What’s on your mind?</h1>
        <p>Pick a model. Then ask.</p>
      </div>

      {/* Composer */}
      <div className="composer">
        <label className="sr-only" htmlFor="chat-composer">
          Message
        </label>
        <textarea
          id="chat-composer"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask anything…"
          rows={2}
          autoFocus
        />

        {/* Mode selection popover */}
        {activeDropdown === 'mode' && (
          <div className="chat-select-dropdown left-32">
            <div className="chat-select-dropdown-header">Execution Mode</div>
            {(['acceptEdits', 'readOnly', 'fullAccess'] as ChatMode[]).map((m) => {
              const meta = MODE_LABELS[m];
              return (
                <div
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setActiveDropdown(null);
                  }}
                  className={`chat-select-option ${mode === m ? 'chat-select-option--active' : ''}`}
                >
                  <span style={{ fontWeight: 'var(--weight-semibold)' }}>{meta.title}</span>
                  <span className="chat-select-option__detail">{meta.detail}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Provider selection popover */}
        {activeDropdown === 'provider' && (
          <div className="chat-select-dropdown left-2">
            <div className="chat-select-dropdown-header">AI Provider</div>
            {(Object.keys(PROVIDER_CATALOG) as ChatProvider[]).map((pKey) => {
              const pMeta = PROVIDER_CATALOG[pKey];
              return (
                <div
                  key={pKey}
                  onClick={() => {
                    setProvider(pKey);
                    setActiveDropdown(null);
                  }}
                  className={`chat-select-option ${provider === pKey ? 'chat-select-option--active' : ''}`}
                >
                  <span style={{ fontWeight: 'var(--weight-semibold)' }}>{pMeta.label}</span>
                  <span className="chat-select-option__detail">{pMeta.vendor}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Composer Footer */}
        <div className="composer__footer">
          {/* Provider button */}
          <button
            type="button"
            title="Provider selection"
            onClick={() => setActiveDropdown((prev) => (prev === 'provider' ? null : 'provider'))}
          >
            <CpuIcon size={14} style={{ color: 'var(--brand-purple)' }} />
            <span>Automatic · {providerMeta.label}</span>
            <ChevronDownIcon size={10} style={{ color: 'var(--text-secondary)' }} />
          </button>

          <span className="composer__divider" />

          {/* Permissions button */}
          <button
            type="button"
            title="Permissions mode"
            onClick={() => setActiveDropdown((prev) => (prev === 'mode' ? null : 'mode'))}
          >
            <CompassIcon size={13} style={{ color: 'var(--accent)' }} />
            <span>{currentModeMeta.title}</span>
            <ChevronDownIcon size={10} style={{ color: 'var(--text-secondary)' }} />
          </button>

          <span className="composer__spacer" />

          {/* Send button */}
          <button
            type="button"
            className="composer__send"
            disabled={!prompt.trim()}
            onClick={handleSend}
            aria-label="Send message"
            title={prompt.trim() ? 'Send prompt (Enter)' : 'Type a message'}
          >
            <SendIcon size={14} />
          </button>
        </div>
      </div>

      {/* Quick recent threads if any */}
      {knownThreads.length > 0 && onSelectThread && (
        <div style={{ width: '100%', maxWidth: '720px', marginTop: 'var(--space-6)' }}>
          <div style={{ fontSize: 'var(--text-caption)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)', padding: '0 4px' }}>
            Recent Conversations
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-2)' }}>
            {knownThreads.slice(0, 4).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectThread(t.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: '10px',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                <MessageSquareIcon size={13} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
                <span style={{ fontSize: 'var(--text-row)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {t.title || 'Untitled Thread'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
