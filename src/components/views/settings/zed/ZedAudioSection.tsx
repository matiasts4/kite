import React, { useState } from 'react';

const MIC_DEVICE_STORAGE_KEY = 'kite_selected_mic_device_id';

export const ZedAudioSection: React.FC = () => {
  const [deviceId] = useState(() => {
    try {
      return localStorage.getItem(MIC_DEVICE_STORAGE_KEY) || 'automatic';
    } catch {
      return 'automatic';
    }
  });

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Entrada de Audio y Micrófono del Asistente</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Micrófono del sistema</h3>
            <p>
              El micrófono se configura en Voice & Dictado. Dispositivo activo: {deviceId}.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
