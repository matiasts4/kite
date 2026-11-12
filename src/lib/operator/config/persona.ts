import type {
  ZedPersonaConfig,
  ZedMemoryNote,
  ZedTone,
  ZedBrevity,
  OperatorProviderConfig,
} from './types';
import { legacyOperatorMemoryNotesStorageKey } from '../../kiteLegacyIds';

export const DEFAULT_ZED_PERSONA: ZedPersonaConfig = {
  name: 'Zed',
  voice: 'Ara',
  tone: 'crisp',
  brevity: 'one-breath',
  language: 'es',
  builderCallMe: '',
  standingInstructions: '',
  rememberBetweenCalls: true,
  afterCallMode: 'summary+decisions',
};

const MEMORY_NOTES_STORAGE_KEY = 'kite.zed.memoryNotes.v1';

export function loadZedMemoryNotes(): ZedMemoryNote[] {
  try {
    let raw = localStorage.getItem(MEMORY_NOTES_STORAGE_KEY);
    if (!raw) {
      const legacyKey = legacyOperatorMemoryNotesStorageKey();
      raw = localStorage.getItem(legacyKey);
      if (raw) {
        localStorage.setItem(MEMORY_NOTES_STORAGE_KEY, raw);
        localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, idx): ZedMemoryNote | null => {
        if (typeof item === 'string') {
          return {
            id: `mem-legacy-${idx}`,
            content: item,
            createdAt: new Date().toISOString(),
          };
        }
        if (item && typeof item === 'object' && typeof item.content === 'string') {
          return {
            id: typeof item.id === 'string' ? item.id : `mem-${idx}-${Date.now()}`,
            content: item.content,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
            workspace: typeof item.workspace === 'string' ? item.workspace : undefined,
          };
        }
        return null;
      })
      .filter((n): n is ZedMemoryNote => n !== null);
  } catch {
    return [];
  }
}

export function saveZedMemoryNotes(notes: ZedMemoryNote[]): void {
  try {
    localStorage.setItem(MEMORY_NOTES_STORAGE_KEY, JSON.stringify(notes.slice(0, 50)));
  } catch {
    // ignore storage errors
  }
}

export function buildZedOpeningPreview(persona: ZedPersonaConfig): string {
  const assistantName = persona.name.trim() || 'Zed';
  const callMe = persona.builderCallMe.trim();
  const isEs = persona.language === 'es' || persona.language === 'auto';

  if (isEs) {
    const greeting = callMe ? `Listo, ${callMe}.` : 'Listo.';
    if (persona.tone === 'warm' || persona.tone === 'chill') {
      return `Hola${callMe ? ` ${callMe}` : ''}, soy ${assistantName}. Tengo el contexto del proyecto activo, ¿qué desplegamos ahora?`;
    }
    if (persona.tone === 'direct') {
      return `${greeting} ${assistantName} en línea. Indica la acción o subagente a lanzar.`;
    }
    if (persona.tone === 'calm') {
      return `${greeting} ${assistantName} conectado al workspace. Dime qué terminales o tareas quieres coordinar.`;
    }
    return `${greeting} Soy ${assistantName}. ¿Qué terminales, prompts o agentes ejecutamos?`;
  }

  const greetingEn = callMe ? `Ready, ${callMe}.` : 'Ready.';
  if (persona.tone === 'warm' || persona.tone === 'chill') {
    return `Hey${callMe ? ` ${callMe}` : ''}, ${assistantName} here. I have the active project context—what are we shipping next?`;
  }
  if (persona.tone === 'direct') {
    return `${greetingEn} ${assistantName} online. State the action or subagent to dispatch.`;
  }
  return `${greetingEn} ${assistantName} connected. Which terminals, prompts, or subagents should we run?`;
}

export function buildZedSystemInstructions(config: OperatorProviderConfig): string {
  const p = config.persona ?? DEFAULT_ZED_PERSONA;
  const name = p.name.trim() || 'Zed';
  const toneDesc: Record<ZedTone, string> = {
    calm: 'Steady, unhurried, and composed.',
    crisp: 'Concise, sharp, and technical with zero fluff.',
    warm: 'Collaborative, approachable, and supportive.',
    direct: 'Blunt, immediate, and action-first.',
    chill: 'Relaxed, conversational, and helpful.',
  };
  const brevityDesc: Record<ZedBrevity, string> = {
    'one-breath': 'Keep spoken/text replies to one short sentence (under 20 words) whenever possible.',
    tight: 'Keep spoken/text replies to one short sentence (under 20 words) whenever possible.',
    normal: 'Keep replies to 1-2 short sentences.',
    thorough: 'Provide complete context and step breakdowns when helpful.',
    detailed: 'Provide complete context and step breakdowns when helpful.',
  };

  const memoryNotes = p.rememberBetweenCalls ? loadZedMemoryNotes() : [];
  const memoryBlock =
    memoryNotes.length > 0
      ? `\nShared Memory Notes:\n${memoryNotes.map((n) => `- ${n.content}`).join('\n')}`
      : '';

  return [
    `You are ${name}, the voice & command operator inside Kite Code.`,
    `Tone: ${toneDesc[p.tone] || toneDesc.crisp}`,
    `Brevity: ${brevityDesc[p.brevity] || brevityDesc['one-breath']}`,
    p.builderCallMe.trim() ? `Address the builder as "${p.builderCallMe.trim()}".` : '',
    p.language && p.language !== 'auto' ? `Preferred response language: ${p.language}.` : '',
    p.standingInstructions.trim()
      ? `Standing Instructions from Builder:\n${p.standingInstructions.trim().slice(0, 600)}`
      : '',
    memoryBlock,
  ]
    .filter(Boolean)
    .join('\n');
}
