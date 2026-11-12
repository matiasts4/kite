import React from 'react';

// Encode modified Enter / Escape under ConPTY win32-input-mode (?9001h)
export function encodeWin32SpecialKey(
  key: 'Enter' | 'Escape',
  shift: boolean,
  alt: boolean,
  ctrl: boolean
): string {
  const held = (shift ? 0x10 : 0) | (alt ? 0x02 : 0) | (ctrl ? 0x08 : 0);
  if (key === 'Enter') {
    const typed = ctrl && !alt ? 10 : 13;
    return `\x1b[13;28;${typed};1;${held};1_\x1b[13;28;${typed};0;${held};1_`;
  }
  return `\x1b[27;1;27;1;${held};1_\x1b[27;1;27;0;${held};1_`;
}

export function normalizePasteText(text: string, bracketedPaste: boolean): string {
  if (!text) return '';
  const clean = text.replace(/\x1b\[20[01]~/g, '');
  const isMultiline = clean.includes('\n') || clean.includes('\r');
  if (bracketedPaste || isMultiline) {
    const normalized = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return clean;
}

export interface EncodeVtKeyContext {
  kittyFlags: number;
  win32Mode: boolean;
  applicationCursor: boolean;
  alternateScreen: boolean;
  gridRows: number;
  onScrollPageUp?: () => void;
  onScrollPageDown?: () => void;
}

export function encodeVtKey(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  ctx: EncodeVtKeyContext
): string | null {
  const hasMod = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;
  const modParam =
    1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + ((e.ctrlKey || e.metaKey) ? 4 : 0);
  const { kittyFlags, win32Mode, applicationCursor, alternateScreen, onScrollPageUp, onScrollPageDown } = ctx;

  // Modified Enter / Escape under Kitty Keyboard Protocol or Win32 Input Mode (?9001h)
  if (e.key === 'Enter' && hasMod) {
    if (kittyFlags > 0) {
      return `\x1b[13;${modParam}u`;
    } else if (win32Mode) {
      return encodeWin32SpecialKey('Enter', e.shiftKey, e.altKey, e.ctrlKey);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      return '\x1b\r';
    } else {
      return '\n';
    }
  }

  if (e.key === 'Escape' && hasMod) {
    if (kittyFlags > 0) {
      return `\x1b[27;${modParam}u`;
    } else if (win32Mode) {
      return encodeWin32SpecialKey('Escape', e.shiftKey, e.altKey, e.ctrlKey);
    } else {
      return '\x1b';
    }
  }

  // Shift + Tab -> Backtab (\x1b[Z) or CSI-u
  if (e.key === 'Tab' && e.shiftKey) {
    return '\x1b[Z';
  }

  // Ctrl + Backspace -> delete word backward (\x17) or CSI-u
  if (e.key === 'Backspace' && (e.ctrlKey || e.altKey)) {
    if (kittyFlags > 0) {
      return `\x1b[127;${modParam}u`;
    } else if (e.altKey && !e.ctrlKey) {
      return '\x1b\x7f';
    } else {
      return '\x17';
    }
  }

  // Standard Ctrl + a..z control codes (or Kitty CSI-u when kittyFlags > 0)
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    const lower = e.key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') {
      if (kittyFlags > 0 && e.shiftKey) {
        return `\x1b[${lower.charCodeAt(0)};${modParam}u`;
      } else {
        const asciiCode = lower.charCodeAt(0) - 96;
        return String.fromCharCode(asciiCode);
      }
    }
  }

  const arrowLetter: Record<string, string> = {
    ArrowUp: 'A',
    ArrowDown: 'B',
    ArrowRight: 'C',
    ArrowLeft: 'D',
  };

  if (arrowLetter[e.key]) {
    const dir = arrowLetter[e.key];
    if (modParam > 1) {
      return `\x1b[1;${modParam}${dir}`;
    } else if (applicationCursor) {
      return `\x1bO${dir}`;
    } else {
      return `\x1b[${dir}`;
    }
  }

  // Special navigation and control keys
  switch (e.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return kittyFlags > 0 ? '\x1b[27u' : '\x1b';
    case 'Home':
      return modParam > 1
        ? `\x1b[1;${modParam}H`
        : applicationCursor
          ? '\x1bOH'
          : '\x1b[H';
    case 'End':
      return modParam > 1
        ? `\x1b[1;${modParam}F`
        : applicationCursor
          ? '\x1bOF'
          : '\x1b[F';
    case 'Insert':
      return modParam > 1 ? `\x1b[2;${modParam}~` : '\x1b[2~';
    case 'Delete':
      return modParam > 1 ? `\x1b[3;${modParam}~` : '\x1b[3~';
    case 'PageUp':
      if (e.shiftKey && !alternateScreen) {
        onScrollPageUp?.();
        return null;
      }
      return modParam > 1 ? `\x1b[5;${modParam}~` : '\x1b[5~';
    case 'PageDown':
      if (e.shiftKey && !alternateScreen) {
        onScrollPageDown?.();
        return null;
      }
      return modParam > 1 ? `\x1b[6;${modParam}~` : '\x1b[6~';
    case 'F1':
      return modParam > 1 ? `\x1b[1;${modParam}P` : '\x1bOP';
    case 'F2':
      return modParam > 1 ? `\x1b[1;${modParam}Q` : '\x1bOQ';
    case 'F3':
      return modParam > 1 ? `\x1b[1;${modParam}R` : '\x1bOR';
    case 'F4':
      return modParam > 1 ? `\x1b[1;${modParam}S` : '\x1bOS';
    case 'F5':
      return modParam > 1 ? `\x1b[15;${modParam}~` : '\x1b[15~';
    case 'F6':
      return modParam > 1 ? `\x1b[17;${modParam}~` : '\x1b[17~';
    case 'F7':
      return modParam > 1 ? `\x1b[18;${modParam}~` : '\x1b[18~';
    case 'F8':
      return modParam > 1 ? `\x1b[19;${modParam}~` : '\x1b[19~';
    case 'F9':
      return modParam > 1 ? `\x1b[20;${modParam}~` : '\x1b[20~';
    case 'F10':
      return modParam > 1 ? `\x1b[21;${modParam}~` : '\x1b[21~';
    case 'F11':
      return modParam > 1 ? `\x1b[23;${modParam}~` : '\x1b[23~';
    case 'F12':
      return modParam > 1 ? `\x1b[24;${modParam}~` : '\x1b[24~';
    default:
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        return `\x1b${e.key}`;
      }
      return null;
  }
}
