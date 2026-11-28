import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  pluginCatalogFetch,
  pluginCatalogInstall,
  pluginCatalogSaveSources,
  type PluginCatalogEntry,
  type PluginCatalogFetchError,
  type PluginCatalogSource,
  type PluginRecordDto,
} from '../../../lib/ipc/pluginRuntime';
import { SelectMenu, type SelectMenuRow } from '../../ui/SelectMenu';
import {
  ClearIcon,
  ExternalLinkIcon,
  PuzzleIcon,
  RefreshIcon,
  SearchIcon,
} from './pluginIcons';
import './plugin-catalog.css';

export type CatalogStatusFilter = 'all' | 'available' | 'installed' | 'updates';

export interface PluginCatalogTabProps {
  workspaceId?: string | null;
  onInstalled?: (plugin: PluginRecordDto) => void;
}

const STATUS_LABEL_MAP: Record<CatalogStatusFilter, string> = {
  all: 'All',
  available: 'Available',
  installed: 'Installed',
  updates: 'Updates',
};

function formatCatalogError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Unexpected error while communicating with plugin catalog runtime.';
}

function inferFeedName(rawUrl: string): string {
  const cleaned = rawUrl.trim().replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'Catalog Feed';
}

function createUniqueSourceId(nameOrUrl: string, existing: readonly PluginCatalogSource[]): string {
  const base =
    nameOrUrl
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'feed';
  const taken = new Set(existing.map((s) => s.id.toLowerCase()));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function isSafeHttpHref(raw?: string | null): raw is string {
  if (!raw) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith('https://') || trimmed.startsWith('http://');
}

export function filterCatalogEntries(
  entries: readonly PluginCatalogEntry[],
  searchQuery: string,
  statusFilter: CatalogStatusFilter
): PluginCatalogEntry[] {
  let list = entries;
  if (statusFilter === 'available') {
    list = list.filter((entry) => !entry.installed);
  } else if (statusFilter === 'installed') {
    list = list.filter((entry) => entry.installed);
  } else if (statusFilter === 'updates') {
    list = list.filter((entry) => entry.installed && entry.updateAvailable);
  }

  const query = searchQuery.trim().toLowerCase();
  if (!query) return [...list];

  const tokens = query.split(/\s+/).filter(Boolean);
  return list.filter((entry) => {
    const haystack = [
      entry.displayName,
      entry.name,
      entry.id,
      entry.description,
      entry.author ?? '',
      entry.sourceName,
      ...entry.keywords,
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export const PluginCatalogTab: React.FC<PluginCatalogTabProps> = ({
  workspaceId,
  onInstalled,
}) => {
  const [sources, setSources] = useState<PluginCatalogSource[]>([]);
  const [entries, setEntries] = useState<PluginCatalogEntry[]>([]);
  const [feedErrors, setFeedErrors] = useState<PluginCatalogFetchError[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [savingSources, setSavingSources] = useState<boolean>(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CatalogStatusFilter>('all');
  const [sourcesExpanded, setSourcesExpanded] = useState(true);
  const [newFeedName, setNewFeedName] = useState('');
  const [newFeedUrl, setNewFeedUrl] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const result = await pluginCatalogFetch(workspaceId ?? undefined);
      if (!mountedRef.current) return;
      setSources(Array.isArray(result.sources) ? result.sources : []);
      setEntries(Array.isArray(result.entries) ? result.entries : []);
      setFeedErrors(Array.isArray(result.errors) ? result.errors : []);
      setRequestError(null);
    } catch (err) {
      const msg = formatCatalogError(err);
      console.warn('[PluginCatalogTab] pluginCatalogFetch failed:', err);
      if (!mountedRef.current) return;
      setRequestError(msg);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const persistSources = useCallback(
    async (nextSources: PluginCatalogSource[]) => {
      setSavingSources(true);
      setRequestError(null);
      try {
        const saved = await pluginCatalogSaveSources(nextSources);
        if (!mountedRef.current) return;
        setSources(Array.isArray(saved) ? saved : nextSources);
        await loadCatalog();
      } catch (err) {
        const msg = formatCatalogError(err);
        console.warn('[PluginCatalogTab] pluginCatalogSaveSources failed:', err);
        if (mountedRef.current) {
          setRequestError(msg);
        }
      } finally {
        if (mountedRef.current) {
          setSavingSources(false);
        }
      }
    },
    [loadCatalog]
  );

  const handleAddSource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingSources) return;
    const trimmedUrl = newFeedUrl.trim();
    if (!trimmedUrl) {
      setRequestError('Enter a feed URL or local catalog JSON path.');
      return;
    }
    const resolvedName = newFeedName.trim() || inferFeedName(trimmedUrl);
    const nextSource: PluginCatalogSource = {
      id: createUniqueSourceId(resolvedName, sources),
      name: resolvedName,
      url: trimmedUrl,
      enabled: true,
    };
    setNewFeedName('');
    setNewFeedUrl('');
    await persistSources([...sources, nextSource]);
  };

  const handleToggleSource = async (sourceId: string) => {
    if (savingSources) return;
    const nextSources = sources.map((src) =>
      src.id === sourceId ? { ...src, enabled: !src.enabled } : src
    );
    await persistSources(nextSources);
  };

  const handleRemoveSource = async (sourceId: string) => {
    if (savingSources) return;
    const nextSources = sources.filter((src) => src.id !== sourceId);
    await persistSources(nextSources);
  };

  const handleInstallEntry = async (entry: PluginCatalogEntry) => {
    const key = `${entry.sourceId}:${entry.id}`;
    if (installingKey) return;
    setInstallingKey(key);
    setRequestError(null);
    try {
      const installedRecord = await pluginCatalogInstall({
        sourceId: entry.sourceId,
        entryId: entry.id,
        workspaceId: workspaceId ?? undefined,
      });
      if (!mountedRef.current) return;
      setEntries((prev) =>
        prev.map((item) =>
          item.sourceId === entry.sourceId && item.id === entry.id
            ? {
                ...item,
                installed: true,
                installedVersion: installedRecord.version ?? item.version ?? null,
                updateAvailable: false,
              }
            : item
        )
      );
      onInstalled?.(installedRecord);
      await loadCatalog();
    } catch (err) {
      const msg = formatCatalogError(err);
      console.warn('[PluginCatalogTab] pluginCatalogInstall failed:', err);
      if (mountedRef.current) {
        setRequestError(msg);
      }
    } finally {
      if (mountedRef.current) {
        setInstallingKey(null);
      }
    }
  };

  const availableCount = useMemo(
    () => entries.filter((entry) => !entry.installed).length,
    [entries]
  );
  const installedCount = useMemo(
    () => entries.filter((entry) => entry.installed).length,
    [entries]
  );
  const updatesCount = useMemo(
    () => entries.filter((entry) => entry.installed && entry.updateAvailable).length,
    [entries]
  );

  const filterRows: SelectMenuRow[] = useMemo(
    () => [
      { id: 'all', title: 'All', badge: String(entries.length) },
      { id: 'available', title: 'Available', badge: String(availableCount) },
      { id: 'installed', title: 'Installed', badge: String(installedCount) },
      { id: 'updates', title: 'Updates', badge: String(updatesCount) },
    ],
    [entries.length, availableCount, installedCount, updatesCount]
  );

  const deferredSearch = useDeferredValue(searchQuery);
  const filteredEntries = useMemo(
    () => filterCatalogEntries(entries, deferredSearch, statusFilter),
    [entries, deferredSearch, statusFilter]
  );

  const hasAlerts = Boolean(requestError) || feedErrors.length > 0;

  return (
    <div className="plugin-catalog">
      <div className="plugin-catalog__toolbar">
        <label className="plugin-search plugin-catalog__search">
          <SearchIcon size={13} />
          <input
            type="search"
            aria-label="Search catalog"
            placeholder="Search catalog by name, author, or keyword..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && searchQuery) {
                e.preventDefault();
                setSearchQuery('');
              }
            }}
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="Clear catalog search"
              onClick={() => setSearchQuery('')}
            >
              <ClearIcon size={12} />
            </button>
          ) : null}
        </label>

        <div className="plugin-catalog__toolbar-actions">
          <SelectMenu
            variant="toolbar"
            label="Filter catalog status"
            value={statusFilter}
            triggerLabel={STATUS_LABEL_MAP[statusFilter]}
            minWidth={180}
            className="plugin-catalog__filter-select"
            rows={filterRows}
            onSelect={(id) => setStatusFilter(id as CatalogStatusFilter)}
          />

          <button
            type="button"
            className="secondary-button plugin-catalog__refresh-btn"
            disabled={loading}
            onClick={() => void loadCatalog()}
          >
            <RefreshIcon size={12} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <section className="plugin-catalog__sources" aria-label="Catalog feed sources">
        <div className="plugin-catalog__sources-header">
          <div className="plugin-catalog__sources-title-group">
            <h3 className="plugin-catalog__sources-title">Catalog Feeds</h3>
            <span className="plugin-catalog__sources-count">{sources.length}</span>
          </div>
          <button
            type="button"
            className="plugin-catalog__toggle-sources-btn"
            aria-expanded={sourcesExpanded}
            onClick={() => setSourcesExpanded((prev) => !prev)}
          >
            {sourcesExpanded ? 'Hide feeds' : 'Manage feeds'}
          </button>
        </div>

        {sourcesExpanded ? (
          <>
            <form className="plugin-catalog__source-form" onSubmit={(e) => void handleAddSource(e)}>
              <input
                type="text"
                className="plugin-catalog__input plugin-catalog__input--name"
                aria-label="Feed name"
                placeholder="Feed name (optional)"
                disabled={savingSources}
                value={newFeedName}
                onChange={(e) => setNewFeedName(e.currentTarget.value)}
              />
              <input
                type="text"
                className="plugin-catalog__input plugin-catalog__input--url"
                aria-label="Feed URL or path"
                placeholder="https://example.com/catalog.json or C:\feeds\catalog.json"
                disabled={savingSources}
                value={newFeedUrl}
                onChange={(e) => {
                  setNewFeedUrl(e.currentTarget.value);
                  if (requestError) setRequestError(null);
                }}
              />
              <button
                type="submit"
                className="primary-button plugin-catalog__add-btn"
                disabled={savingSources}
              >
                {savingSources ? 'Saving...' : 'Add feed'}
              </button>
            </form>

            {sources.length === 0 ? (
              <p className="plugin-catalog__empty-hint">
                No feeds configured yet. Add an HTTPS catalog URL or local JSON path above.
              </p>
            ) : (
              <div className="plugin-catalog__source-list">
                {sources.map((src) => {
                  const label = src.name || src.url;
                  return (
                    <div key={src.id} className="plugin-catalog__source-row">
                      <div className="plugin-catalog__source-meta">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={src.enabled}
                          aria-label={`Toggle feed ${label}`}
                          className="ui-switch"
                          disabled={savingSources}
                          onClick={() => void handleToggleSource(src.id)}
                        >
                          <span className="ui-switch__knob" />
                        </button>
                        <div className="plugin-catalog__source-copy">
                          <span className="plugin-catalog__source-name">{label}</span>
                          <span className="plugin-catalog__source-url">{src.url}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="plugin-catalog__remove-btn"
                        aria-label={`Remove feed ${label}`}
                        disabled={savingSources}
                        onClick={() => void handleRemoveSource(src.id)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : null}
      </section>

      {hasAlerts ? (
        <div role="alert" className="plugin-catalog__error-banner">
          {requestError ? <span>{requestError}</span> : null}
          {feedErrors.length > 0 ? (
            <ul className="plugin-catalog__error-list">
              {feedErrors.map((err) => (
                <li key={`${err.sourceId}:${err.message}`}>
                  <strong>{err.sourceName || err.sourceId}:</strong> {err.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="plugin-empty-card">
          <span aria-hidden="true" className="plugin-empty-card__icon">
            <PuzzleIcon size={18} />
          </span>
          <h3 className="plugin-empty-card__title">Loading plugin catalog...</h3>
          <p className="plugin-empty-card__copy">
            Fetching configured feeds and comparing versions with installed extensions.
          </p>
        </div>
      ) : sources.length === 0 ? (
        <div className="plugin-empty-card">
          <span aria-hidden="true" className="plugin-empty-card__icon">
            <PuzzleIcon size={18} />
          </span>
          <h3 className="plugin-empty-card__title">No catalog feeds configured</h3>
          <p className="plugin-empty-card__copy">
            Add a JSON feed URL or local catalog file path to discover and install extensions in one click.
          </p>
        </div>
      ) : filteredEntries.length === 0 ? (
        <p className="plugin-grid__empty">
          {entries.length === 0
            ? 'No plugins returned by the enabled catalog feeds.'
            : 'No catalog plugins match your current search or filter.'}
        </p>
      ) : (
        <div className="plugin-catalog__grid">
          {filteredEntries.map((entry) => {
            const entryKey = `${entry.sourceId}:${entry.id}`;
            const isInstalling = installingKey === entryKey;
            const title = entry.displayName || entry.name;
            const externalHref = isSafeHttpHref(entry.homepage)
              ? entry.homepage
              : isSafeHttpHref(entry.repository)
                ? entry.repository
                : null;

            const buttonLabel = isInstalling
              ? entry.updateAvailable
                ? 'Updating...'
                : 'Installing...'
              : entry.installed
                ? entry.updateAvailable
                  ? 'Update'
                  : 'Installed'
                : 'Install';

            const isActionDisabled =
              Boolean(installingKey) || (entry.installed && !entry.updateAvailable);

            return (
              <article
                key={entryKey}
                className="plugin-catalog__card"
                aria-label={`${title} catalog entry`}
              >
                <div className="plugin-catalog__card-top">
                  <span aria-hidden="true" className="plugin-catalog__tile">
                    <PuzzleIcon size={18} />
                  </span>

                  <div className="plugin-catalog__identity">
                    <div className="plugin-catalog__title-row">
                      <strong className="plugin-catalog__title">{title}</strong>
                      {entry.version ? (
                        <span className="plugin-catalog__version">{entry.version}</span>
                      ) : null}
                    </div>
                    <div className="plugin-catalog__meta-row">
                      <span className="plugin-catalog__source-pill">{entry.sourceName}</span>
                      <span className="plugin-catalog__kind-pill">{entry.installKind}</span>
                      {entry.author ? (
                        <span className="plugin-catalog__author">{entry.author}</span>
                      ) : null}
                    </div>
                  </div>

                  {entry.installed ? (
                    <span
                      className={`plugin-catalog__status-pill${
                        entry.updateAvailable
                          ? ' plugin-catalog__status-pill--update'
                          : ' plugin-catalog__status-pill--installed'
                      }`}
                    >
                      {entry.updateAvailable ? 'Update available' : 'Installed'}
                    </span>
                  ) : null}
                </div>

                <p className="plugin-catalog__description">
                  {entry.description || 'Installable plugin bundle.'}
                </p>

                {entry.keywords.length > 0 ? (
                  <div className="plugin-catalog__keywords">
                    {entry.keywords.slice(0, 4).map((kw) => (
                      <span key={kw} className="plugin-catalog__tag">
                        {kw}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="plugin-catalog__card-footer">
                  <div className="plugin-catalog__footer-meta">
                    {entry.installed && entry.installedVersion ? (
                      <span className="plugin-catalog__installed-ver">
                        v{entry.installedVersion.replace(/^v/i, '')} local
                      </span>
                    ) : null}
                    {externalHref ? (
                      <a
                        className="plugin-catalog__link"
                        href={externalHref}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <ExternalLinkIcon size={12} />
                        <span>Repo</span>
                      </a>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    className={`${
                      entry.installed && !entry.updateAvailable
                        ? 'secondary-button'
                        : 'primary-button'
                    } plugin-catalog__action-btn`}
                    disabled={isActionDisabled}
                    aria-busy={isInstalling}
                    onClick={() => void handleInstallEntry(entry)}
                  >
                    {buttonLabel}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PluginCatalogTab;
