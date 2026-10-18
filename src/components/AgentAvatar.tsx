import React, { useId } from 'react';

export type AvatarForm = 'squircle' | 'circle' | 'blob' | 'drop' | 'hex' | 'shield';
export type AvatarEyes = 'oval' | 'dot' | 'squint';

export interface AvatarChoice {
  form: AvatarForm;
  swatch: number;
  eyes: AvatarEyes;
}

const FORMS: AvatarForm[] = ['squircle', 'circle', 'blob', 'drop', 'hex', 'shield'];
const EYES: AvatarEyes[] = ['oval', 'dot', 'squint'];
const SWATCHES: string[] = [
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

const EYE_METRICS: Record<AvatarEyes, { width: number; height: number; spread: number }> = {
  oval: { width: 11.5, height: 22.5, spread: 25 },
  dot: { width: 16, height: 16, spread: 28.5 },
  squint: { width: 17, height: 7.5, spread: 31.5 },
};

const FORM_CENTERS: Record<AvatarForm, { x: number; y: number }> = {
  squircle: { x: 50, y: 50 },
  circle: { x: 50, y: 50 },
  hex: { x: 50, y: 50 },
  blob: { x: 48, y: 49 },
  drop: { x: 53, y: 57 },
  shield: { x: 50, y: 61 },
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

function getFormPath(form: AvatarForm): string {
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

function fnv1a(str: string): number {
  let hash = 2166136261;
  const s = (str || '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    hash = Math.imul(hash ^ (s.charCodeAt(i) & 255), 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function deriveAvatarChoice(id: string, choice?: AvatarChoice | string | null): AvatarChoice {
  if (choice) {
    if (typeof choice === 'string') {
      try {
        const parsed = JSON.parse(choice);
        if (parsed && typeof parsed === 'object') return deriveAvatarChoice(id, parsed);
      } catch {
        // Fallback to hashing the id if string is not JSON
      }
    } else if (typeof choice === 'object') {
      const swatch = Number.isFinite(choice.swatch)
        ? ((Math.trunc(choice.swatch) % SWATCHES.length) + SWATCHES.length) % SWATCHES.length
        : 0;
      return { ...choice, swatch };
    }
  }
  const h = fnv1a(id);
  const form = FORMS[((h % FORMS.length) + FORMS.length) % FORMS.length] ?? 'squircle';
  const swatch = Math.floor(h / 6) % SWATCHES.length;
  const eyes = EYES[((Math.floor(h / 72) % EYES.length) + EYES.length) % EYES.length] ?? 'oval';
  return { form, swatch, eyes };
}

interface AgentAvatarProps {
  id: string;
  choice?: AvatarChoice | string | null;
  size?: number;
  state?: 'idle' | 'running' | 'needsYou';
  label?: string;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  id,
  choice,
  size = 30,
  state = 'idle',
  label,
}) => {
  const rawId = useId();
  const maskId = `agent-avatar-mask-${rawId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const avatar = deriveAvatarChoice(id, choice);
  const color = SWATCHES[avatar.swatch] || SWATCHES[0];
  const eyes = EYE_METRICS[avatar.eyes] || EYE_METRICS.oval;
  const center = FORM_CENTERS[avatar.form] || FORM_CENTERS.squircle;
  const eyeHalfSpread = eyes.spread / 2;

  const dotRatio = 0.3;
  const marginRatio = 0.065;
  const dotSize = Math.max(7, size * dotRatio) * (100 / size);
  const margin = Math.max(1.5, size * marginRatio) * (100 / size);
  const dotCenter = 100 - dotSize / 2 + margin;
  const hasBadge = state !== 'idle';

  return (
    <svg
      aria-hidden={label === undefined}
      aria-label={label}
      className="agent-avatar"
      height={size}
      role={label === undefined ? 'presentation' : 'img'}
      viewBox="0 0 100 100"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <mask id={maskId}>
          <rect fill="white" height="100" width="100" x="0" y="0" />
          {hasBadge && (
            <circle cx={dotCenter} cy={dotCenter} fill="black" r={dotSize / 2 + margin} />
          )}
        </mask>
      </defs>

      <g mask={`url(#${maskId})`}>
        <path d={getFormPath(avatar.form)} fill={color} />
        {[-1, 1].map((side) => (
          <rect
            key={side}
            fill="rgba(0, 0, 0, 0.78)"
            height={eyes.height}
            rx={Math.min(eyes.width, eyes.height) / 2}
            width={eyes.width}
            x={center.x + side * eyeHalfSpread - eyes.width / 2}
            y={center.y - eyes.height / 2}
          />
        ))}
      </g>

      {hasBadge && (
        <circle
          cx={dotCenter}
          cy={dotCenter}
          fill={state === 'running' ? 'var(--status-running, #34d399)' : 'var(--warning, #f59e0b)'}
          r={dotSize / 2}
        />
      )}
    </svg>
  );
};

export default AgentAvatar;
