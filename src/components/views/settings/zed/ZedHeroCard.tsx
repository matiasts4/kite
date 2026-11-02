import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ZedOrb } from '../../../ZedOrb';
import {
  ZedPersonaConfig,
  OperatorConfig,
  OperatorProviderId,
} from '../../../../lib/operator/operatorConfig';
import { tweens } from '../../../../motion/standard/tokens';

export interface ZedHeroCardProps {
  persona: ZedPersonaConfig;
  config: OperatorConfig;
  savedToast: boolean;
  testingProvider: OperatorProviderId | null;
  onRunProbe: (providerId: OperatorProviderId) => void;
}

export const ZedHeroCard: React.FC<ZedHeroCardProps> = ({
  persona,
  config,
  savedToast,
  testingProvider,
  onRunProbe,
}) => {
  return (
    <section className="settings-group">
      <div
        className="ui-card"
        style={{
          padding: '18px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ flexShrink: 0 }}>
            <ZedOrb
              size={64}
              state={testingProvider ? 'thinking' : 'listening'}
              level={testingProvider ? 0.55 : 0.18}
            />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                {persona.name || 'Zed'} — Operador y Asistente de IA
              </h2>
              <span className="settings-badge">
                {config.activeProvider === 'opencode'
                  ? `OpenCode · ${config.opencodeModel || 'deepseek-4.1-flash'}`
                  : config.activeProvider === 'vercel'
                  ? `Vercel AI · ${config.vercelModel || 'deepseek/deepseek-chat'}`
                  : config.activeProvider === 'cloudflare'
                  ? `Cloudflare · ${config.cloudflareModel || '@cf/meta/llama-3.1-8b-instruct-fp8'}`
                  : config.activeProvider.toUpperCase()}
              </span>
              <AnimatePresence>
                {savedToast && (
                  <motion.span
                    className="settings-badge"
                    initial={{ opacity: 0, y: -3, filter: 'blur(2px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -2, filter: 'blur(2px)' }}
                    transition={tweens.swap}
                    style={{
                      color: '#34d399',
                      borderColor: 'rgba(52, 211, 153, 0.35)',
                      background: 'rgba(16, 185, 129, 0.12)',
                    }}
                  >
                    Guardado
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                lineHeight: 1.45,
              }}
            >
              Orbe esférico superior para ejecutar acciones rápidas (abrir/cerrar terminales,
              inyectar planes a subagentes, navegar vistas y leer resúmenes por voz).
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            className="secondary-button"
            disabled={testingProvider !== null}
            onClick={() => void onRunProbe(config.activeProvider)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {testingProvider ? (
              <svg
                className="animate-spin"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            )}
            {testingProvider ? 'Midiendo...' : 'Probar latencia'}
          </button>
        </div>
      </div>
    </section>
  );
};
