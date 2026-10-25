import React, { useState, useEffect } from 'react';
import { openSettingsTab } from '../../../lib/settingsNav';
import {
  readQuotaPreferences,
  saveQuotaPreferences,
  QUOTA_PREFS_CHANGED_EVENT,
} from '../../../lib/quota/quotaManager';

export const ModelsTab: React.FC = () => {
  const [offlineFallback, setOfflineFallback] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bmone.offlineFallback') !== 'false';
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

      <section className="settings-group">
        <h2 className="settings-group__title">Modelo del chat</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Se elige en la conversación</h3>
              <p>
                El menú del chat muestra los modelos que el programa conectado acaba de listar, o Automático
                si todavía no hay lista. Esta pantalla no elige un modelo y no conecta una cuenta.
              </p>
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
