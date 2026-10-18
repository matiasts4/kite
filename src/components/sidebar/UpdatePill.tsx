import React from 'react';
import { useAppUpdater, checkSilently } from '../../hooks/useAppUpdater';

// ============================================================================
// Clean SVG Icons
// ============================================================================

const UpdateArrowIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </svg>
);

const RestartIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const CheckIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const CloseIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const SpinnerIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    style={{ animation: 'update-spin 1s linear infinite' }}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" />
    <path d="M12 3a9 9 0 0 1 9 9" />
  </svg>
);

const AlertIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    aria-hidden="true"
    className={className}
    height={size}
    width={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

// ============================================================================
// Circular Update Button (Cursor-Style)
// ============================================================================

export interface UpdateCircularButtonProps {
  onToggleDetails?: () => void;
  isDetailsOpen?: boolean;
}

/**
 * Circular update button rendered in the bottom row alongside Theme and Settings.
 * Styled after Cursor IDE's circular indicator:
 * - 26px x 26px circle
 * - Breathing pulse dot indicator
 * - Animated circular progress ring when downloading
 * - Green checkmark / restart icon when update is ready
 * - Red warning indicator on update error with retry
 */
export const UpdateCircularButton: React.FC<UpdateCircularButtonProps> = ({
  onToggleDetails,
  isDetailsOpen = false,
}) => {
  const { state, restart } = useAppUpdater();

  if (
    state.status === 'idle' ||
    state.status === 'checking' ||
    state.status === 'uptodate'
  ) {
    return null;
  }

  const isError = state.status === 'error';
  const isReady = state.status === 'ready';
  const isDownloading = state.status === 'downloading';
  const version = state.status === 'available' || state.status === 'ready' ? state.version : '';

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isError) {
      checkSilently();
    }
    if (isReady && !isDetailsOpen) {
      restart();
      return;
    }
    if (onToggleDetails) {
      onToggleDetails();
    }
  };

  const title = isError
    ? `Error al actualizar: ${state.error.message || 'Error'} · Clic para reintentar`
    : isReady
    ? `Actualización ${version ? `v${version} ` : ''}lista · Clic para reiniciar Kite`
    : isDownloading
    ? `Descargando actualización${state.percent !== null ? `: ${state.percent}%` : '…'}`
    : `Actualización v${version} disponible · Clic para ver detalles o actualizar`;

  // SVG Progress Ring calculations for downloading
  const radius = 9;
  const circumference = 2 * Math.PI * radius; // ~56.55
  const strokeDashoffset =
    isDownloading && state.percent !== null
      ? circumference * (1 - state.percent / 100)
      : circumference * 0.7;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={title}
      title={title}
      className={`update-circular-btn${isReady ? ' update-circular-btn--ready' : ''}${isError ? ' update-circular-btn--error' : ''}`}
      data-testid="update-circular-button"
      style={isError ? { borderColor: 'rgba(239, 68, 68, 0.45)', background: 'rgba(239, 68, 68, 0.12)' } : undefined}
    >
      {/* Pulse notification badge */}
      <span
        className="update-circular-btn__dot"
        aria-hidden="true"
        style={isError ? { background: '#ef4444', boxShadow: '0 0 6px #ef4444' } : undefined}
      />

      {/* Downloading circular progress ring */}
      {isDownloading && (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            margin: 'auto',
            transform: 'rotate(-90deg)',
            pointerEvents: 'none',
          }}
        >
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="rgba(92, 143, 255, 0.2)"
            strokeWidth="2.2"
          />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="var(--accent, #5c8fff)"
            strokeWidth="2.2"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{
              transition: 'stroke-dashoffset 0.3s ease',
              animation: state.percent === null ? 'update-spin 1.2s linear infinite' : undefined,
              transformOrigin: 'center',
            }}
          />
        </svg>
      )}

      {/* Button Icon */}
      {isError ? (
        <span style={{ color: '#ef4444', display: 'inline-flex' }}>
          <AlertIcon size={12} />
        </span>
      ) : isReady ? (
        <CheckIcon size={12} />
      ) : isDownloading ? (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--accent, #5c8fff)',
          }}
        >
          {state.percent !== null ? `${state.percent}` : '…'}
        </span>
      ) : (
        <UpdateArrowIcon size={12} />
      )}
    </button>
  );
};

// ============================================================================
// Detailed, Subtle Update Card (Floating above rule)
// ============================================================================

export interface UpdateDetailCardProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Detailed, subtle card displayed above the sidebar footer rule.
 * Smoothly rounded (border-radius: 14px), subtle glassmorphism, rich release details.
 */
export const UpdateDetailCard: React.FC<UpdateDetailCardProps> = ({ isOpen, onClose }) => {
  const { state, updateAndRestart, restart } = useAppUpdater();

  React.useEffect(() => {
    if (isOpen && state.status !== 'error') {
      checkSilently();
    }
  }, [isOpen, state.status]);

  if (
    !isOpen ||
    state.status === 'idle' ||
    state.status === 'checking' ||
    state.status === 'uptodate'
  ) {
    return null;
  }

  const isError = state.status === 'error';
  const isReady = state.status === 'ready';
  const isDownloading = state.status === 'downloading';
  const version = state.status === 'available' || state.status === 'ready' ? state.version : '';
  const notes = state.status === 'available' ? state.notes : null;

  return (
    <div className="update-detail-card" data-testid="update-detail-card">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: isError
                ? 'rgba(239, 68, 68, 0.2)'
                : isReady
                ? 'rgba(52, 199, 89, 0.2)'
                : 'rgba(92, 143, 255, 0.2)',
              color: isError ? '#ef4444' : isReady ? '#34c759' : 'var(--accent, #5c8fff)',
              flex: 'none',
            }}
          >
            {isError ? <AlertIcon size={10} /> : isReady ? <CheckIcon size={10} /> : <UpdateArrowIcon size={10} />}
          </span>
          <span
            style={{
              fontWeight: 600,
              fontSize: 11,
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {isError
              ? 'Aviso de actualización'
              : isReady
              ? 'Actualización lista'
              : isDownloading
              ? 'Descargando'
              : 'Nueva versión'}
          </span>
          {version ? (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 6px',
                borderRadius: 9999,
                background: 'rgba(92, 143, 255, 0.15)',
                color: 'var(--accent, #5c8fff)',
                border: '1px solid rgba(92, 143, 255, 0.25)',
                flex: 'none',
              }}
            >
              v{version}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel de actualización"
          title="Minimizar (el botón circular permanecerá visible)"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary, #888)',
            cursor: 'pointer',
            padding: '2px 4px',
            borderRadius: 4,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.12s ease',
            flex: 'none',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary, #fff)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary, #888)')}
        >
          <CloseIcon size={11} />
        </button>
      </div>

      {/* Description / Progress */}
      <div
        style={{
          color: isError ? '#fca5a5' : 'var(--text-secondary, #a1a1aa)',
          fontSize: 10.5,
          lineHeight: 1.35,
        }}
      >
        {isError
          ? `${state.error.message || 'No se pudo completar la instalación.'} Puedes reintentar.`
          : isReady
          ? 'La actualización ha sido verificada. Reinicia Kite para aplicar los cambios.'
          : isDownloading
          ? state.percent !== null
            ? `${state.percent}% descargado. Aplicando en segundo plano…`
            : 'Descargando e instalando componentes…'
          : 'Hay una nueva versión disponible con mejoras y optimizaciones.'}
      </div>

      {/* Progress Bar */}
      {isDownloading && (
        <div
          style={{
            width: '100%',
            height: 4,
            borderRadius: 9999,
            background: 'rgba(255, 255, 255, 0.08)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${state.percent ?? 30}%`,
              height: '100%',
              borderRadius: 9999,
              background: 'linear-gradient(90deg, var(--accent, #5c8fff), #8ec5fc)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      )}

      {/* Release Notes (if present) */}
      {notes && !isDownloading && (
        <div
          style={{
            maxHeight: 65,
            overflowY: 'auto',
            padding: '5px 7px',
            borderRadius: 8,
            background: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            fontSize: 10,
            lineHeight: 1.4,
            color: 'var(--text-secondary, #a1a1aa)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {notes}
        </div>
      )}

      {/* Action Button */}
      <button
        type="button"
        onClick={isReady ? restart : updateAndRestart}
        disabled={isDownloading}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 9999,
          fontSize: 11,
          fontWeight: 600,
          border: 'none',
          cursor: isDownloading ? 'default' : 'pointer',
          background: isError
            ? 'linear-gradient(135deg, #ef4444, #dc2626)'
            : isReady
            ? 'linear-gradient(135deg, #34c759, #28a745)'
            : 'linear-gradient(135deg, var(--accent, #5c8fff), #4b7bef)',
          color: '#ffffff',
          boxShadow: isError
            ? '0 2px 8px rgba(239, 68, 68, 0.35)'
            : isReady
            ? '0 2px 8px rgba(52, 199, 89, 0.35)'
            : '0 2px 8px rgba(92, 143, 255, 0.35)',
          transition: 'all 0.15s ease',
          opacity: isDownloading ? 0.75 : 1,
        }}
        onMouseEnter={(e) => {
          if (!isDownloading) e.currentTarget.style.filter = 'brightness(1.1)';
        }}
        onMouseLeave={(e) => {
          if (!isDownloading) e.currentTarget.style.filter = 'brightness(1.0)';
        }}
      >
        {isError ? (
          <>
            <UpdateArrowIcon size={12} />
            <span>Reintentar actualización</span>
          </>
        ) : isReady ? (
          <>
            <RestartIcon size={12} />
            <span>Reiniciar para aplicar</span>
          </>
        ) : isDownloading ? (
          <>
            <SpinnerIcon size={12} />
            <span>Descargando…</span>
          </>
        ) : (
          <>
            <UpdateArrowIcon size={12} />
            <span>Actualizar y reiniciar</span>
          </>
        )}
      </button>
    </div>
  );
};

// ============================================================================
// Backward-compatible Standalone Wrapper Component
// ============================================================================

export const UpdatePill: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(true);
  return <UpdateDetailCard isOpen={isOpen} onClose={() => setIsOpen(false)} />;
};
