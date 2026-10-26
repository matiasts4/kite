import type { AnySpring, Bezier, TweenToken } from '../../tokens';

export type Modality = 'pointer' | 'keyboard';

const EASE_NAMES: Array<{ key: string; name: string }> = [
  { key: '0.23,1,0.32,1', name: 'ease.out' },
  { key: '0.215,0.61,0.355,1', name: 'ease.soft' },
  { key: '0.33,0.17,0.67,0.5', name: 'ease.away' },
  { key: '0.25,0.1,0.25,1', name: 'ease.color' },
  { key: '0,0,0.58,1', name: 'ease.leave' },
  { key: '0.25,0.1,0.35,1', name: 'ease.enter' },
];

export function easeName(ease?: Bezier): string {
  if (!ease) return '—';
  return EASE_NAMES.find((item) => item.key === ease.join(','))?.name ?? 'custom';
}

export function formatSpring(token: AnySpring): string {
  if ('visualDuration' in token) {
    return `visualDuration ${token.visualDuration.toFixed(2)}s · bounce ${token.bounce.toFixed(2)}`;
  }
  const rest = token.restSpeed !== undefined ? ` · rest ${token.restSpeed}` : '';
  return `k ${Math.round(token.stiffness)} · d ${Math.round(token.damping)}${rest}`;
}

export function springOptions(token: AnySpring): {
  stiffness?: number;
  damping?: number;
  visualDuration?: number;
  bounce?: number;
} {
  if ('visualDuration' in token) {
    return { visualDuration: token.visualDuration, bounce: token.bounce };
  }
  return { stiffness: token.stiffness, damping: token.damping };
}

export function formatTween(token: TweenToken): string {
  if (token.duration === 0) return '0 ms · —';
  const delay = token.delay !== undefined ? ` · +${Math.round(token.delay * 1000)} ms` : '';
  return `${Math.round(token.duration * 1000)} ms · ${easeName(token.ease)}${delay}`;
}

export function curvePath([x1, y1, x2, y2]: Bezier): string {
  return `M0,100 C${x1 * 100},${100 - y1 * 100} ${x2 * 100},${100 - y2 * 100} 100,0`;
}

export function maxBlurPx(blurs: Record<string, string>): number {
  return Math.max(...Object.values(blurs).map((value) => Number.parseFloat(value.replace('blur(', ''))));
}

export interface CheckItem {
  label: string;
  detail: string;
  status: 'pass' | 'fail';
}

export function Checklist({ title, items }: { title: string; items: CheckItem[] }) {
  return (
    <div className="p9-checks-wrap">
      <h3 className="p9-subhead">{title}</h3>
      <ul className="p9-checks">
        {items.map((item) => (
          <li key={item.label} className={`p9-check p9-check--${item.status}`}>
            <span className="p9-check__mark" aria-hidden="true">
              {item.status === 'pass' ? '✓' : '✕'}
            </span>
            <div className="p9-check__body">
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </div>
            <span className="p9-check__status">{item.status === 'pass' ? 'pasa' : 'falla'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
