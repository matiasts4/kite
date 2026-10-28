import React, { useEffect, useState } from 'react';
import {
  OperatorConfig,
  OperatorProviderId,
  OpenCodeModelOption,
} from '../../../../lib/operator/operatorConfig';
import {
  isVerifiedChatEndpoint,
  listZedChatConnections,
} from '../../../../lib/operator/operatorProviders';
import type { ConnectionSummary } from '../../../../lib/ipc';
import { ModelSearchField } from './ModelSearchField';
import { SegmentedIndicator } from '../../../ui/SegmentedIndicator';

export interface ZedProvidersSectionProps {
  config: OperatorConfig;
  onFieldChange: <K extends keyof OperatorConfig>(key: K, value: OperatorConfig[K]) => void;
  onPersistConfig: (next: OperatorConfig) => void;
  showApiKeys: Record<string, boolean>;
  onToggleApiKey: (provider: string) => void;
  testingProvider: OperatorProviderId | null;
  onRunProbe: (providerId: OperatorProviderId) => void;
  openCodeGoCredential: { available: boolean; source: string | null } | null;
  effectiveOpenCodeModels: OpenCodeModelOption[];
  syncingModels: boolean;
  openCodeSavedAt: string | null;
  onSyncModels: () => void;
  effectiveVercelModels: OpenCodeModelOption[];
  syncingVercelModels: boolean;
  vercelSavedAt: string | null;
  onSyncVercelModels: () => void;
  effectiveCloudflareModels: OpenCodeModelOption[];
  syncingCloudflareModels: boolean;
  cloudflareSavedAt: string | null;
  onSyncCloudflareModels: () => void;
}

interface ProviderMeta {
  id: OperatorProviderId;
  name: string;
}

const PROVIDERS: ProviderMeta[] = [
  { id: 'opencode', name: 'OpenCode Go' },
  { id: 'vercel', name: 'Vercel AI' },
  { id: 'cloudflare', name: 'Cloudflare AI' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'grok', name: 'Grok' },
  { id: 'local', name: 'Local (0ms)' },
];

export const ZedProvidersSection: React.FC<ZedProvidersSectionProps> = ({
  config,
  onFieldChange,
  onPersistConfig,
  showApiKeys,
  onToggleApiKey,
  testingProvider,
  onRunProbe,
  openCodeGoCredential,
  effectiveOpenCodeModels,
  syncingModels,
  openCodeSavedAt,
  onSyncModels,
  effectiveVercelModels,
  syncingVercelModels,
  vercelSavedAt,
  onSyncVercelModels,
  effectiveCloudflareModels,
  syncingCloudflareModels,
  cloudflareSavedAt,
  onSyncCloudflareModels,
}) => {
  const [verifiedChatConnections, setVerifiedChatConnections] = useState<ConnectionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listZedChatConnections().then((connections) => {
      if (!cancelled) setVerifiedChatConnections(connections);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const renderProviderBody = (providerId: OperatorProviderId) => {
    switch (providerId) {
      case 'opencode':
        return (
          <>
            <p className="zed-provider__note">
              Usa tu suscripción OpenCode Go a través del gateway oficial. Si ya iniciaste sesión
              con <code>opencode auth login opencode-go</code>, la credencial se resuelve sola y no
              hace falta pegarla acá.
            </p>

            <div className="zed-provider__toolbar">
              <button
                type="button"
                className="secondary-button"
                disabled={syncingModels}
                onClick={onSyncModels}
              >
                {syncingModels ? 'Actualizando...' : 'Actualizar lista'}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={testingProvider !== null}
                onClick={() => void onRunProbe('opencode')}
              >
                {testingProvider === 'opencode' ? 'Probando...' : 'Probar OpenCode Go'}
              </button>
            </div>

            <div className="zed-provider__grid">
              <div>
                <div className="settings-row settings-row--stacked">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">API Key de OpenCode Go (opcional)</h3>
                  </div>
                  <div className="settings-row__control">
                    <div className="settings-credential">
                      <input
                        type={showApiKeys.opencode ? 'text' : 'password'}
                        className="ui-field"
                        value={config.opencodeApiKey}
                        onChange={(e) => onFieldChange('opencodeApiKey', e.target.value)}
                        placeholder="oc_sk_..."
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="API Key de OpenCode Go (opcional)"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => onToggleApiKey('opencode')}
                        title={showApiKeys.opencode ? 'Ocultar API Key' : 'Mostrar API Key'}
                      >
                        {showApiKeys.opencode ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                </div>
                {config.opencodeApiKey ? (
                  <span style={{ fontSize: '11px', color: 'var(--text-success, #4ade80)', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                    Guardada en Bóveda Local SQLite
                  </span>
                ) : openCodeGoCredential?.available ? (
                  <span style={{ fontSize: '11px', color: 'var(--text-success, #4ade80)', display: 'block', marginTop: '4px' }}>
                    Credencial detectada en OpenCode CLI ({openCodeGoCredential.source}). El campo
                    puede quedar vacío.
                  </span>
                ) : (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted, #94a3b8)', marginTop: '4px', display: 'block' }}>
                    Ejecutá <code>opencode auth login opencode-go</code> o pegá una key{' '}
                    <code>oc_sk_...</code>. También se acepta <code>OPENCODE_API_KEY</code>.
                  </span>
                )}
              </div>

              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Base URL del gateway Go
                </label>
                <input
                  type="text"
                  className="zed-settings__input"
                  value={config.opencodeBaseUrl}
                  onChange={(e) => onFieldChange('opencodeBaseUrl', e.target.value)}
                  placeholder="https://opencode.ai/inference/go/openai/v1"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--text-muted, #94a3b8)', marginTop: '4px', display: 'block' }}>
                  Debe ser la ruta de la suscripción: <code>/inference/go/openai/v1</code>. La ruta
                  <code> /inference/v1</code> factura pay-as-you-go y devuelve 402.
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
              <span>
                Sesión Go: <code>{config.opencodeSessionId || 'se genera automáticamente'}</code>
              </span>
              <span>
                Header requerido: <code>x-opencode-session</code>
              </span>
            </div>

            <ModelSearchField
              label="Modelo de OpenCode"
              models={effectiveOpenCodeModels}
              value={config.opencodeModel}
              savedAt={openCodeSavedAt}
              onSelect={(modelId) => {
                onPersistConfig({
                  ...config,
                  activeProvider: 'opencode',
                  opencodeModel: modelId,
                });
              }}
            />
            <div>
              <label className="zed-settings__label" htmlFor="opencode-model-id" style={{ display: 'block', marginBottom: 5 }}>
                Id exacto
              </label>
              <input
                id="opencode-model-id"
                type="text"
                className="zed-settings__input"
                value={config.opencodeModel}
                onChange={(e) => onFieldChange('opencodeModel', e.target.value)}
                placeholder="deepseek-v4.1-flash"
                title="Pega un id que no esté en la lista"
                style={{ width: '100%' }}
              />
            </div>
          </>
        );

      case 'vercel':
        return (
          <>
            <p className="zed-provider__note">
              Acceso unificado con streaming para DeepSeek, OpenAI, Anthropic y Google con capa
              gratuita y baja latencia.
            </p>

            <div className="zed-provider__toolbar">
              <button
                type="button"
                className="secondary-button"
                disabled={syncingVercelModels}
                onClick={onSyncVercelModels}
                title="Obtener catálogo actualizado de modelos desde Vercel AI Gateway"
              >
                {syncingVercelModels ? 'Actualizando...' : 'Actualizar lista'}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={testingProvider !== null}
                onClick={() => void onRunProbe('vercel')}
              >
                {testingProvider === 'vercel' ? 'Probando...' : 'Probar Vercel'}
              </button>
            </div>

            <div className="zed-provider__grid">
              <div>
                <div className="settings-row settings-row--stacked">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">Vercel AI Gateway API Key</h3>
                  </div>
                  <div className="settings-row__control">
                    <div className="settings-credential">
                      <input
                        type={showApiKeys.vercel ? 'text' : 'password'}
                        className="ui-field"
                        value={config.vercelApiKey}
                        onChange={(e) => onFieldChange('vercelApiKey', e.target.value)}
                        placeholder="vck_..."
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Vercel AI Gateway API Key"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => onToggleApiKey('vercel')}
                        title={showApiKeys.vercel ? 'Ocultar API Key' : 'Mostrar API Key'}
                      >
                        {showApiKeys.vercel ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Vercel AI Gateway Base URL
                </label>
                <input
                  type="text"
                  className="zed-settings__input"
                  value={config.vercelBaseUrl}
                  onChange={(e) => onFieldChange('vercelBaseUrl', e.target.value)}
                  placeholder="https://ai-gateway.vercel.sh/v1"
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <ModelSearchField
              label="Modelo de Vercel AI Gateway"
              models={effectiveVercelModels}
              value={config.vercelModel}
              savedAt={vercelSavedAt}
              onSelect={(modelId) => {
                onPersistConfig({
                  ...config,
                  activeProvider: 'vercel',
                  vercelModel: modelId,
                });
              }}
            />
            <div>
              <label className="zed-settings__label" htmlFor="vercel-model-id" style={{ display: 'block', marginBottom: 5 }}>
                Id exacto
              </label>
              <input
                id="vercel-model-id"
                type="text"
                className="zed-settings__input"
                value={config.vercelModel}
                onChange={(e) => onFieldChange('vercelModel', e.target.value)}
                placeholder="deepseek/deepseek-chat"
                title="Pega un id que no esté en la lista"
                style={{ width: '100%' }}
              />
            </div>
          </>
        );

      case 'cloudflare':
        return (
          <>
            <p className="zed-provider__note">
              Inferencia edge en más de 300 ubicaciones. 10.000 neuronas gratis por día con modelos
              como Llama 3.1 8B, DeepSeek R1 y Qwen Coder.
            </p>

            <div className="zed-provider__toolbar">
              <button
                type="button"
                className="secondary-button"
                disabled={syncingCloudflareModels}
                onClick={onSyncCloudflareModels}
                title="Obtener catálogo actualizado de modelos desde Cloudflare Workers AI"
              >
                {syncingCloudflareModels ? 'Actualizando...' : 'Actualizar lista'}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={testingProvider !== null}
                onClick={() => void onRunProbe('cloudflare')}
              >
                {testingProvider === 'cloudflare' ? 'Probando...' : 'Probar Cloudflare'}
              </button>
            </div>

            <div className="zed-provider__grid">
              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Cloudflare Account ID
                </label>
                <input
                  type="text"
                  className="zed-settings__input"
                  value={config.cloudflareAccountId}
                  onChange={(e) => onFieldChange('cloudflareAccountId', e.target.value)}
                  placeholder="Tu Account ID de Cloudflare"
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div className="settings-row settings-row--stacked">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">Cloudflare API Token</h3>
                  </div>
                  <div className="settings-row__control">
                    <div className="settings-credential">
                      <input
                        type={showApiKeys.cloudflare ? 'text' : 'password'}
                        className="ui-field"
                        value={config.cloudflareApiToken}
                        onChange={(e) => onFieldChange('cloudflareApiToken', e.target.value)}
                        placeholder="Workers AI Token..."
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Cloudflare API Token"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => onToggleApiKey('cloudflare')}
                        title={showApiKeys.cloudflare ? 'Ocultar API Token' : 'Mostrar API Token'}
                      >
                        {showApiKeys.cloudflare ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="zed-provider__grid">
              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  AI Gateway Slug (Opcional)
                </label>
                <input
                  type="text"
                  className="zed-settings__input"
                  value={config.cloudflareGatewaySlug}
                  onChange={(e) => onFieldChange('cloudflareGatewaySlug', e.target.value)}
                  placeholder="ej. kite-gateway (dejar vacío para Workers AI directo)"
                  title="Si se especifica, las solicitudes se enrutan por Cloudflare AI Gateway para cache y métricas"
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Base URL API
                </label>
                <input
                  type="text"
                  className="zed-settings__input"
                  value={config.cloudflareBaseUrl}
                  onChange={(e) => onFieldChange('cloudflareBaseUrl', e.target.value)}
                  placeholder="https://api.cloudflare.com/client/v4/accounts"
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <ModelSearchField
              label="Modelo de Cloudflare Workers AI"
              models={effectiveCloudflareModels}
              value={config.cloudflareModel}
              savedAt={cloudflareSavedAt}
              onSelect={(modelId) => {
                onPersistConfig({
                  ...config,
                  activeProvider: 'cloudflare',
                  cloudflareModel: modelId,
                });
              }}
            />
            <div>
              <label className="zed-settings__label" htmlFor="cloudflare-model-id" style={{ display: 'block', marginBottom: 5 }}>
                Id exacto
              </label>
              <input
                id="cloudflare-model-id"
                type="text"
                className="zed-settings__input"
                value={config.cloudflareModel}
                onChange={(e) => onFieldChange('cloudflareModel', e.target.value)}
                placeholder="@cf/meta/llama-3.1-8b-instruct-fp8"
                title="Pega un id que no esté en la lista"
                style={{ width: '100%' }}
              />
            </div>
          </>
        );

      case 'antigravity':
        return (
          <>
            <p className="zed-provider__note">
              Reutiliza tu sesión local del CLI de Antigravity sin costo de API adicional.
            </p>

            <div className="zed-provider__grid">
              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Modelo de Antigravity
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="zed-settings__input"
                    value={config.antigravityModel}
                    onChange={(e) => onFieldChange('antigravityModel', e.target.value)}
                    placeholder="gemini-3.8-flash"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={testingProvider !== null}
                    onClick={() => void onRunProbe('antigravity')}
                  >
                    {testingProvider === 'antigravity' ? 'Probando...' : 'Probar'}
                  </button>
                </div>
              </div>
            </div>
          </>
        );

      case 'grok':
        return (
          <>
            <p className="zed-provider__note">
              Con API Key se usa <strong>api.x.ai</strong> (clave desde{' '}
              <a href="https://console.x.ai" target="_blank" rel="noreferrer">
                console.x.ai
              </a>
              , formato <code>xai-…</code>). Sin clave, opcionalmente el CLI <code>grok</code> en
              PATH. Composer 2.5 Fast es de Cursor, no de la API pública de xAI.
            </p>

            <div className="zed-provider__grid">
              <div>
                <div className="settings-row settings-row--stacked">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">API Key de xAI</h3>
                  </div>
                  <div className="settings-row__control">
                    <div className="settings-credential">
                      <input
                        type={showApiKeys.grok ? 'text' : 'password'}
                        className="ui-field"
                        value={config.grokApiKey}
                        onChange={(e) => onFieldChange('grokApiKey', e.target.value)}
                        placeholder="xai-… (API Key de console.x.ai)"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="API Key de xAI"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => onToggleApiKey('grok')}
                        title={showApiKeys.grok ? 'Ocultar API Key' : 'Mostrar API Key'}
                      >
                        {showApiKeys.grok ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                </div>
                {config.grokApiKey ? (
                  <span style={{ fontSize: '11px', color: 'var(--text-success, #4ade80)', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                    Protegida en Bóveda Local SQLite
                  </span>
                ) : (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted, #94a3b8)', marginTop: '4px', display: 'block' }}>
                    Si no defines una clave aquí, Kite resolverá GROK_API_KEY desde .env o el CLI
                    grok en PATH.
                  </span>
                )}
              </div>

              <div>
                <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                  Modelo de Grok
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="zed-settings__input"
                    value={config.grokModel}
                    onChange={(e) => onFieldChange('grokModel', e.target.value)}
                    placeholder="grok-4.7"
                    title="Modelo chat xAI (p. ej. grok-4.7, grok-4.6)"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={testingProvider !== null}
                    onClick={() => void onRunProbe('grok')}
                  >
                    {testingProvider === 'grok' ? 'Probando...' : 'Probar'}
                  </button>
                </div>
              </div>
            </div>

            <label className="settings-row__hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={config.grokUseCliSubscription}
                disabled={Boolean(config.grokApiKey?.trim())}
                onChange={(e) => onFieldChange('grokUseCliSubscription', e.target.checked)}
              />
              Usar suscripción CLI local (solo si no hay API Key)
            </label>
          </>
        );

      case 'local':
      default:
        return (
          <p className="zed-provider__note">
            El proveedor local no usa red ni credenciales: responde de forma determinista para
            probar la interfaz y el flujo de chat sin costo.
          </p>
        );
    }
  };

  return (
    <section className="settings-group">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <h2 className="settings-group__title" style={{ margin: 0 }}>
          Canal y Pasarela de Proveedor IA
        </h2>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          Selecciona cómo responde el asistente esférico
        </span>
      </div>

      <div className="ui-card">
        <div className="ui-card__row zed-provider-switcher-row">
          <div className="zed-provider-switcher-copy">
            <h3 className="settings-row__title">Proveedor activo</h3>
            <p>
              Elige el proveedor que usa el asistente de Zed. Abajo se muestra solo la
              configuración del proveedor seleccionado.
            </p>
          </div>
          <fieldset aria-label="Proveedor IA" className="ui-segmented zed-provider-switcher">
            {PROVIDERS.map((provider) => {
              const isSelected = config.activeProvider === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={isSelected}
                  className="ui-segmented__item"
                  onClick={() => onFieldChange('activeProvider', provider.id)}
                >
                  {isSelected && <SegmentedIndicator group="settings-zed-provider" />}
                  <span>{provider.name}</span>
                </button>
              );
            })}
          </fieldset>
        </div>

        <div className="zed-provider__panel">{renderProviderBody(config.activeProvider)}</div>
      </div>

      {verifiedChatConnections.length > 0 ? (
        <div className="ui-card" style={{ marginTop: 4 }}>
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Conexiones de chat verificadas</h3>
              <p>
                Se leen del registro compartido. Un proveedor aparece aquí solo si uno de sus
                endpoints de chat fue verificado. El nombre del driver no alcanza.
              </p>
            </div>
          </div>
          {verifiedChatConnections.map((connection) => {
            const verifiedCount = connection.endpoints.filter(
              (endpoint) => endpoint.ok && isVerifiedChatEndpoint(endpoint.endpointId)
            ).length;
            return (
              <div key={connection.connectionId} className="ui-card__row settings-row">
                <div className="settings-row__copy">
                  <h3 className="settings-row__title">{connection.displayName}</h3>
                  <p>
                    {connection.driverKind} · {connection.authMethod}
                  </p>
                </div>
                <div className="settings-row__control">
                  <span className="settings-badge">Chat verified</span>
                  <span
                    style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 8 }}
                  >
                    {verifiedCount} endpoint{verifiedCount === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
