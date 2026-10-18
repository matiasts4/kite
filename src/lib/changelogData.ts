export type ReleaseCategory = 'added' | 'changed' | 'fixed' | 'security';

export interface RawReleaseItem {
  kind: ReleaseCategory;
  description: string;
}

export interface ReleaseItem {
  kind: ReleaseCategory;
  category: ReleaseCategory;
  description: string;
  text: string;
}

export interface ReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  isCurrent?: boolean;
  isIncoming?: boolean;
  items: ReleaseItem[];
}

export interface RawReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  items: RawReleaseItem[];
}

/** Official historical and current releases for Kite Code Desktop */
export const KITE_RELEASES: RawReleaseNote[] = [
  {
    version: '0.1.5',
    tag: 'v0.1.5',
    date: 'Oct 16, 2026',
    title: 'Dynamic Versioning & Interactive Changelog',
    items: [
      {
        kind: 'added',
        description: 'Dynamic version synchronization across all Settings tabs (General, About, Changelog, Footer).',
      },
      {
        kind: 'added',
        description: 'Interactive Changelog view displaying complete release history with incoming update previews.',
      },
      {
        kind: 'fixed',
        description: 'Eliminated hardcoded legacy version numbers from GeneralTab, ChangelogTab, and modals.',
      },
      {
        kind: 'changed',
        description: 'Synchronized What\'s New modal directly with Kite Code release ledger.',
      },
    ],
  },
  {
    version: '0.1.4',
    tag: 'v0.1.4',
    date: 'Oct 16, 2026',
    title: 'Reactive Updater & Vector Branding',
    items: [
      {
        kind: 'added',
        description: 'Reactive updater singleton store synchronizing Sidebar, Circular indicator, and Settings in real time.',
      },
      {
        kind: 'added',
        description: 'Auto-healing feed server: background daemon automatically starts on update requests.',
      },
      {
        kind: 'changed',
        description: 'Replaced raster TitleBar logo with 100% crisp vector SVG full-bleed icon.',
      },
      {
        kind: 'fixed',
        description: 'Transparent update diagnostics: displays connection errors with one-click retry.',
      },
      {
        kind: 'fixed',
        description: 'Persistent feed directory configured to prevent build tools from clearing release artifacts.',
      },
    ],
  },
  {
    version: '0.1.3',
    tag: 'v0.1.3',
    date: 'Oct 16, 2026',
    title: 'Crisp Terminal Mark & Download Optimization',
    items: [
      {
        kind: 'changed',
        description: 'Redesigned terminal monogram mark with high-contrast chevron and terminal cursor.',
      },
      {
        kind: 'fixed',
        description: 'Enabled HTTP Content-Length headers for exact update download percentage calculation.',
      },
      {
        kind: 'fixed',
        description: 'Streamlined HEAD and OPTIONS request handling across local feed endpoints.',
      },
    ],
  },
  {
    version: '0.1.2',
    tag: 'v0.1.2',
    date: 'Oct 16, 2026',
    title: 'Kite Code Brand Identity & Sanitization',
    items: [
      {
        kind: 'added',
        description: 'Brand identity: Kite Code with custom deep-sapphire and cyan identity.',
      },
      {
        kind: 'added',
        description: 'Air-gapped offline runtime and sanitized local persistent storage.',
      },
      {
        kind: 'changed',
        description: 'Interactive TitleBar with dedicated Agent, Code, and Thread mode switchers.',
      },
    ],
  },
  {
    version: '0.1.1',
    tag: 'v0.1.1',
    date: 'Oct 15, 2026',
    title: 'ConPTY Terminal & Multi-Agent Orchestration',
    items: [
      {
        kind: 'added',
        description: 'Native ConPTY Windows terminal daemon with hardware-accelerated rendering and automatic resizing.',
      },
      {
        kind: 'added',
        description: 'Multi-agent orchestration supporting local models and cloud providers in parallel.',
      },
      {
        kind: 'fixed',
        description: 'Eliminated terminal window flickering during background quota and process probing.',
      },
    ],
  },
  {
    version: '0.1.0',
    tag: 'v0.1.0',
    date: 'Oct 15, 2026',
    title: 'Initial Autonomous Desktop Release',
    items: [
      {
        kind: 'added',
        description: 'Embedded WebView2 browser surface with bounded layout preservation.',
      },
      {
        kind: 'added',
        description: 'Local Token and Subscription quota telemetry.',
      },
      {
        kind: 'security',
        description: 'Strict process isolation and secure minisign signature verification for updates.',
      },
    ],
  },
];

/**
 * Normalizes release notes with current version tagging and incoming update preview.
 */
export function getReleases(
  currentVersion: string,
  updateInfo?: { available?: boolean; version?: string | null; notes?: string | null } | null
): ReleaseNote[] {
  const normCurrent = currentVersion.replace(/^v/, '').trim();
  const list: ReleaseNote[] = KITE_RELEASES.map((rel) => ({
    ...rel,
    isCurrent: rel.version === normCurrent,
    items: rel.items.map((it) => ({
      ...it,
      category: it.kind,
      text: it.description,
    })),
  }));

  // If there's an available update not yet in the static list, prepend it dynamically!
  if (updateInfo?.available && updateInfo.version) {
    const incomingVer = updateInfo.version.replace(/^v/, '').trim();
    const alreadyPresent = list.some((r) => r.version === incomingVer);
    if (!alreadyPresent) {
      const dynamicItems: ReleaseItem[] = updateInfo.notes
        ? updateInfo.notes
            .split('\n')
            .map((line) => line.trim().replace(/^[-*•]\s*/, ''))
            .filter(Boolean)
            .map((desc) => {
              const lower = desc.toLowerCase();
              const kind: ReleaseCategory = lower.startsWith('fix')
                ? 'fixed'
                : lower.startsWith('sec')
                ? 'security'
                : lower.startsWith('add') || lower.startsWith('feat')
                ? 'added'
                : 'changed';
              return { kind, category: kind, description: desc, text: desc };
            })
        : [
            {
              kind: 'added',
              category: 'added',
              description: `Actualización oficial Kite Code v${incomingVer} lista para instalar.`,
              text: `Actualización oficial Kite Code v${incomingVer} lista para instalar.`,
            },
          ];

      list.unshift({
        version: incomingVer,
        tag: `v${incomingVer}`,
        date: 'Próxima actualización',
        title: `Versión ${incomingVer} (Disponible)`,
        isCurrent: false,
        isIncoming: true,
        items: dynamicItems,
      });
    }
  }

  return list;
}
