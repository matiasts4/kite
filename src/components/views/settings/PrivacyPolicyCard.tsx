import React, { useState } from 'react';

export type LegalNoticeKind = 'privacy' | 'terms';

export const LegalNoticeModal: React.FC<{
  kind: LegalNoticeKind;
  onClose: () => void;
}> = ({ kind, onClose }) => (
  <div role="dialog" aria-modal="true" className="legal-notice" onClick={onClose}>
    <div className="legal-notice__panel" onClick={(event) => event.stopPropagation()}>
      <h3 className="legal-notice__title">
        {kind === 'privacy' ? 'Privacidad y Protección de Datos' : 'Términos de Kite'}
      </h3>
      <div className="legal-notice__body">
        {kind === 'privacy' ? (
          <p>
            Kite funciona bajo una arquitectura <strong>Local-First y Zero-Telemetry</strong>.
            Todas las sesiones de agentes, tokens de acceso y código son gestionados por el binario nativo en tu propio dispositivo.
            No existe intermediación en la nube para interceptar tus tareas ni recolectar datos de telemetría.
          </p>
        ) : (
          <p>
            Kite se proporciona para acelerar flujos de trabajo de ingeniería de software y automatización.
            La responsabilidad de ejecución de comandos en terminales y modificación de archivos recae en el usuario,
            con confirmación previa requerida para operaciones de riesgo.
          </p>
        )}
      </div>
      <div className="legal-notice__actions">
        <button type="button" className="settings-control ui-button ui-button--primary" onClick={onClose}>
          Entendido
        </button>
      </div>
    </div>
  </div>
);

/** Shared privacy and terms entry. Does not mount CLI session lists. */
export const PrivacyPolicyCard: React.FC = () => {
  const [legalModal, setLegalModal] = useState<LegalNoticeKind | null>(null);

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Políticas y Privacidad</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Compromiso de Privacidad Local</h3>
              <p className="settings-row__detail">
                Tus credenciales, tokens de IA, historial y código fuente se almacenan exclusivamente en este equipo.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Ver política de privacidad"
                className="settings-control ui-button"
                onClick={() => setLegalModal('privacy')}
                type="button"
              >
                Ver detalle
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Términos de Uso</h3>
              <p className="settings-row__detail">
                Uso de software autónomo y responsabilidades en entornos de desarrollo local.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Ver términos de uso"
                className="settings-control ui-button"
                onClick={() => setLegalModal('terms')}
                type="button"
              >
                Ver detalle
              </button>
            </div>
          </div>
        </div>
      </section>
      {legalModal ? <LegalNoticeModal kind={legalModal} onClose={() => setLegalModal(null)} /> : null}
    </>
  );
};
