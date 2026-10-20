// Kite Code — Agent Codenames & Name Pool
// Provides canonical agent identity names (Orion, Nova, Atlas, etc.)
// for multi-terminal and operator agent orchestration.

export const AGENT_CODENAMES = [
  'Orion', 'Nova', 'Atlas', 'Vega', 'Titan', 'Echo', 'Phoenix', 'Lyra', 'Apex', 'Zenith',
  'Cygnus', 'Helios', 'Falcon', 'Sirius', 'Altair', 'Polaris', 'Castor', 'Pollux', 'Astra', 'Cosmo',
  'Vortex', 'Nebula', 'Specter', 'Sol', 'Aura', 'Quantum', 'Nexus', 'Pulse', 'Ranger', 'Draco'
];

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

