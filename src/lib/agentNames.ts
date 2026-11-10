// Kite Code — Agent Codenames & Name Pool
// Provides canonical agent identity names (Orion, Nova, Atlas, etc.)
// for multi-terminal and operator agent orchestration.

export const AGENT_CODENAMES = [
  'Orion', 'Nova', 'Atlas', 'Vega', 'Titan', 'Echo', 'Phoenix', 'Lyra', 'Apex', 'Zenith',
  'Cygnus', 'Helios', 'Falcon', 'Sirius', 'Altair', 'Polaris', 'Castor', 'Pollux', 'Astra', 'Cosmo',
  'Vortex', 'Nebula', 'Specter', 'Sol', 'Aura', 'Quantum', 'Nexus', 'Pulse', 'Ranger', 'Draco'
];

const RAW_ENGINE_NAMES = new Set([
  'claude-code', 'claude', 'codex', 'cursor', 'gemini', 'github-copilot', 'copilot',
  'droid', 'open-code', 'opencode', 'deep-seek', 'deepseek', 'grok', 'kimi', 'amp',
  'antigravity', 'gentle-shell', 'gentleshell', 'aider', 'muse', 'terminal', 'shell',
  'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'wsl'
]);

export function isRawEngineName(name?: string | null): boolean {
  if (!name) return false;
  return RAW_ENGINE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Resolves a candidate agent name to a canonical display codename (e.g. "Orion", "Atlas").
 * - If candidate is missing or is a raw engine name ("antigravity", "grok", etc.), allocates the next available codename.
 * - If candidate matches a known codename case-insensitively ("orion" -> "Orion"), returns the canonical Title Case form if free, or allocates the next available codename if already taken.
 * - Otherwise preserves the custom alias.
 */
export function resolveCanonicalAgentName(
  candidate: string | undefined | null,
  existingNames: Set<string>
): string {
  const trimmed = candidate?.trim() || '';
  if (!trimmed || isRawEngineName(trimmed)) {
    return getNextAgentName(existingNames);
  }
  const canonicalMatch = AGENT_CODENAMES.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase()
  );
  if (canonicalMatch) {
    if (!existingNames.has(canonicalMatch.toLowerCase())) {
      existingNames.add(canonicalMatch.toLowerCase());
      return canonicalMatch;
    }
    return getNextAgentName(existingNames);
  }
  existingNames.add(trimmed.toLowerCase());
  return trimmed;
}

/**
 * Returns the next available unique agent codename not present in existingNames.
 */
export function getNextAgentName(existingNames: Set<string>): string {
  for (const name of AGENT_CODENAMES) {
    if (!existingNames.has(name.toLowerCase())) {
      existingNames.add(name.toLowerCase());
      return name;
    }
  }
  let num = 2;
  while (true) {
    for (const name of AGENT_CODENAMES) {
      const candidate = `${name} ${num}`;
      if (!existingNames.has(candidate.toLowerCase())) {
        existingNames.add(candidate.toLowerCase());
        return candidate;
      }
    }
    num += 1;
  }
}

/**
 * Strips parenthesized engine or model suffixes and system prefixes from an agent title.
 */
export function cleanAgentTitle(title?: string | null): string {
  if (!title) return '';
  return title
    .replace(/^\[(?:ODD|AGENT|TERMINAL)\]\s*/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim() || title;
}

