import React from 'react';
import {
  OperatorConfig,
  OperatorProviderId,
  OpenCodeModelOption,
} from '../../../../lib/operator/operatorConfig';
import { ModelSearchField } from './ModelSearchField';

export interface ZedProvidersSectionProps {
  config: OperatorConfig;
  onFieldChange: <K extends keyof OperatorConfig>(key: K, value: OperatorConfig[K]) => void;
  onPersistConfig: (next: OperatorConfig) => void;
  showApiKeys: Record<string, boolean>;
  onToggleApiKey: (provider: string) => void;
  testingProvider: OperatorProviderId | null;
  onRunProbe: (providerId: OperatorProviderId) => void;
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

export const ZedProvidersSection: React.FC<ZedProvidersSectionProps> = ({
  config,
  onFieldChange,
  onPersistConfig,
  showApiKeys,
  onToggleApiKey,
  testingProvider,
  onRunProbe,
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
        {/* Active Provider Selector */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Proveedor activo</h3>
            <p>
              Usa <strong>OpenCode</strong>, <strong>Vercel AI</strong> o <strong>Cloudflare AI</strong> para acceder a
              modelos rápidos y económicos (DeepSeek, Llama, Gemini, Jev, Claude), o tus
              suscripciones locales.
            </p>
          </div>
          <div className="settings-row__control">
            <fieldset aria-label="Proveedor IA" className="ui-segmented">
              {(
                [
                  { id: 'opencode', label: 'OpenCode Gateway' },
                  { id: 'vercel', label: 'Vercel AI' },
                  { id: 'cloudflare', label: 'Cloudflare AI' },
                  { id: 'antigravity', label: 'Antigravity' },
                  { id: 'grok', label: 'Grok' },
                  { id: 'local', label: 'Local (0ms)' },
                ] as { id: OperatorProviderId; label: string }[]
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={config.activeProvider === item.id}
                  className="ui-segmented__item"
                  onClick={() => onFieldChange('activeProvider', item.id)}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        {/* OpenCode Gateway Configuration */}
        <div
          className="ui-card__row"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: '16px 18px',
            background: 'transparent',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 className="settings-row__title" style={{ margin: 0 }}>
                  OpenCode Multi-Model Gateway
                </h3>
                <span className="settings-badge">Recomendado</span>
              </div>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                Conecta tu API Key de OpenCode como base y selecciona cualquier modelo rápido o
                gratuito (incluyendo DeepSeek vía OpenCode, sin requerir API directa de DeepSeek).
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
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
                {testingProvider === 'opencode' ? 'Probando...' : 'Test OpenCode'}
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            <div>
              <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                OpenCode API Key
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={showApiKeys.opencode ? 'text' : 'password'}
                  className="zed-settings__input"
                  value={config.opencodeApiKey}
                  onChange={(e) => onFieldChange('opencodeApiKey', e.target.value)}
                  placeholder="sk-opencode-..."
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onToggleApiKey('opencode')}
                  title={showApiKeys.opencode ? 'Ocultar API Key' : 'Mostrar API Key'}
                >
                  {showApiKeys.opencode ? 'Ocultar' : 'Ver'}
                </button>
              </div>
              {config.opencodeApiKey ? (
                <span style={{ fontSize: '11px', color: 'var(--text-success, #4ade80)', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                  Guardada en Bóveda Local SQLite
                </span>
              ) : (
                <span style={{ fontSize: '11px', color: 'var(--text-muted, #94a3b8)', marginTop: '4px', display: 'block' }}>
                  Opcional: si está vacía, se resolverá OPENCODE_API_KEY desde .env
                </span>
              )}
            </div>

            <div>
              <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                OpenCode Endpoint Base URL
              </label>
              <input
                type="text"
                className="zed-settings__input"
                value={config.opencodeBaseUrl}
                onChange={(e) => onFieldChange('opencodeBaseUrl', e.target.value)}
                placeholder="https://api.opencode.ai/v1"
                style={{ width: '100%' }}
              />
            </div>
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
        </div>

        {/* Card 2: Vercel AI Gateway */}
        <div
          className="ui-card__row"
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            background: 'transparent',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 className="settings-row__title" style={{ margin: 0 }}>
                  Vercel AI Gateway &amp; SDK
                </h3>
                <span
                  className="settings-badge"
                  style={{
                    background: 'rgba(0, 0, 0, 0.4)',
                    borderColor: 'rgba(255, 255, 255, 0.15)',
                  }}
                >
                  Vercel AI SDK
                </span>
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                Acceso unificado con streaming para DeepSeek, OpenAI, Anthropic y Google con capa gratuita y baja latencia.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 12,
            }}
          >
            <div>
              <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                Vercel AI Gateway API Key
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type={showApiKeys.vercel ? 'text' : 'password'}
                  className="zed-settings__input"
                  value={config.vercelApiKey}
                  onChange={(e) => onFieldChange('vercelApiKey', e.target.value)}
                  placeholder="vck_..."
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onToggleApiKey('vercel')}
                  title={showApiKeys.vercel ? 'Ocultar API Key' : 'Mostrar API Key'}
                >
                  {showApiKeys.vercel ? 'Ocultar' : 'Ver'}
                </button>
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
        </div>

        {/* Card 3: Cloudflare Workers AI & AI Gateway */}
        <div
          className="ui-card__row"
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            background: 'transparent',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 className="settings-row__title" style={{ margin: 0 }}>
                  Cloudflare Workers AI &amp; AI Gateway
                </h3>
                <span
                  className="settings-badge"
                  style={{
                    background: 'rgba(244, 129, 32, 0.15)',
                    borderColor: 'rgba(244, 129, 32, 0.4)',
                    color: '#fb923c',
                  }}
                >
                  Workers AI Edge
                </span>
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                Inferencia edge de bajísima latencia en más de 300 ubicaciones globales. 10,000 Neuronas gratis por día con modelos como Llama 3.1 8B, DeepSeek R1 y Qwen Coder.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 12,
            }}
          >
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
              <label className="zed-settings__label" style={{ display: 'block', marginBottom: 5 }}>
                Cloudflare API Token
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type={showApiKeys.cloudflare ? 'text' : 'password'}
                  className="zed-settings__input"
                  value={config.cloudflareApiToken}
                  onChange={(e) => onFieldChange('cloudflareApiToken', e.target.value)}
                  placeholder="Workers AI Token..."
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onToggleApiKey('cloudflare')}
                  title={showApiKeys.cloudflare ? 'Ocultar API Token' : 'Mostrar API Token'}
                >
                  {showApiKeys.cloudflare ? 'Ocultar' : 'Ver'}
                </button>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 12,
            }}
          >
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
        </div>

        {/* Subscription Providers: Antigravity & Grok */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Suscripción Antigravity (Gemini 3.8 Flash)</h3>
            <p>
              Reutiliza tu sesión local del CLI de Antigravity sin costo de API adicional.
            </p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="zed-settings__input"
              value={config.antigravityModel}
              onChange={(e) => onFieldChange('antigravityModel', e.target.value)}
              placeholder="gemini-3.8-flash"
              style={{ width: 170 }}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={testingProvider !== null}
              onClick={() => void onRunProbe('antigravity')}
            >
              {testingProvider === 'antigravity' ? 'Probando...' : 'Test'}
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Grok / xAI (API o CLI local)</h3>
            <p>
              Con API Key se usa <strong>api.x.ai</strong> (clave desde{' '}
              <a href="https://console.x.ai" target="_blank" rel="noreferrer">
                console.x.ai
              </a>
              , formato <code>xai-…</code>). Sin clave, opcionalmente el CLI <code>grok</code> en PATH.
              Composer 2.5 Fast es de Cursor, no de la API pública de xAI.
            </p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, flex: '1 1 200px', minWidth: 180 }}>
                <input
                  type={showApiKeys.grok ? 'text' : 'password'}
                  className="zed-settings__input"
                  value={config.grokApiKey}
                  onChange={(e) => onFieldChange('grokApiKey', e.target.value)}
                  placeholder="xai-… (API Key de console.x.ai)"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onToggleApiKey('grok')}
                  title={showApiKeys.grok ? 'Ocultar API Key' : 'Mostrar API Key'}
                >
                  {showApiKeys.grok ? 'Ocultar' : 'Ver'}
                </button>
              </div>
              <input
                type="text"
                className="zed-settings__input"
                value={config.grokModel}
                onChange={(e) => onFieldChange('grokModel', e.target.value)}
                placeholder="grok-4.7"
                title="Modelo chat xAI (p. ej. grok-4.7, grok-4.6)"
                style={{ width: 140 }}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={testingProvider !== null}
                onClick={() => void onRunProbe('grok')}
              >
                {testingProvider === 'grok' ? 'Probando...' : 'Test'}
              </button>
            </div>
            {config.grokApiKey ? (
              <span style={{ fontSize: '11px', color: 'var(--text-success, #4ade80)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                Protegida en Bóveda Local SQLite
              </span>
            ) : (
              <span style={{ fontSize: '11px', color: 'var(--text-muted, #94a3b8)' }}>
                Si no defines una clave aquí, Kite resolverá GROK_API_KEY desde .env o el CLI grok en PATH.
              </span>
            )}
            <label className="settings-row__hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={config.grokUseCliSubscription}
                disabled={Boolean(config.grokApiKey?.trim())}
                onChange={(e) => onFieldChange('grokUseCliSubscription', e.target.checked)}
              />
              Usar suscripción CLI local (solo si no hay API Key)
            </label>
          </div>
        </div>
      </div>
    </section>
  );
};
