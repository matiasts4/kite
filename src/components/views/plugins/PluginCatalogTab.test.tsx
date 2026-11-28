import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginCatalogTab } from './PluginCatalogTab';
import * as pluginRuntime from '../../../lib/ipc/pluginRuntime';
import type {
  PluginCatalogEntry,
  PluginCatalogFetchResult,
  PluginCatalogSource,
  PluginRecordDto,
} from '../../../lib/ipc/pluginRuntime';

vi.mock('../../../lib/ipc/pluginRuntime', () => ({
  pluginCatalogFetch: vi.fn(),
  pluginCatalogSaveSources: vi.fn(),
  pluginCatalogInstall: vi.fn(),
}));

function makeSource(overrides: Partial<PluginCatalogSource> = {}): PluginCatalogSource {
  return {
    id: 'community-feed',
    name: 'Community Feed',
    url: 'https://example.com/catalog.json',
    enabled: true,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return {
    id: 'alpha-tools',
    sourceId: 'community-feed',
    sourceName: 'Community Feed',
    name: 'alpha-tools',
    displayName: 'Alpha Tools',
    description: 'Automation utilities for local workspaces.',
    version: '1.0.0',
    author: 'Kite Labs',
    homepage: 'https://example.com/alpha',
    repository: null,
    keywords: ['cli', 'automation'],
    installKind: 'git',
    installLocation: 'https://github.com/example/alpha-tools.git',
    gitRef: 'main',
    subdir: null,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
    ...overrides,
  };
}

function makePluginRecord(overrides: Partial<PluginRecordDto> = {}): PluginRecordDto {
  return {
    dirId: 'alpha-tools',
    name: 'alpha-tools',
    displayName: 'Alpha Tools',
    description: 'Automation utilities for local workspaces.',
    version: '1.0.0',
    author: 'Kite Labs',
    homepage: null,
    repository: null,
    license: null,
    keywords: [],
    suggestedPrompts: [],
    logoDataUri: null,
    source: 'globalKite',
    format: 'native',
    rootPath: '/plugins/alpha-tools',
    enabled: true,
    canUninstall: true,
    hasHooks: false,
    skills: [],
    ruleNames: [],
    agentSlugs: [],
    mcpServers: [],
    sidecars: [],
    ...overrides,
  };
}

describe('PluginCatalogTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches catalog feeds on mount and renders entries with Install, Update, and Installed states', async () => {
    const result: PluginCatalogFetchResult = {
      sources: [makeSource()],
      entries: [
        makeEntry({ id: 'alpha-tools', displayName: 'Alpha Tools', installed: false }),
        makeEntry({
          id: 'beta-sync',
          name: 'beta-sync',
          displayName: 'Beta Sync',
          version: '2.1.0',
          installed: true,
          installedVersion: '2.0.0',
          updateAvailable: true,
        }),
        makeEntry({
          id: 'gamma-lint',
          name: 'gamma-lint',
          displayName: 'Gamma Lint',
          version: '1.5.0',
          installed: true,
          installedVersion: '1.5.0',
          updateAvailable: false,
        }),
      ],
      errors: [],
    };
    vi.mocked(pluginRuntime.pluginCatalogFetch).mockResolvedValueOnce(result);

    render(<PluginCatalogTab workspaceId="ws-1" />);

    expect(await screen.findByText('Alpha Tools')).toBeInTheDocument();
    expect(screen.getByText('Beta Sync')).toBeInTheDocument();
    expect(screen.getByText('Gamma Lint')).toBeInTheDocument();
    expect(pluginRuntime.pluginCatalogFetch).toHaveBeenCalledWith('ws-1');

    const alphaCard = screen.getByRole('article', { name: 'Alpha Tools catalog entry' });
    expect(within(alphaCard).getByRole('button', { name: 'Install' })).toBeEnabled();

    const betaCard = screen.getByRole('article', { name: 'Beta Sync catalog entry' });
    expect(within(betaCard).getByText('Update available')).toBeInTheDocument();
    expect(within(betaCard).getByRole('button', { name: 'Update' })).toBeEnabled();

    const gammaCard = screen.getByRole('article', { name: 'Gamma Lint catalog entry' });
    expect(within(gammaCard).getByRole('button', { name: 'Installed' })).toBeDisabled();
  });

  it('filters catalog entries by search query and SelectMenu status options', async () => {
    const user = userEvent.setup();
    vi.mocked(pluginRuntime.pluginCatalogFetch).mockResolvedValueOnce({
      sources: [makeSource()],
      entries: [
        makeEntry({ id: 'alpha-tools', displayName: 'Alpha Tools', installed: false }),
        makeEntry({
          id: 'beta-sync',
          displayName: 'Beta Sync',
          version: '2.1.0',
          installed: true,
          installedVersion: '2.0.0',
          updateAvailable: true,
        }),
        makeEntry({
          id: 'gamma-lint',
          displayName: 'Gamma Lint',
          installed: true,
          installedVersion: '1.0.0',
          updateAvailable: false,
        }),
      ],
      errors: [],
    });

    render(<PluginCatalogTab />);
    await screen.findByText('Alpha Tools');

    // Filter via SelectMenu -> Updates
    const filterCombo = screen.getByRole('combobox', { name: 'Filter catalog status' });
    await user.click(filterCombo);
    await user.click(screen.getByRole('option', { name: /Updates/i }));

    expect(screen.queryByText('Alpha Tools')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Sync')).toBeInTheDocument();
    expect(screen.queryByText('Gamma Lint')).not.toBeInTheDocument();

    // Filter via SelectMenu -> Available
    await user.click(filterCombo);
    await user.click(screen.getByRole('option', { name: /Available/i }));

    expect(screen.getByText('Alpha Tools')).toBeInTheDocument();
    expect(screen.queryByText('Beta Sync')).not.toBeInTheDocument();

    // Back to All + search query
    await user.click(filterCombo);
    await user.click(screen.getByRole('option', { name: /^All/i }));

    const searchInput = screen.getByRole('searchbox', { name: 'Search catalog' });
    await user.type(searchInput, 'Gamma');
    expect(screen.getByText('Gamma Lint')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Tools')).not.toBeInTheDocument();
  });

  it('adds, toggles, and removes catalog sources via pluginCatalogSaveSources', async () => {
    const user = userEvent.setup();
    const initialSource = makeSource();
    const addedSource = makeSource({
      id: 'local-feed',
      name: 'Local Feed',
      url: 'C:\\feeds\\local.json',
      enabled: true,
    });

    vi.mocked(pluginRuntime.pluginCatalogFetch)
      .mockResolvedValueOnce({ sources: [initialSource], entries: [], errors: [] })
      .mockResolvedValueOnce({
        sources: [initialSource, addedSource],
        entries: [makeEntry({ sourceId: 'local-feed', sourceName: 'Local Feed' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        sources: [initialSource, { ...addedSource, enabled: false }],
        entries: [],
        errors: [],
      })
      .mockResolvedValueOnce({
        sources: [initialSource],
        entries: [],
        errors: [],
      });

    vi.mocked(pluginRuntime.pluginCatalogSaveSources)
      .mockResolvedValueOnce([initialSource, addedSource])
      .mockResolvedValueOnce([initialSource, { ...addedSource, enabled: false }])
      .mockResolvedValueOnce([initialSource]);

    render(<PluginCatalogTab />);
    await screen.findByText('Community Feed');

    // Empty feed URL validation
    await user.click(screen.getByRole('button', { name: 'Add feed' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/feed URL or local catalog/i);
    expect(pluginRuntime.pluginCatalogSaveSources).not.toHaveBeenCalled();

    // Add new feed
    await user.type(screen.getByLabelText('Feed name'), 'Local Feed');
    await user.type(screen.getByLabelText('Feed URL or path'), 'C:\\feeds\\local.json');
    await user.click(screen.getByRole('button', { name: 'Add feed' }));

    await waitFor(() => {
      expect(pluginRuntime.pluginCatalogSaveSources).toHaveBeenNthCalledWith(1, [
        initialSource,
        addedSource,
      ]);
    });
    expect(await screen.findByText('Alpha Tools')).toBeInTheDocument();

    // Toggle feed off
    await user.click(screen.getByRole('switch', { name: 'Toggle feed Local Feed' }));
    await waitFor(() => {
      expect(pluginRuntime.pluginCatalogSaveSources).toHaveBeenNthCalledWith(2, [
        initialSource,
        { ...addedSource, enabled: false },
      ]);
    });

    // Remove feed
    await user.click(screen.getByRole('button', { name: 'Remove feed Local Feed' }));
    await waitFor(() => {
      expect(pluginRuntime.pluginCatalogSaveSources).toHaveBeenNthCalledWith(3, [
        initialSource,
      ]);
    });
  });

  it('installs and updates entries in one click and invokes onInstalled callback', async () => {
    const user = userEvent.setup();
    const onInstalled = vi.fn();

    const availableAlpha = makeEntry({
      id: 'alpha-tools',
      displayName: 'Alpha Tools',
      version: '1.0.0',
      installed: false,
      updateAvailable: false,
    });
    const updatableBeta = makeEntry({
      id: 'beta-sync',
      name: 'beta-sync',
      displayName: 'Beta Sync',
      version: '2.1.0',
      installed: true,
      installedVersion: '2.0.0',
      updateAvailable: true,
    });

    vi.mocked(pluginRuntime.pluginCatalogFetch)
      .mockResolvedValueOnce({
        sources: [makeSource()],
        entries: [availableAlpha, updatableBeta],
        errors: [],
      })
      .mockResolvedValueOnce({
        sources: [makeSource()],
        entries: [
          {
            ...availableAlpha,
            installed: true,
            installedVersion: '1.0.0',
            updateAvailable: false,
          },
          updatableBeta,
        ],
        errors: [],
      })
      .mockResolvedValueOnce({
        sources: [makeSource()],
        entries: [
          {
            ...availableAlpha,
            installed: true,
            installedVersion: '1.0.0',
            updateAvailable: false,
          },
          {
            ...updatableBeta,
            installed: true,
            installedVersion: '2.1.0',
            updateAvailable: false,
          },
        ],
        errors: [],
      });

    const alphaRecord = makePluginRecord({ dirId: 'alpha-tools', version: '1.0.0' });
    const betaRecord = makePluginRecord({
      dirId: 'beta-sync',
      name: 'beta-sync',
      displayName: 'Beta Sync',
      version: '2.1.0',
    });

    vi.mocked(pluginRuntime.pluginCatalogInstall)
      .mockResolvedValueOnce(alphaRecord)
      .mockResolvedValueOnce(betaRecord);

    render(<PluginCatalogTab workspaceId="ws-9" onInstalled={onInstalled} />);
    await screen.findByText('Alpha Tools');

    // 1-click Install
    const alphaCard = screen.getByRole('article', { name: 'Alpha Tools catalog entry' });
    await user.click(within(alphaCard).getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(pluginRuntime.pluginCatalogInstall).toHaveBeenNthCalledWith(1, {
        sourceId: 'community-feed',
        entryId: 'alpha-tools',
        workspaceId: 'ws-9',
      });
      expect(onInstalled).toHaveBeenCalledWith(alphaRecord);
    });
    expect(within(alphaCard).getByRole('button', { name: 'Installed' })).toBeDisabled();

    // 1-click Update
    const betaCard = screen.getByRole('article', { name: 'Beta Sync catalog entry' });
    await user.click(within(betaCard).getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(pluginRuntime.pluginCatalogInstall).toHaveBeenNthCalledWith(2, {
        sourceId: 'community-feed',
        entryId: 'beta-sync',
        workspaceId: 'ws-9',
      });
      expect(onInstalled).toHaveBeenCalledWith(betaRecord);
    });
    expect(within(betaCard).getByRole('button', { name: 'Installed' })).toBeDisabled();
  });

  it('displays feed fetch errors and IPC rejection errors in alert banner', async () => {
    const user = userEvent.setup();
    vi.mocked(pluginRuntime.pluginCatalogFetch)
      .mockResolvedValueOnce({
        sources: [makeSource()],
        entries: [makeEntry()],
        errors: [
          {
            sourceId: 'broken-feed',
            sourceName: 'Broken Feed',
            message: 'HTTP 404 Not Found',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('Catalog backend offline'));

    render(<PluginCatalogTab />);

    const alertBanner = await screen.findByRole('alert');
    expect(alertBanner).toHaveTextContent('Broken Feed:');
    expect(alertBanner).toHaveTextContent('HTTP 404 Not Found');

    // Refresh triggers IPC rejection error
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog backend offline');
  });
});
