import React, { useState, useEffect, useCallback, useId } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import type { Workspace } from '../../../types';
import { Sheet } from '../../ui/Sheet';

export interface SshWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect?: (workspace: Workspace) => void;
  reconnectWorkspaceId?: string;
}

export interface SavedSshEndpoint {
  id: string;
  host: string;
  username: string;
  folder: string;
  port: number;
  lastConnectedAtUnixMs: number;
}

const STORAGE_KEY = 'bmone.ssh_recent_workspaces';

function isRestrictedFolder(folder: string): boolean {
  const trimmed = folder.trim();
  return (
    trimmed === '/' ||
    trimmed === '~' ||
    trimmed === '/root' ||
    trimmed === '~/.ssh' ||
    trimmed === '/etc' ||
    trimmed.length === 0
  );
}

// Clean inline SVG components (zero Lucide, zero emojis)
const IconFolderGit: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <circle cx="12" cy="13" r="2" />
    <path d="M12 15v3" />
  </svg>
);

const IconTrash: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </svg>
);

export const SshWorkspaceModal: React.FC<SshWorkspaceModalProps> = ({
  isOpen,
  onClose,
  onConnect,
  reconnectWorkspaceId,
}) => {
  const baseId = useId();
  const [host, setHost] = useState<string>('');
  const [username, setUsername] = useState<string>('');
  const [folder, setFolder] = useState<string>('');
  const [port, setPort] = useState<string>('22');
  const [chooseKey, setChooseKey] = useState<boolean>(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savedEndpoints, setSavedEndpoints] = useState<SavedSshEndpoint[]>([]);

  // Load saved endpoints from localStorage
  const loadSavedEndpoints = useCallback(() => {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          setSavedEndpoints(parsed);
        }
      }
    } catch {
      // LocalStorage fallback
    }
  }, []);

  const handleReconnect = useCallback(
    async (workspaceId: string) => {
      setIsConnecting(true);
      setErrorMessage(null);
      setStatusMessage('Reconnecting to existing SSH workspace session…');

      try {
        const result = await invokeCommand<Workspace | null>('reconnect_ssh_workspace', {
          workspaceId,
        });

        if (result && result.id) {
          if (onConnect) onConnect(result);
          onClose();
        } else {
          setErrorMessage('Could not reconnect to this SSH workspace. Please connect again.');
        }
      } catch (err: unknown) {
        console.warn('SSH reconnect error:', err);
        setErrorMessage('Failed to reconnect to SSH workspace.');
      } finally {
        setIsConnecting(false);
      }
    },
    [onConnect, onClose]
  );

  useEffect(() => {
    if (isOpen) {
      loadSavedEndpoints();
      setErrorMessage(null);
      setStatusMessage(null);
      setIsConnecting(false);
    }
  }, [isOpen, loadSavedEndpoints]);

  // Attempt reconnect if reconnectWorkspaceId was provided on mount
  useEffect(() => {
    if (isOpen && reconnectWorkspaceId) {
      handleReconnect(reconnectWorkspaceId);
    }
  }, [isOpen, reconnectWorkspaceId, handleReconnect]);

  const handleConnect = async () => {
    if (isConnecting) return;

    setErrorMessage(null);
    setStatusMessage(null);

    const trimmedHost = host.trim();
    const trimmedFolder = folder.trim();
    const trimmedUser = username.trim() || 'builder';
    const parsedPort = port.trim() === '' ? 22 : Number(port);

    if (!trimmedHost) {
      setErrorMessage('Enter a machine or SSH config name to connect.');
      return;
    }

    if (!trimmedFolder) {
      setErrorMessage('Enter a project folder path, such as ~/projects/app.');
      return;
    }

    if (isRestrictedFolder(trimmedFolder)) {
      setErrorMessage(
        'Choose a project folder, such as ~/projects/app. The filesystem root, home folder and credential folders cannot be workspaces.'
      );
      return;
    }

    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setErrorMessage('Enter a valid port number between 1 and 65535 (default 22).');
      return;
    }

    setIsConnecting(true);
    setStatusMessage(
      'Connecting… Complete or cancel any system sign-in prompt. This may take up to two minutes.'
    );

    try {
      const result = await invokeCommand<Workspace | null>('connect_ssh_workspace', {
        host: trimmedHost,
        username: trimmedUser,
        folder: trimmedFolder,
        port: parsedPort,
      });

      if (result && result.id) {
        const newRecord: SavedSshEndpoint = {
          id: result.id,
          host: trimmedHost,
          username: trimmedUser,
          folder: trimmedFolder,
          port: parsedPort,
          lastConnectedAtUnixMs: Date.now(),
        };

        const updated = [newRecord, ...savedEndpoints.filter((s) => s.id !== result.id)].slice(0, 10);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
          setSavedEndpoints(updated);
        } catch {
          // ignore storage error
        }

        setStatusMessage('Connected to SSH workspace.');
        if (onConnect) onConnect(result);
        onClose();
      } else {
        setErrorMessage(
          'Could not connect. Check your SSH key, machine identity, and folder, then try again.'
        );
      }
    } catch (err: unknown) {
      console.warn('SSH connect error:', err);
      setErrorMessage(
        'Could not connect. Check your SSH key, machine identity, and folder, then try again.'
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDeleteSaved = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = savedEndpoints.filter((s) => s.id !== id);
    setSavedEndpoints(filtered);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    } catch {
      // ignore
    }
  };

  const isFormValid = host.trim().length > 0 && folder.trim().length > 0 && !isConnecting;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleConnect();
    }
  };

  const handleCancel = () => {
    if (!isConnecting) onClose();
  };

  return (
    <Sheet
      className="ssh-workspace-dialog"
      description="Open a folder on a Linux or Mac machine. Your agent runs there using its existing login."
      onCancel={handleCancel}
      open={isOpen}
      primary={{
        label: isConnecting ? 'Connecting…' : 'Connect',
        onClick: () => void handleConnect(),
        disabled: !isFormValid || isConnecting,
        loading: isConnecting,
      }}
      secondary={{
        label: 'Cancel',
        onClick: handleCancel,
        disabled: isConnecting,
      }}
      title="Connect via SSH"
      width={440}
    >
      <fieldset className="ssh-workspace-dialog__fields" disabled={isConnecting}>
        <label htmlFor={`${baseId}-host`}>Machine</label>
        <input
          id={`${baseId}-host`}
          type="text"
          autoComplete="off"
          autoFocus
          placeholder="server or SSH config name"
          spellCheck={false}
          title="Hostname, IP address, or a name from your SSH config"
          value={host}
          onChange={(e) => {
            setErrorMessage(null);
            setHost(e.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <label htmlFor={`${baseId}-user`}>Username</label>
        <input
          id={`${baseId}-user`}
          type="text"
          autoComplete="off"
          placeholder="Use SSH configuration"
          spellCheck={false}
          value={username}
          onChange={(e) => {
            setErrorMessage(null);
            setUsername(e.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <label htmlFor={`${baseId}-folder`}>Folder</label>
        <input
          id={`${baseId}-folder`}
          type="text"
          autoComplete="off"
          placeholder="~/projects/app"
          spellCheck={false}
          value={folder}
          onChange={(e) => {
            setErrorMessage(null);
            setFolder(e.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          aria-controls={`${baseId}-advanced`}
          aria-expanded={isAdvancedOpen}
          className="ssh-workspace-dialog__disclosure"
          onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span>Advanced</span>
        </button>
        <div className="ssh-workspace-dialog__advanced" hidden={!isAdvancedOpen} id={`${baseId}-advanced`}>
          <label htmlFor={`${baseId}-port`}>Port</label>
          <input
            id={`${baseId}-port`}
            type="text"
            className="ssh-workspace-dialog__port"
            autoComplete="off"
            inputMode="numeric"
            maxLength={5}
            value={port}
            onChange={(e) => {
              setErrorMessage(null);
              setPort(e.target.value.replace(/[^0-9]/gu, ''));
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="ssh-workspace-dialog__key">
            <input
              id={`${baseId}-key`}
              type="checkbox"
              checked={chooseKey}
              onChange={(e) => setChooseKey(e.target.checked)}
            />
            <label htmlFor={`${baseId}-key`}>Choose an SSH key when connecting</label>
          </div>
          <p className="ssh-workspace-dialog__hint">
            Otherwise, use your SSH agent or existing SSH configuration.
          </p>
        </div>
      </fieldset>

      {errorMessage && (
        <p className="ssh-workspace-dialog__error" role="alert">
          {errorMessage}
        </p>
      )}

      {statusMessage && (
        <p className="ssh-workspace-dialog__status" role="status">
          {statusMessage}
        </p>
      )}

      {savedEndpoints.length > 0 && (
        <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--separator)' }}>
          <div
            style={{
              fontSize: 'var(--text-badge)',
              fontWeight: 'var(--weight-semibold)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-1)',
            }}
          >
            Recent SSH Workspaces
          </div>
          <div style={{ display: 'grid', gap: '4px', maxHeight: '120px', overflowY: 'auto' }}>
            {savedEndpoints.map((ep) => (
              <div
                key={ep.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-chip)',
                  background: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-row)',
                }}
                onClick={() => {
                  setHost(ep.host);
                  setUsername(ep.username);
                  setFolder(ep.folder);
                  setPort(String(ep.port));
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                  <span style={{ color: 'var(--accent)', display: 'inline-flex', flex: 'none' }}>
                    <IconFolderGit size={13} />
                  </span>
                  <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                    {ep.username}@{ep.host}
                  </span>
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: 'var(--text-caption)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ep.folder}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleReconnect(ep.id);
                    }}
                    disabled={isConnecting}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-pill)',
                      fontSize: 'var(--text-caption)',
                      background: 'var(--accent-tint)',
                      color: 'var(--accent)',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteSaved(ep.id, e)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      padding: '2px 4px',
                    }}
                    title="Remove from recents"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
};
