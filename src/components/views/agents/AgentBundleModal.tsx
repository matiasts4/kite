import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RECOMMENDED_SPECIALIST_TEMPLATES } from './agentPresets';
import type { CuratedAgentTemplate } from './types';

export interface AgentBundleModalProps {
  isOpen: boolean;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onImported?: () => void;
}

const RECOMMENDED_IDS = new Set(['ship-guard', 'discovery-architect']);

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
      .catch((err) => {
        console.warn('[AgentBundleModal] Failed to load curated templates:', err);
      });
  }, [isOpen]);

  const recommendedTemplates = useMemo(() => {
    const fromBackend = templates.filter((t) => RECOMMENDED_IDS.has(t.id));
    if (fromBackend.length > 0) return fromBackend;
    return RECOMMENDED_SPECIALIST_TEMPLATES.map((p) => ({
      id: p.id,
      name: p.name,
      engine: p.engine,
      roleBadge: p.roleBadge,
      summary: p.summary,
      brief: p.brief,
      toolPolicies: {},
      knowledgePackGlobs: [],
    }));
  }, [templates]);

  const coreTemplates = useMemo(
    () => templates.filter((t) => !RECOMMENDED_IDS.has(t.id)),
    [templates]
  );

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

  const handleInstallCuratedTemplate = async (templateId: string, templateName: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{
        installed?: boolean;
        created?: boolean;
        readinessScore?: number;
      }>('install_curated_agent_template', {
        request: { templateId },
      });
      const scoreSuffix =
        typeof res?.readinessScore === 'number' ? ` (Readiness ${res.readinessScore}/100)` : '';
      setStatus(
        `${res?.created === false ? 'Updated' : 'Installed'} specialist: ${templateName}${scoreSuffix}`
      );
      onImported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Template install failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="notif-modal-backdrop agent-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="notif-modal-dialog ui-card agent-modal-dialog"
        role="dialog"
        aria-label={`Portable Bundles & Templates — ${agentName}`}
      >
        <div className="agent-playbooks__run-header">
          <div>
            <strong>Portable `.kite-agent.json` Bundles &amp; Templates</strong>
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

        <div className="agent-modal-section">
          <div className="agent-modal-row">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void handleExport()}>
              Export {agentName} (.kite-agent.json)
            </button>
          </div>
          {exportedJson ? (
            <textarea
              aria-label="Exported agent bundle JSON"
              readOnly
              rows={6}
              className="ui-field agent-modal-textarea"
              value={exportedJson}
            />
          ) : null}
        </div>

        <div className="agent-modal-section">
          <span className="ui-eyebrow">Import `.kite-agent.json` Bundle</span>
          <textarea
            aria-label="Paste bundle JSON"
            rows={4}
            className="ui-field agent-modal-textarea"
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

        <div className="agent-modal-section">
          <span className="ui-eyebrow">Recommended Specialists (Antigravity)</span>
          {recommendedTemplates.map((tpl) => (
            <div key={tpl.id} className="agent-knowledge__item ui-card">
              <div className="agent-knowledge__item-info">
                <strong>{tpl.name}</strong>
                <span className="agent-knowledge__meta">
                  {tpl.engine} · {tpl.summary}
                </span>
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void handleInstallCuratedTemplate(tpl.id, tpl.name)}
              >
                Install {tpl.name}
              </button>
            </div>
          ))}
        </div>

        {coreTemplates.length > 0 ? (
          <div className="agent-modal-section">
            <span className="ui-eyebrow">Curated Core Templates</span>
            {coreTemplates.map((tpl) => (
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
                  onClick={() => void handleInstallCuratedTemplate(tpl.id, tpl.name)}
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
