import React, { useState, useMemo } from 'react';
import {
  AgentAvatar,
  deriveAvatarChoice,
  AvatarChoice,
  AvatarForm,
  AvatarEyes,
} from '../../AgentAvatar';

// SVG Icons (Zero Lucide & Zero emojis)
const DicesIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect width="12" height="12" x="2" y="10" rx="2" ry="2" />
    <path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" />
    <path d="M6 18h.01" />
    <path d="M10 14h.01" />
    <path d="M15 6h.01" />
    <path d="M18 9h.01" />
  </svg>
);

const RotateCcwIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

// Avatar Geometry & Palettes
export const FORMS: AvatarForm[] = ['squircle', 'circle', 'blob', 'drop', 'hex', 'shield'];
export const EYES: AvatarEyes[] = ['oval', 'dot', 'squint'];
export const SWATCHES: string[] = [
  '#FF6B5C',
  '#F59E0B',
  '#C08457',
  '#34D399',
  '#2DD4BF',
  '#38BDF8',
  '#818CF8',
  '#A78BFA',
  '#E879C7',
  '#FB7185',
  '#F97316',
  '#94A3B8',
];

export const FORM_NAMES: Record<AvatarForm, string> = {
  squircle: 'Square',
  circle: 'Round',
  blob: 'Blob',
  drop: 'Drop',
  hex: 'Hex',
  shield: 'Shield',
};

export const EYE_NAMES: Record<AvatarEyes, string> = {
  oval: 'Oval',
  dot: 'Dot',
  squint: 'Squint',
};

function roundedPolygon(points: [number, number][], radius: number): string {
  const n = points.length;
  const project = (p1: [number, number], p2: [number, number]): [number, number] => {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return p1;
    const factor = Math.min(radius, dist / 2) / dist;
    return [p1[0] + dx * factor, p1[1] + dy * factor];
  };

  let d = '';
  for (let i = 0; i < n; i++) {
    const cur = points[i];
    const prev = points[(i + n - 1) % n];
    const next = points[(i + 1) % n];
    const pPrev = project(cur, prev);
    const pNext = project(cur, next);
    d += i === 0 ? `M ${pPrev[0]} ${pPrev[1]}` : ` L ${pPrev[0]} ${pPrev[1]}`;
    d += ` Q ${cur[0]} ${cur[1]} ${pNext[0]} ${pNext[1]}`;
  }
  return `${d} Z`;
}

export function getFormPath(form: AvatarForm): string {
  switch (form) {
    case 'squircle':
      return roundedPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], 30);
    case 'circle':
      return 'M 50 0 A 50 50 0 1 1 49.99 0 Z';
    case 'blob':
      return [
        'M 50 2',
        'C 78 2 98 14 98 38',
        'C 98 60 100 75 86 87',
        'C 68 100 33 102 15 93',
        'C -1 87 0 62 2 42',
        'C 4 20 24 2 50 2',
        'Z',
      ].join(' ');
    case 'drop':
      return [
        'M 6 6',
        'C 62 2 98 20 98 55',
        'C 98 80 80 98 55 98',
        'C 20 98 2 62 6 6',
        'Z',
      ].join(' ');
    case 'hex':
      return roundedPolygon([[26, 4], [74, 4], [99, 50], [74, 96], [26, 96], [1, 50]], 9);
    case 'shield':
      return roundedPolygon([[50, 1], [99, 95], [1, 95]], 24);
    default:
      return roundedPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], 30);
  }
}

export interface AgentAvatarCustomizerProps {
  effectiveId: string;
  customAvatar: AvatarChoice | null;
  saving?: boolean;
  onUpdateAvatar: (choice: AvatarChoice) => void;
  onResetAvatar: () => void;
}

export const AgentAvatarCustomizer: React.FC<AgentAvatarCustomizerProps> = ({
  effectiveId,
  customAvatar,
  saving = false,
  onUpdateAvatar,
  onResetAvatar,
}) => {
  const [isCustomizingAvatar, setIsCustomizingAvatar] = useState<boolean>(false);

  const derivedAvatar = useMemo(
    () => deriveAvatarChoice(effectiveId, customAvatar),
    [effectiveId, customAvatar]
  );

  const handleShuffleAvatar = () => {
    const current = derivedAvatar;
    let nextForm = FORMS[Math.floor(Math.random() * FORMS.length)];
    let nextSwatch = Math.floor(Math.random() * SWATCHES.length);
    let nextEyes = EYES[Math.floor(Math.random() * EYES.length)];

    while (nextForm === current.form && nextSwatch === current.swatch && nextEyes === current.eyes) {
      nextForm = FORMS[Math.floor(Math.random() * FORMS.length)];
      nextSwatch = Math.floor(Math.random() * SWATCHES.length);
      nextEyes = EYES[Math.floor(Math.random() * EYES.length)];
    }
    onUpdateAvatar({ form: nextForm, swatch: nextSwatch, eyes: nextEyes });
  };

  return (
    <fieldset className="form-field agent-face-picker agent-setting-group">
      <legend className="agent-setting-label">Face</legend>
      <div className="agent-face-picker__summary">
        <AgentAvatar id={effectiveId} choice={customAvatar} size={44} />
        <div className="agent-face-picker__copy">
          <strong>{customAvatar === null ? 'Generated' : FORM_NAMES[derivedAvatar.form]}</strong>
          <small>
            {customAvatar === null
              ? "Made from this agent's id — it never changes on its own."
              : 'Yours. Reset to go back to the generated one.'}
          </small>
        </div>
        <button
          type="button"
          className="secondary-button action-button--row"
          aria-expanded={isCustomizingAvatar}
          onClick={() => setIsCustomizingAvatar((prev) => !prev)}
          disabled={saving}
        >
          {isCustomizingAvatar ? 'Done' : 'Customize'}
        </button>
      </div>

      {isCustomizingAvatar && (
        <div className="agent-face-picker__controls">
          {/* Shape / Geometry */}
          <div className="agent-face-picker__row">
            <span className="agent-face-picker__row-label">Shape</span>
            <div className="agent-face-picker__options">
              {FORMS.map((form) => {
                const isSelected = derivedAvatar.form === form;
                return (
                  <button
                    key={form}
                    type="button"
                    aria-label={FORM_NAMES[form]}
                    aria-pressed={isSelected}
                    className={`agent-face-option ${isSelected ? 'agent-face-option--selected' : ''}`}
                    onClick={() => onUpdateAvatar({ ...derivedAvatar, form })}
                    title={FORM_NAMES[form]}
                    disabled={saving}
                  >
                    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 100 100">
                      <path
                        d={getFormPath(form)}
                        fill={SWATCHES[derivedAvatar.swatch] || SWATCHES[0]}
                      />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Colour Swatch */}
          <div className="agent-face-picker__row">
            <span className="agent-face-picker__row-label">Colour</span>
            <div className="agent-face-picker__options agent-face-picker__options--wrap">
              {SWATCHES.map((color, idx) => {
                const isSelected = derivedAvatar.swatch === idx;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Colour ${idx + 1}`}
                    aria-pressed={isSelected}
                    className={`agent-face-option ${isSelected ? 'agent-face-option--selected' : ''}`}
                    onClick={() => onUpdateAvatar({ ...derivedAvatar, swatch: idx })}
                    disabled={saving}
                  >
                    <span className="agent-face-option__swatch" style={{ background: color }} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Eyes Style */}
          <div className="agent-face-picker__row">
            <span className="agent-face-picker__row-label">Eyes</span>
            <div className="agent-face-picker__options">
              {EYES.map((eye) => {
                const isSelected = derivedAvatar.eyes === eye;
                return (
                  <button
                    key={eye}
                    type="button"
                    aria-pressed={isSelected}
                    className={`agent-face-option agent-face-option--wide ${
                      isSelected ? 'agent-face-option--selected' : ''
                    }`}
                    onClick={() => onUpdateAvatar({ ...derivedAvatar, eyes: eye })}
                    disabled={saving}
                  >
                    {EYE_NAMES[eye]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Actions: Shuffle & Reset */}
          <div className="agent-face-picker__actions">
            <button
              type="button"
              className="secondary-button action-button--row"
              onClick={handleShuffleAvatar}
              disabled={saving}
              title="A different face at random"
            >
              <span aria-hidden="true" className="action-button__icon">
                <DicesIcon size={14} />
              </span>
              Shuffle
            </button>
            <button
              type="button"
              className="secondary-button action-button--row"
              disabled={saving || customAvatar === null}
              onClick={onResetAvatar}
              title="Go back to the face generated from this agent's id"
            >
              <span aria-hidden="true" className="action-button__icon">
                <RotateCcwIcon size={14} />
              </span>
              Reset
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
};
