// Kite Code — Spanish Voice STT Phonetic Normalizer
// Corrects high-frequency Spanish speech-to-text homophones and spoken punctuation
// in context while preserving the raw transcript for trace auditability.

export interface NormalizedVoiceUtterance {
  raw: string;
  normalized: string;
  corrections: string[];
}

const LEADING_WAKE_WORD_RE =
  /^(?:(?:oye|che|hey|hola|mira|escucha|ok|okay)\s+)?(?:seth|set|zed|ced|sef|argos|argus|hargos|argo)(?:\s*[,.:;!?-]+\s*|\s+)(?=\S)/i;

const LEADING_COURTESY_RE = /^(?:por\s+favor|che|oye|mira)\s*[,.:;]+\s*(?=\S)/i;

/**
 * Normalizes Spanish STT artifacts in context without mutating technical intent.
 */
export function normalizeSpanishVoiceStt(rawInput: string): NormalizedVoiceUtterance {
  const raw = rawInput || '';
  if (!raw.trim()) {
    return { raw, normalized: '', corrections: [] };
  }

  const corrections: string[] = [];
  let text = raw.trim();

  // 1. Strip wake-word prefix ("oye Argos, abre un hilo..." / "oye Seth, ..." -> "abre un hilo...")
  const withoutWake = text.replace(LEADING_WAKE_WORD_RE, '').trim();
  if (withoutWake && withoutWake !== text) {
    corrections.push('wake_word');
    text = withoutWake;
  }

  const withoutCourtesy = text.replace(LEADING_COURTESY_RE, '').trim();
  if (withoutCourtesy && withoutCourtesy !== text) {
    corrections.push('courtesy_prefix');
    text = withoutCourtesy;
  }

  // 1b. Phonetic normalization for Argos when addressed inside the utterance or standalone
  const argosDirectFixed = text.replace(
    /(?<![a-záéíóúñ])(?:argos|argus|hargos)(?![a-záéíóúñ])/gi,
    'Argos'
  );
  const argosContextFixed = argosDirectFixed.replace(
    /\b(oye|che|hey|hola|ok|okay|mira|escucha|a|al|para|con|de|asistente)\s+argo(?![a-záéíóúñ])/gi,
    '$1 Argos'
  );
  if (argosContextFixed !== text) {
    corrections.push('phonetic_argos');
    text = argosContextFixed;
  }

  // 2. Normalize STT pauses between numbers and resource nouns ("dos. Terminales", "un. Hilo")
  const pauseFixed = text.replace(
    /\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s*\.\s*(terminal|terminales|agente|agentes|subagente|subagentes|hilo|hilos|thread|threads|consola|consolas|ventana|ventanas)\b/gi,
    '$1 $2'
  );
  if (pauseFixed !== text) {
    corrections.push('spoken_pause_punctuation');
    text = pauseFixed;
  }

  // 3. Phonetic "threads" misrecognitions ("threats", "treads", "trids", "treds")
  const threadsFixed = text.replace(
    /(?<![a-záéíóúñ])(?:threats?|treads?|trids?|treds?|zreds?)(?![a-záéíóúñ])/gi,
    (m) => (m.toLowerCase().endsWith('s') ? 'threads' : 'thread')
  );
  if (threadsFixed !== text) {
    corrections.push('phonetic_threads');
    text = threadsFixed;
  }

  // 4. Phonetic "subagente" ("su agente", "sub agente", "sub-agente")
  const subagentFixed = text.replace(
    /(?<![a-záéíóúñ])(?:su\s+agente|sub[-\s]+agente)(s?)(?![a-záéíóúñ])/gi,
    (_m, plural: string) => `subagente${plural || ''}`
  );
  if (subagentFixed !== text) {
    corrections.push('phonetic_subagent');
    text = subagentFixed;
  }

  // 5. Phonetic "la gente" -> "el agente" strictly in delegation/agent-control slots
  const agentPeopleFixed = text.replace(
    /\b(con|a|para|lanza|abre|cierra|dile\s+a|p[ií]dele\s+a|delega\s+a|hablar\s+con)\s+la\s+gente\b/gi,
    (_m, lead: string) => `${lead} el agente`
  );
  if (agentPeopleFixed !== text) {
    corrections.push('phonetic_agent');
    text = agentPeopleFixed;
  }

  // 6. Phonetic "ODD" ("o de de", "o.d.d.", "o d d", "ode" in ODD-creation context)
  const oddFixed = text
    .replace(/\b(?:o\.?\s*d\.?\s*d\.?|o\s+de\s+de)\b/gi, 'ODD')
    .replace(/\b(armar|arma|armemos|crear|crea|hacer|haz|enfoque|p[aá]sale|pasar)\s+(?:el\s+|un\s+)?ode\b/gi, '$1 un ODD');
  if (oddFixed !== text) {
    corrections.push('phonetic_odd');
    text = oddFixed;
  }

  // 7. Phonetic Spanish STT provider & orchestration term repairs
  const providerFixes: Array<[RegExp, string, string]> = [
    [/\b(?:anti[- ]?gr[aá]vit(?:i|y)|antigrabiti|anti[- ]?gravedad|de\s+gravity|the\s+gravity)\b/gi, 'antigravity', 'provider_antigravity'],
    [/(?<![a-záéíóúñ])(?:clod|cloud|clot|claud)\s+code(?![a-záéíóúñ])/gi, 'claude code', 'phonetic_claude_code'],
    [/\b(con|de|en|usando|para|motor|modelo)\s+(?:clot|clod|claudio|claud)\b/gi, '$1 claude', 'provider_claude'],
    [/\b(?:c[oó]dec|c[oó]dex|code[- ]x)\b/gi, 'codex', 'provider_codex'],
    [/\b(?:open[- ]coud|open[- ]code)\b/gi, 'opencode', 'provider_opencode'],
    [/\b(con|de|en|usando|para|motor|modelo)\s+(?:groc|brok|gro)\b/gi, '$1 grok', 'provider_grok'],
    [/(?<![a-záéíóúñ])(?:eswarm|suarm|esuarm|sworm)(?![a-záéíóúñ])/gi, 'swarm', 'phonetic_swarm'],
    [/(?<![a-záéíóúñ])(?:g[uü]ork[-\s]?tri|work\s+tree|worktri)(?![a-záéíóúñ])/gi, 'worktree', 'phonetic_worktree'],
    [/(?<![a-záéíóúñ])(?:kait|cait)(?![a-záéíóúñ])/gi, 'kite', 'phonetic_kite'],
  ];

  for (const [re, replacement, tag] of providerFixes) {
    const next = text.replace(re, replacement);
    if (next !== text) {
      corrections.push(tag);
      text = next;
    }
  }

  // 8. Seseo close verbs ("sierra/serrar/sierre/sierres/siérralo") in imperative/control context
  const seseoFixed = text.replace(
    /(?<![a-záéíóúñ])(sierra|serrar|sierre|sierres|sierren|si[eé]rral[ao]s?)(?![a-záéíóúñ])/gi,
    (m) => {
      const lead = m[0] === 'S' ? 'C' : 'c';
      return `${lead}${m.slice(1)}`;
    }
  );
  if (seseoFixed !== text) {
    corrections.push('phonetic_seseo_close');
    text = seseoFixed;
  }

  return {
    raw,
    normalized: text.replace(/\s+/g, ' ').trim(),
    corrections,
  };
}
