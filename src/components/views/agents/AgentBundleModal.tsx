import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CuratedAgentTemplate } from './types';

export interface AgentBundleModalProps {
  isOpen: boolean;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onImported?: () => void;
}

export const AgentBundleModal: React.FC<AgentBundleModalProps> = ({
  isOpen,
  agentId,
  agentName,
  onClose,
  onImported,
}) => {
  const [exportedJson, setExportedJson] = useState<string>('');
  const [importJson, setImportJson] = useState<string>('');
  const [templates, setTemplates] = useState<CuratedAgentTemplate[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setStatus(null);
    void invoke<{ templates?: CuratedAgentTemplate[] }>('list_curated_agent_templates')
      .then((res) => setTemplates(res?.templates ?? []))
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const bundle = await invoke<Record<string, unknown>>('export_agent_bundle', {
        request: { agentId },
      });
      setExportedJson(JSON.stringify(bundle, null, 2));
      setStatus('Exported portable .kite-agent.json (secrets and local paths stripped).');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!importJson.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(importJson);
      await invoke('import_agent_bundle', { request: { bundle: parsed } });
      setStatus('Agent bundle imported cleanly.');
      setImportJson('');
      onImported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid .kite-agent.json bundle');
    } finally {
      setBusy(false);
    }
  };

  const handleInstallTemplate = async (tpl: CuratedAgentTemplate) => {
    setBusy(true);
    setError(null);
    try {
      await invoke('import_agent_bundle', {
        request: {
          bundle: {
            schema: 'kite-agent/v1',
            bundleVersion: 1,
            agent: {
              name: tpl.name,
              engine: tpl.engine,
              brief: tpl.brief,
              toolPolicies: tpl.toolPolicies,
            },
            skills: [],
            knowledgePacks: [],
          },
        },
      });
      setStatus(`Created specialist from template: ${tpl.name}`);
      onImported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Template install failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="notif-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'var(--glass-modal-scrim, rgba(0, 0, 0, 0.72))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="notif-modal-dialog ui-card"
        role="dialog"
        aria-label={`Portable Bundles & Templates — ${agentName}`}
        style={{
          width: '680px',
          maxWidth: '100%',
          maxHeight: '86vh',
          padding: '18px',
          borderRadius: 'var(--dialog-radius, 14px)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div className="agent-playbooks__run-header">
          <div>
            <strong>Portable `.kite-agent.json` Bundles & Templates</strong>
            <p className="agent-knowledge__meta">
              Share specialist charters, skills, tool policies, and relative Knowledge Pack globs without credentials or local paths.
            </p>
          </div>
          <button type="button" className="chrome-button" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <p className="agent-feedback agent-feedback--error" role="alert">
            {error}
          </p>
        ) : null}
        {status ? (
          <p className="agent-feedback" role="status">
            {status}
          </p>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void handleExport()}>
              Export {agentName} (.kite-agent.json)
            </button>
          </div>
          {exportedJson ? (
            <textarea
              aria-label="Exported agent bundle JSON"
              readOnly
              rows={6}
              className="ui-field"
              style={{ minHeight: '120px', padding: '8px' }}
              value={exportedJson}
            />
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="ui-eyebrow">Import `.kite-agent.json` Bundle</span>
          <textarea
            aria-label="Paste bundle JSON"
            rows={4}
            className="ui-field"
            style={{ minHeight: '90px', padding: '8px' }}
            placeholder='{"schema":"kite-agent/v1","agent":{...}}'
            value={importJson}
            onChange={(e) => setImportJson(e.currentTarget.value)}
          />
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !importJson.trim()}
              onClick={() => void handleImport()}
            >
              Import Bundle
            </button>
          </div>
        </div>

        {templates.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span className="ui-eyebrow">Curated Specialist Templates</span>
            {templates.map((tpl) => (
              <div key={tpl.id} className="agent-knowledge__item ui-card">
                <div className="agent-knowledge__item-info">
                  <strong>{tpl.name}</strong>
                  <span className="agent-knowledge__meta">
                    {tpl.engine} · {tpl.summary}
                  </span>
                </div>
                <button
                  type="button"
                  className="chrome-button"
                  disabled={busy}
                  onClick={() => void handleInstallTemplate(tpl)}
                >
                  Create from template
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};
