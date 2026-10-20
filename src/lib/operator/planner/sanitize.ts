// Kite Code — Operator Reply Sanitizer & Echo Detector
// Guarantees clean Spanish feedback, detects system prompt leakage/echo, and blocks raw JSON/markdown from reaching user TTS.

/**
 * Checks if raw text from the model contains echo or leakage from the system instructions.
 */
export function detectPromptEcho(text: string, systemPrompt?: string): boolean {
  if (!text || !text.trim()) return false;
  const lower = text.toLowerCase();

  // Known system prompt phrases that must never appear in user-facing reply
  const signaturePhrases = [
    'reglas críticas',
    'reglas criticas',
    'user request:',
    'contexto del espacio de trabajo',
    'open_terminals',
    'close_terminals',
    'inject_prompt',
    'spawn_subagent',
    '"actions":',
    '"reply":',
    'responde siempre en español',
    'responde únicamente con un objeto json',
    'responde unicamente con un objeto json',
  ];

  for (const phrase of signaturePhrases) {
    if (lower.includes(phrase)) {
      return true;
    }
  }

  // Code fences containing json
  if (/```(?:json)?/i.test(text) && (text.includes('{') || text.includes('}'))) {
    return true;
  }

  // Contiguous slice overlap check against systemPrompt (>= 40 contiguous characters)
  if (systemPrompt && systemPrompt.length >= 40) {
    const cleanPrompt = systemPrompt.toLowerCase().replace(/\s+/g, ' ');
    const cleanText = lower.replace(/\s+/g, ' ');
    const windowSize = 40;
    for (let i = 0; i <= cleanText.length - windowSize; i += 20) {
      const chunk = cleanText.slice(i, i + windowSize);
      if (chunk.length === windowSize && cleanPrompt.includes(chunk)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if a string is predominantly English rather than Spanish.
 */
export function isPredominantlyEnglish(text: string): boolean {
  if (!text || !text.trim()) return false;
  const lower = text.toLowerCase();

  const englishTokens: RegExp[] = [
    /\bthe\b/i,
    /\band\b/i,
    /\bi have\b/i,
    /\bi opened\b/i,
    /\bi will\b/i,
    /\bsure\b/i,
    /\bhere are\b/i,
    /\bhere is\b/i,
    /\bterminals have been\b/i,
    /\bterminal has been\b/i,
    /\brunning tests\b/i,
    /\bplease wait\b/i,
    /\bas an ai\b/i,
    /\bsuccessfully opened\b/i,
    /\bsuccessfully closed\b/i,
  ];

  let matches = 0;
  for (const regex of englishTokens) {
    if (regex.test(lower)) {
      matches++;
    }
  }

  return matches >= 2 || (matches >= 1 && text.length < 50 && !/[áéíóúñ¿¡]/i.test(text));
}

/**
 * Strips raw code fences, JSON artifacts, and excessive whitespace,
 * validating language and length constraints.
 */
export function sanitizeReply(
  text: string,
  fallbackTemplate: string = 'Acción completada con éxito.'
): string {
  if (!text || !text.trim()) {
    return fallbackTemplate;
  }

  let cleaned = text.trim();

  // Strip markdown code fences first if wrapping the entire string
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // If text is a raw JSON string like {"reply": "...", "actions": []}, extract the reply field
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.reply === 'string') {
        cleaned = parsed.reply;
      }
    } catch {
      // not valid json, strip braces
      cleaned = cleaned.replace(/^\{+/, '').replace(/\}+$/, '');
    }
  }

  // Check for prompt echo on the extracted reply
  if (detectPromptEcho(cleaned)) {
    return fallbackTemplate;
  }

  // Remove any remaining markdown code blocks and backticks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // Strip JSON fragments like "actions": [...] or "reply": "..."
  cleaned = cleaned.replace(/"actions"\s*:\s*\[[\s\S]*?\]/gi, '');
  cleaned = cleaned.replace(/"reply"\s*:\s*"/gi, '');

  // Strip emojis to keep voice and visual status clean and professional
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

  // Normalize spaces and newlines
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Check if what remains is predominantly English
  if (isPredominantlyEnglish(cleaned)) {
    return fallbackTemplate;
  }

  // Enforce max length constraint (<= 280 characters)
  if (cleaned.length > 280) {
    cleaned = cleaned.slice(0, 277).trim() + '...';
  }

  return cleaned || fallbackTemplate;
}
