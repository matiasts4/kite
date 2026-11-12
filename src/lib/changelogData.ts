import type {
  ReleaseCategory,
  RawReleaseItem,
  ReleaseItem,
  ReleaseNote,
  RawReleaseNote,
} from './changelog/types';
import { RELEASES_RECENT } from './changelog/releasesRecent';
import { RELEASES_EARLY } from './changelog/releasesEarly';

export type {
  ReleaseCategory,
  RawReleaseItem,
  ReleaseItem,
  ReleaseNote,
  RawReleaseNote,
};

/** Official historical and current releases for Kite Code Desktop */
export const KITE_RELEASES: RawReleaseNote[] = [
  {
    version: '0.1.53',
    tag: 'v0.1.53',
    date: 'Nov 12, 2026',
    title: 'Modularización y optimización arquitectónica',
    items: [
      {
        kind: 'changed',
        description: 'modularización de 15 módulos monolíticos de backend en submódulos cohesivos',
      },
      {
        kind: 'changed',
        description: 'descomposición de páginas complejas en frontend React',
      },
      {
        kind: 'changed',
        description: 'encapsulamiento de estado y extracción de módulos spawn y codec en terminal',
      },
    ],
  },
  ...RELEASES_RECENT,
  ...RELEASES_EARLY,
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
