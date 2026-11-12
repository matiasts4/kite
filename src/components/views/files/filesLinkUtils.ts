export function externalUrlFromToken(text: string): string | null {
  const trimmed = text.trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
  if (!trimmed || /[\s<>]/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

export function pathCandidateFromToken(text: string): string | null {
  const trimmed = text.trim().replace(/^['"`(<\[]+|['"`)>\].,;]+$/g, '');
  if (!trimmed || trimmed.length > 4096 || /[\r\n]/.test(trimmed)) return null;
  if (externalUrlFromToken(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('./')) return trimmed;
  return null;
}
