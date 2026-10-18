import React, { useState } from 'react';
import { Sheet } from '../../ui/Sheet';
import { TicketConnection, TicketSnapshot, formatMcpToml } from './types';

export interface ConnectMcpModalProps {
  snapshot?: TicketSnapshot | null;
  connections: TicketConnection[];
  busy?: boolean;
  onConnect: (name: string, readOnly: boolean) => Promise<string>;
  onGetConfiguration: (id: string) => Promise<string>;
  onRevoke: (id: string) => Promise<void>;
  onClose: () => void;
}

export const ConnectMcpModal: React.FC<ConnectMcpModalProps> = ({
  connections,
  busy = false,
  onConnect,
  onGetConfiguration,
  onRevoke,
  onClose,
}) => {
  const [name, setName] = useState('My coding agent');
  const [readOnly, setReadOnly] = useState(false);
  const [rawConfig, setRawConfig] = useState('');
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<'json' | 'codex'>('json');

  const displayConfig = format === 'codex' && rawConfig ? formatMcpToml(rawConfig) : rawConfig;

  const handleCreateConnection = async () => {
    if (busy || !name.trim()) return;
    setRawConfig('');
    setCopied(false);
    const cfg = await onConnect(name.trim(), readOnly);
    setRawConfig(cfg);
  };

  const handleShowConfig = async (id: string) => {
    if (busy) return;
    setRawConfig('');
    setCopied(false);
    const cfg = await onGetConfiguration(id);
    setRawConfig(cfg);
  };

  const handleRevoke = async (id: string) => {
    if (busy) return;
    await onRevoke(id);
    setRawConfig('');
  };

  const handleCopy = async () => {
    if (busy || !displayConfig) return;
    try {
      await navigator.clipboard.writeText(displayConfig);
      setCopied(true);
    } catch {
      // ignore clipboard errors
    }
  };

  const activeConnections = connections.filter((c) => !c.revokedAt);

  return (
    <Sheet
      open={true}
      onCancel={onClose}
      title="Connect MCP"
      width={560}
      className="ticket-sheet ticket-mcp"
    >
      <div
        className="ticket-sheet__content"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <button
          type="button"
          className="secondary-button action-button--row ticket-sheet__done"
          onClick={onClose}
        >
          Done
        </button>

        <p className="tickets-muted">
          Your agent starts the included server when it needs it. Tasks stay in local JSON files, and the app can be closed.
        </p>

        <div className="ticket-mcp__form">
          <input
            aria-label="Connection name"
            className="ui-field"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleCreateConnection();
              }
            }}
          />

          <span className="ticket-mcp__read-only">
            <button
              type="button"
              role="switch"
              aria-label="Read only"
              aria-checked={readOnly}
              className="ui-switch"
              disabled={busy}
              onClick={() => setReadOnly((v) => !v)}
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
            <span aria-hidden="true">Read only</span>
          </span>

          <button
            type="button"
            className="primary-button action-button--row"
            disabled={busy || !name.trim()}
            onClick={() => void handleCreateConnection()}
          >
            Create connection
          </button>
        </div>

        {rawConfig ? (
          <div className="ticket-mcp__config">
            <fieldset aria-label="Format" className="ui-segmented">
              <button
                type="button"
                aria-pressed={format === 'json'}
                className="ui-segmented__item"
                onClick={() => {
                  setFormat('json');
                  setCopied(false);
                }}
              >
                <span className="ui-segmented__label" data-label="JSON">
                  JSON
                </span>
              </button>
              <button
                type="button"
                aria-pressed={format === 'codex'}
                className="ui-segmented__item"
                onClick={() => {
                  setFormat('codex');
                  setCopied(false);
                }}
              >
                <span className="ui-segmented__label" data-label="Codex TOML">
                  Codex TOML
                </span>
              </button>
            </fieldset>

            <pre className="tickets-config">{displayConfig}</pre>

            <button
              type="button"
              className="secondary-button action-button--row"
              disabled={busy}
              onClick={() => void handleCopy()}
            >
              {copied ? 'Copied' : 'Copy configuration'}
            </button>

            <p className="tickets-muted">
              Paste into your MCP client’s server settings, then reconnect or restart that client.
            </p>
          </div>
        ) : null}

        <h2>Connections</h2>
        <ul className="ticket-mcp__grants">
          {activeConnections.map((conn) => (
            <li key={conn.id} className="ticket-mcp__grant">
              <span>
                {conn.name}
                <span className="tickets-muted">
                  {' '}
                  · {conn.readOnly ? 'Read only' : 'Read & write'}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Show configuration for ${conn.name}`}
                className="secondary-button action-button--row"
                disabled={busy}
                onClick={() => void handleShowConfig(conn.id)}
              >
                Show configuration
              </button>
              <button
                type="button"
                aria-label={`Revoke ${conn.name}`}
                className="secondary-button action-button--row"
                disabled={busy}
                onClick={() => void handleRevoke(conn.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>

        <p className="tickets-muted">
          Local storage does not control where your AI client sends the task content it reads.
        </p>
      </div>
    </Sheet>
  );
};
