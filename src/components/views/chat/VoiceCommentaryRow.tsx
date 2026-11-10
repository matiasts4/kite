// Kite Code — Voice Commentary Row
// Live shimmer status row indicating the current operator execution stage in the thread timeline.

import React from 'react';
import { SpinnerIcon } from './ChatIcons';

export interface VoiceCommentaryRowProps {
  stage?: string;
  detail?: string;
  className?: string;
}

export const VoiceCommentaryRow: React.FC<VoiceCommentaryRowProps> = ({
  stage = 'planning',
  detail,
  className = '',
}) => {
  const getStageMessage = () => {
    if (detail) return detail;
    switch (stage) {
      case 'planning':
        return 'Pensando y planificando acciones…';
      case 'consulting':
        return 'Consultando chats y contexto anterior…';
      case 'executing':
        return 'Ejecutando acciones en el entorno…';
      case 'verifying':
        return 'Verificando recibos del sistema…';
      case 'speaking':
        return 'Sintetizando respuesta de voz…';
      default:
        return 'Procesando turno de voz…';
    }
  };

  return (
    <div
      data-testid="voice-commentary-row"
      className={`kite-voice-commentary flex items-center justify-center gap-2 py-2 text-xs text-[var(--vl-text-secondary)] select-none ${className}`}
    >
      <SpinnerIcon size={13} className="animate-spin text-[#339cff] shrink-0" />
      <span className="font-medium animate-pulse text-[var(--vl-text-primary)]">
        {getStageMessage()}
      </span>
    </div>
  );
};
