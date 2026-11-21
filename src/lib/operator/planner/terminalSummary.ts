import type { PlannerProvider } from '../providers/types';
import { cleanRawOutput, STATE_NARRATION } from '../sessionContextHub';

const SUMMARY_SYSTEM = `Eres Zed, el asistente de voz de Kite Code.
El proveedor que planifica las acciones también resume terminales. No inventes.
Lee el buffer y explica en español, en dos o tres frases habladas:
qué se le pidió al agente si se ve, qué hizo, y en qué quedó.
Ignora "Thought for", listas de archivos explorados, spinners y ruido de UI.
Si el buffer no tiene contenido útil, dilo en una frase.
Responde ÚNICAMENTE un objeto JSON: {"spoken":"<texto para leer en voz alta>"}`;

export interface TerminalSummaryInput {
  label: string;
  engine: string;
  state: string;
  buffer: string;
}

export function parseSpokenSummary(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { spoken?: string; reply?: string };
      const spoken = (parsed.spoken || parsed.reply || '').trim();
      if (spoken && !spoken.startsWith('{')) return collapseSpeech(spoken);
    }
  } catch {
    // plain text fallback
  }
  if (trimmed.startsWith('{')) return '';
  return collapseSpeech(trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, ''));
}

const MAX_SPOKEN_SUMMARY_CHARS = 700;

function collapseSpeech(text: string, maxChars = MAX_SPOKEN_SUMMARY_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;

  const sentenceEndPattern = /[.!?…]+(?=\s|$)/g;
  let lastBoundaryEnd = -1;
  let firstBoundaryEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = sentenceEndPattern.exec(normalized)) !== null) {
    const endIdx = match.index + match[0].length;
    if (firstBoundaryEnd === -1) {
      firstBoundaryEnd = endIdx;
    }
    if (endIdx <= maxChars) {
      lastBoundaryEnd = endIdx;
    } else {
      break;
    }
  }

  if (lastBoundaryEnd > 0) {
    return normalized.slice(0, lastBoundaryEnd).trim();
  }

  if (firstBoundaryEnd > 0 && firstBoundaryEnd <= Math.round(maxChars * 1.5)) {
    return normalized.slice(0, firstBoundaryEnd).trim();
  }

  const window = normalized.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxChars * 0.5) ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[,;:\-–—\s]+$/, '')}.`;
}

export function prepareTerminalExcerpt(buffer: string): string {
  const cleaned = cleanRawOutput(buffer)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^thought for\b/i.test(line))
    .filter((line) => !/^explored \d+/i.test(line))
    .join('\n');
  return cleaned.slice(-3500);
}

function excerptForAgentLabel(buffer: string, label: string): string {
  const excerpt = prepareTerminalExcerpt(buffer);
  if (!label.trim()) return excerpt;
  const lines = excerpt.split('\n').map((line) => line.trim()).filter(Boolean);
  const tagged = lines.filter((line) => line.includes(`[${label}]`));
  if (tagged.length > 0) {
    return tagged.join('\n');
  }
  return excerpt;
}

function summarizeTerminalsLocally(terminals: TerminalSummaryInput[]): string {
  if (terminals.length === 0) {
    return 'No hay terminales abiertas para resumir.';
  }
  const parts = terminals.map((term) => {
    const excerpt = excerptForAgentLabel(term.buffer, term.label);
    const stateEs = STATE_NARRATION[term.state]?.es || term.state;
    const body =
      excerpt ||
      'El buffer está vacío; aún no hay salida útil del agente.';
    if (terminals.length === 1) {
      return `En ${term.label}: ${stateEs}. ${body}`;
    }
    return `${term.label}: ${stateEs}. ${body}`;
  });
  return collapseSpeech(parts.join(' '));
}

export async function summarizeTerminalsWithProvider(
  provider: PlannerProvider,
  terminals: TerminalSummaryInput[]
): Promise<string> {
  if (provider.id === 'local') {
    return summarizeTerminalsLocally(terminals);
  }

  const body = terminals
    .map((term, index) => {
      const excerpt = prepareTerminalExcerpt(term.buffer);
      return [
        `Terminal ${index + 1}: ${term.label}`,
        `Motor: ${term.engine}`,
        `Estado: ${term.state}`,
        excerpt ? `Buffer:\n${excerpt}` : 'Buffer: (vacío)',
      ].join('\n');
    })
    .join('\n\n');

  console.info(`[Zed] Resumiendo terminal con ${provider.id}…`);
  const res = await provider.plan(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: body },
    ],
    { timeoutSecs: 12 }
  );

  const spoken = parseSpokenSummary(res.rawText);
  if (!spoken) {
    throw new Error('El modelo no devolvió un resumen hablado.');
  }
  return spoken;
}
