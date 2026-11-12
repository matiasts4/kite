import { useEffect, useState, type ReactNode } from 'react';

export type Direction = 1 | -1;

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(
    () => window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setCanHover(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return canHover;
}

export function useMenuAutoFocus(open: boolean) {
  const [autoFocus, setAutoFocus] = useState(false);
  useEffect(() => {
    if (!open) setAutoFocus(false);
  }, [open]);
  return [autoFocus, setAutoFocus] as const;
}

export function focusFirstIn(element: HTMLElement | null): void {
  element
    ?.querySelector<HTMLButtonElement>('button[role^="menuitem"], button[role="menuitem"]')
    ?.focus();
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

export function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export type NavGlyphKind = 'home' | 'chat' | 'folder' | 'sliders';

export function NavGlyph({ kind }: { kind: NavGlyphKind }) {
  if (kind === 'home') {
    return (
      <Glyph>
        <path d="M3 11 12 3l9 8" />
        <path d="M5 10v11h14V10" />
        <path d="M10 21v-6h4v6" />
      </Glyph>
    );
  }
  if (kind === 'chat') {
    return (
      <Glyph>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </Glyph>
    );
  }
  if (kind === 'folder') {
    return (
      <Glyph>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </Glyph>
    );
  }
  return (
    <Glyph>
      <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Glyph>
  );
}

export function SearchGlyph() {
  return (
    <Glyph>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Glyph>
  );
}

export function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.2" />
      <circle cx="7.5" cy="3" r="1.2" />
      <circle cx="2.5" cy="7" r="1.2" />
      <circle cx="7.5" cy="7" r="1.2" />
      <circle cx="2.5" cy="11" r="1.2" />
      <circle cx="7.5" cy="11" r="1.2" />
    </svg>
  );
}
