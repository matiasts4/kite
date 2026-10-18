import React, { useState, useEffect } from 'react';
import { openSettingsTab } from '../../../lib/settingsNav';
import {
  readQuotaPreferences,
  saveQuotaPreferences,
  QUOTA_PREFS_CHANGED_EVENT,
} from '../../../lib/quota/quotaManager';

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: string;
  isDefault?: boolean;
  isLocal?: boolean;
}

const CONFIGURED_MODELS: ModelItem[] = [
  {
    id: 'antigravity-gemini-argon',
    name: 'Antigravity (Gemini 4 Argon / 3.8 Flash)',
    provider: 'Google DeepMind',
    contextWindow: '1M tokens',
    isDefault: true,
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextWindow: '200k tokens',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o / Codex',
    provider: 'OpenAI',
    contextWindow: '128k tokens',
  },
  {
    id: 'ollama-local',
    name: 'Ollama Local (Llama 3.2 / Qwen)',
    provider: 'Ollama On-Device',
    contextWindow: '128k tokens',
    isLocal: true,
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1 / V3',
    provider: 'DeepSeek',
    contextWindow: '64k tokens',
  },
];

export const ModelsTab: React.FC = () => {
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('bmone.defaultModel');
      return saved === 'antigravity-gemini-pro' || !saved ? 'antigravity-gemini-argon' : saved;
    } catch {
      return 'antigravity-gemini-argon';
    }
  });

  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>(() => {
    try {
      return (localStorage.getItem('bmone.reasoningEffort') as any) || 'medium';
    } catch {
      return 'medium';
    }
  });

  const [offlineFallback, setOfflineFallback] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bmone.offlineFallback') !== 'false';
    } catch {
      return true;
    }
  });

  const [streamResponses, setStreamResponses] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bmone.streamResponses') !== 'false';
    } catch {
      return true;
    }
  });

  const [agentMessaging, setAgentMessaging] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bmone.agentMessaging') !== 'false';
    } catch {
      return true;
    }
  });

  const [showPlanUsage, setShowPlanUsage] = useState<boolean>(() => {
    try {
      return readQuotaPreferences().enabled;
    } catch {
      return true;
    }
  });

  const [showPaneContext, setShowPaneContext] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bmone.showPaneContext') !== 'false';
    } catch {
      return true;
    }
  });

  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'connected' | 'offline'>('checking');

  useEffect(() => {
    let active = true;
    fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(1200) })
      .then((res) => {
        if (active) setOllamaStatus(res.ok ? 'connected' : 'offline');
      })
      .catch(() => {
        if (active) setOllamaStatus('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail && typeof e.detail.enabled === 'boolean') {
        setShowPlanUsage(e.detail.enabled);
      }
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  const handleModelChange = (id: string) => {
    setSelectedModel(id);
    try {
      localStorage.setItem('bmone.defaultModel', id);
    } catch {}
  };

  const handleReasoningChange = (effort: 'low' | 'medium' | 'high') => {
    setReasoningEffort(effort);
    try {
      localStorage.setItem('bmone.reasoningEffort', effort);
    } catch {}
  };

  const handleToggleStreaming = () => {
    const next = !streamResponses;
    setStreamResponses(next);
    try {
      localStorage.setItem('bmone.streamResponses', String(next));
    } catch {}
  };

  const handleToggleOfflineFallback = () => {
    const next = !offlineFallback;
    setOfflineFallback(next);
    try {
      localStorage.setItem('bmone.offlineFallback', String(next));
    } catch {}
  };

  const handleToggleMessaging = () => {
    const next = !agentMessaging;
    setAgentMessaging(next);
    try {
      localStorage.setItem('bmone.agentMessaging', String(next));
    } catch {}
  };

  const handleTogglePaneContext = () => {
    const next = !showPaneContext;
    setShowPaneContext(next);
    try {
      localStorage.setItem('bmone.showPaneContext', String(next));
    } catch {}
  };

  const handleTogglePlanUsage = () => {
    const next = !showPlanUsage;
    setShowPlanUsage(next);
    saveQuotaPreferences({ enabled: next });
  };

  return (
    <>
      {/* 1. Cuentas y CLI Vinculadas */}
      <section className="settings-group">
        <h2 className="settings-group__title">Suscripciones y Credenciales CLI</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Bóveda de Cuentas y Cuotas</h3>
              <p>Rotación de sesiones de Antigravity, Claude Code, Codex, Grok y OpenCode sin proxies.</p>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="secondary-button"
                onClick={() => openSettingsTab('quotas')}
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
              >
                Abrir Cuotas y Cuentas…
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Modelo Principal del Agente */}
      <section className="settings-group">
        <h2 className="settings-group__title">Modelo y Razonamiento del Agente</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Modelo predeterminado</h3>
              <p>Motor de razonamiento preferente para síntesis de código, terminal y análisis de proyecto.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <select
                aria-label="Modelo predeterminado"
                className="settings-control ui-button"
                onChange={(e) => handleModelChange(e.target.value)}
                value={selectedModel}
                style={{
                  height: '28px',
                  padding: '0 8px',
                  fontSize: '12px',
                  borderRadius: 'var(--radius-chip, 6px)',
                  background: 'var(--block-fill, rgba(255,255,255,0.05))',
                  border: '1px solid var(--block-stroke, rgba(255,255,255,0.1))',
                  color: 'var(--text-primary)',
                }}
              >
                {CONFIGURED_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.provider})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Nivel de razonamiento (Thinking)</h3>
              <p>Presupuesto computacional asignado para la cadena de pensamiento interna antes de emitir código.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Nivel de razonamiento" className="ui-segmented">
                <button
                  aria-pressed={reasoningEffort === 'low'}
                  className="ui-segmented__item"
                  onClick={() => handleReasoningChange('low')}
                  type="button"
                >
                  <span>Bajo</span>
                </button>
                <button
                  aria-pressed={reasoningEffort === 'medium'}
                  className="ui-segmented__item"
                  onClick={() => handleReasoningChange('medium')}
                  type="button"
                >
                  <span>Medio</span>
                </button>
                <button
                  aria-pressed={reasoningEffort === 'high'}
                  className="ui-segmented__item"
                  onClick={() => handleReasoningChange('high')}
                  type="button"
                >
                  <span>Alto</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Transmisión de respuesta (Streaming)</h3>
              <p>Envía los tokens inmediatamente al chat y terminales conforme se generan.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={streamResponses}
                aria-label="Streaming de respuestas"
                className="ui-switch"
                onClick={handleToggleStreaming}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Ejecución Local y Offline */}
      <section className="settings-group">
        <h2 className="settings-group__title">Ejecución Local &amp; Ollama</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Respaldo offline automático</h3>
              <p>Derivar las solicitudes a modelos locales en Ollama si se pierde la conexión de red.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={offlineFallback}
                aria-label="Respaldo offline"
                className="ui-switch"
                onClick={handleToggleOfflineFallback}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Servicio local Ollama (127.0.0.1:11434)</h3>
              <p>Detección en tiempo real del motor local en segundo plano.</p>
            </div>
            <div className="settings-row__control">
              <span
                className="settings-badge"
                data-tone={ollamaStatus === 'connected' ? 'running' : 'idle'}
              >
                {ollamaStatus === 'checking'
                  ? 'Comprobando…'
                  : ollamaStatus === 'connected'
                  ? 'En línea'
                  : 'No detectado'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Colaboración entre Agentes */}
      <section className="settings-group">
        <h2 className="settings-group__title">Colaboración entre Agentes</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Comunicación inter-agente</h3>
              <p>Permite que subagentes envíen reportes y se invoquen entre sí para resolver tareas complejas.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={agentMessaging}
                aria-label="Comunicación entre agentes"
                className="ui-switch"
                onClick={handleToggleMessaging}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Mostrar medidor de cuota en barra superior</h3>
              <p>Visualiza el porcentaje restante y reseteo del proveedor activo en la pastilla superior.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={showPlanUsage}
                aria-label="Mostrar medidor en barra superior"
                className="ui-switch"
                onClick={handleTogglePlanUsage}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Indicador de cuota en cabeceras</h3>
              <p>Muestra el porcentaje restante de cuota y ventana de contexto en cada pestaña de agente.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={showPaneContext}
                aria-label="Indicador en cabeceras"
                className="ui-switch"
                onClick={handleTogglePaneContext}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};
