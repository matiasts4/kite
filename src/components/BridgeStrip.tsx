import React, { useEffect, useState, useRef } from 'react';
import { invokeCommand } from '../lib/ipc';

export interface BridgeStripAction {
  id: string;
  title: string;
  detail?: string;
  outcome?: 'running' | 'done' | 'failed';
}

export interface BridgeStripState {
  isActive: boolean;
  phase: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
  isMicrophoneMuted: boolean;
  transcript?: string;
  note?: string;
  actions: BridgeStripAction[];
}

export interface BridgeStripHostProps {
  state?: Partial<BridgeStripState>;
  onToggleMicrophoneMute?: () => void;
  onEndCall?: () => void;
}

// Clean inline SVGs (10px, strokeWidth 2.5) matching bundle
const MicIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const MicOffIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="2" x2="22" y1="2" y2="22" />
    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
    <path d="M5 10v2a7 7 0 0 0 12 5" />
    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const PhoneOffIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

export const BridgeStripHost: React.FC<BridgeStripHostProps> = ({
  state = {},
  onToggleMicrophoneMute,
  onEndCall,
}) => {
  const isActive = state.isActive ?? false;
  const isMuted = state.isMicrophoneMuted ?? false;
  const phase = state.phase ?? 'idle';
  const actions = state.actions ?? [];
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const note =
    liveNote ||
    state.note ||
    (phase === 'listening' ? 'Listening…' : phase === 'speaking' ? 'Kite speaking' : undefined);

  const refreshLiveVoice = () => {
    invokeCommand<{ detail?: string; status?: string }>('voice_live_session')
      .then((session) => {
        setLiveNote(
          session?.detail || 'Live voice is unavailable. No local engine is installed.'
        );
      })
      .catch(() => {
        setLiveNote('Live voice is unavailable. No local engine is installed.');
      });
  };

  useEffect(() => {
    if (!isActive) {
      setLiveNote(null);
      return;
    }
    refreshLiveVoice();
  }, [isActive]);

  const [position, setPosition] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.max(100, window.innerWidth - 120) : 1000,
    y: typeof window !== 'undefined' ? Math.max(80, window.innerHeight - 140) : 700,
  }));
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const dragStartRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: position.x,
      posY: position.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    const maxX = typeof window !== 'undefined' ? window.innerWidth - 80 : 1200;
    const maxY = typeof window !== 'undefined' ? window.innerHeight - 80 : 800;
    setPosition({
      x: Math.min(Math.max(40, dragStartRef.current.posX + dx), maxX),
      y: Math.min(Math.max(40, dragStartRef.current.posY + dy), maxY),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    const moved = start
      ? Math.hypot(e.clientX - start.startX, e.clientY - start.startY) > 4
      : false;
    setIsDragging(false);
    dragStartRef.current = null;
    if (!moved) refreshLiveVoice();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  if (!isActive) return null;

  return (
    <div
      className="bridge-float-host"
      data-dragging={isDragging ? 'true' : undefined}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999 }}
    >
      <section
        className="bridge-float bridge-float--live"
        data-below="true"
        data-phase={phase}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        style={{
          position: 'absolute',
          left: `${position.x - 36}px`,
          top: `${position.y - 36}px`,
          width: '72px',
          height: '72px',
          pointerEvents: 'none',
        }}
      >
        {/* Glowing Orb Canvas / Sphere */}
        <div
          className="bridge-float__orb"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background:
                phase === 'listening'
                  ? 'radial-gradient(circle, #67e0ff 0%, #2563eb 70%, #0b0f19 100%)'
                  : phase === 'speaking'
                  ? 'radial-gradient(circle, #a78bfa 0%, #7c3aed 70%, #0b0f19 100%)'
                  : 'radial-gradient(circle, #38bdf8 0%, #1e40af 70%, #0b0f19 100%)',
              boxShadow:
                phase === 'listening'
                  ? '0 0 24px rgba(103, 224, 255, 0.65)'
                  : phase === 'speaking'
                  ? '0 0 24px rgba(167, 139, 250, 0.65)'
                  : '0 0 16px rgba(56, 189, 248, 0.45)',
              transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          />
        </div>

        {/* Draggable Handle */}
        <div
          className="bridge-float__handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          title="Drag Kite Orb"
          style={{
            position: 'absolute',
            top: '12px',
            left: '12px',
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            cursor: isDragging ? 'grabbing' : 'grab',
            pointerEvents: 'auto',
          }}
        />

        {/* Mute badge overlay */}
        {isMuted && (
          <div
            className="bridge-float__mute-badge"
            style={{
              position: 'absolute',
              bottom: '4px',
              right: '4px',
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              backgroundColor: '#161922',
              border: '1px solid #ef4444',
              color: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MicOffIcon />
          </div>
        )}

        {/* Text and Actions Float Container */}
        <div
          className="bridge-float__words"
          style={{
            position: 'absolute',
            left: '50%',
            top: 'calc(100% + 8px)',
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '6px',
            pointerEvents: 'none',
          }}
        >
          {note && (
            <div
              className="bridge-float__note"
              style={{
                pointerEvents: 'auto',
                backgroundColor: 'rgba(20, 24, 33, 0.95)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '4px 10px',
                borderRadius: '999px',
                fontSize: '11px',
                color: '#f3f4f6',
                whiteSpace: 'nowrap',
              }}
            >
              {note}
            </div>
          )}

          {/* Action / Call Controls */}
          <span
            className="bridge-float__controls"
            data-shown={isHovering || isDragging ? 'true' : 'false'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              pointerEvents: 'auto',
              opacity: isHovering || isDragging ? 1 : 0.85,
              transition: 'opacity 0.2s ease',
            }}
          >
            <button
              type="button"
              className="bridge-float__control"
              data-muted={isMuted ? 'true' : undefined}
              onClick={onToggleMicrophoneMute}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                backgroundColor: isMuted ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.12)',
                color: isMuted ? '#ef4444' : '#f3f4f6',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {isMuted ? <MicOffIcon /> : <MicIcon />}
            </button>

            {actions.length > 0 && (
              <button
                type="button"
                className="bridge-float__tally"
                onClick={() => setShowReceipts((v) => !v)}
                style={{
                  height: '24px',
                  borderRadius: '999px',
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  color: '#9ca3af',
                  fontSize: '11px',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <span className="bridge-float__tally-count" style={{ color: '#f3f4f6', fontWeight: 600 }}>
                  {actions.length}
                </span>
                <span>actions</span>
              </button>
            )}

            <button
              type="button"
              className="bridge-float__control bridge-float__control--end"
              onClick={() => {
                invokeCommand('voice_live_close').finally(() => onEndCall?.());
              }}
              title="End call"
              aria-label="End call"
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                backgroundColor: 'rgba(239, 68, 68, 0.25)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <PhoneOffIcon />
            </button>
          </span>

          {/* Action Receipts Plate */}
          {showReceipts && actions.length > 0 && (
            <div
              className="bridge-float__receipt-plate bridge-float__receipt-plate--below"
              style={{
                pointerEvents: 'auto',
                backgroundColor: 'rgba(17, 21, 30, 0.98)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '8px',
                padding: '8px 10px',
                maxWidth: '260px',
                width: 'max-content',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
              }}
            >
              <div className="bridge-receipt-list">
                <span className="bridge-receipt-list__title">Recent Operations</span>
                {actions.map((act) => (
                  <div key={act.id} className="bridge-chip" data-outcome={act.outcome || 'running'}>
                    <span className="bridge-chip__title">{act.title}</span>
                    {act.detail && <span className="bridge-chip__detail">{act.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export const BridgeStrip = BridgeStripHost;
export default BridgeStripHost;
