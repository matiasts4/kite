import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InstalledPluginCard,
  OPEN_RIGHT_DOCK_SIDECAR_EVENT,
} from './InstalledPluginCard';
import type { PluginRecordDto } from '../../../lib/ipc/pluginRuntime';

function makePlugin(overrides: Partial<PluginRecordDto> = {}): PluginRecordDto {
  return {
    dirId: 'android-cli-plugin',
    name: 'android-cli-plugin',
    displayName: 'Android Device Tools',
    description: 'Device mirroring and UI inspection inside Kite.',
    version: '1.4.2',
    author: 'Kite Labs',
    homepage: 'https://example.com/android',
    repository: 'https://github.com/example/android-plugin',
    license: 'Apache-2.0',
    keywords: ['android', 'adb'],
    suggestedPrompts: ['Mirror connected Android device'],
    logoDataUri: null,
    source: 'globalKite',
    format: 'native',
    rootPath: '/plugins/android-cli-plugin',
    enabled: true,
    canUninstall: true,
    hasHooks: true,
    skills: [{ id: 's1', name: 'android-cli', description: 'Run adb tools' }],
    ruleNames: ['android-safety'],
    agentSlugs: ['mobile-qa'],
    mcpServers: [{ id: 'm1', serverName: 'adb-mcp', transport: 'stdio' }],
    sidecars: [
      {
        namespacedId: 'android-cli-plugin:device-hub',
        sidecarId: 'device-hub',
        pluginId: 'android-cli-plugin',
        pluginName: 'android-cli-plugin',
        displayName: 'Device Hub',
        description: 'Live device mirror',
        hasWebUi: true,
        views: [{ title: 'Device Hub', path: '/hub', entrypoint: 'index.html' }],
        state: 'running',
        pid: 4201,
        upstreamPort: 9010,
        proxyPort: 9011,
        proxyUrl: 'http://127.0.0.1:9011',
        entryUrl: 'http://127.0.0.1:9011/hub',
        logPath: '/logs/device-hub.log',
        restartCount: 0,
        lastError: null,
        startedAtMs: 1700000000000,
        builtin: null,
      },
    ],
    ...overrides,
  };
}

describe('InstalledPluginCard', () => {
  it('renders title, version, source pill, capability badges, and PuzzleIcon fallback', () => {
    render(
      <InstalledPluginCard
        plugin={makePlugin()}
        onOpenDetails={vi.fn()}
        onToggleEnabled={vi.fn()}
      />
    );

    expect(screen.getByText('Android Device Tools')).toBeInTheDocument();
    expect(screen.getByText('1.4.2')).toBeInTheDocument();
    expect(screen.getByText('Kite')).toBeInTheDocument();
    expect(screen.getByText('1 sidecar')).toBeInTheDocument();
    expect(screen.getByText('1 MCP')).toBeInTheDocument();
    expect(screen.getByText('1 skill')).toBeInTheDocument();
    expect(screen.getByText('1 regla')).toBeInTheDocument();
    expect(screen.getByText('Hooks')).toBeInTheDocument();
  });

  it('renders custom logo image when logoDataUri is present and distinguishes workspace/system sources', () => {
    const { container, rerender } = render(
      <InstalledPluginCard
        plugin={makePlugin({
          source: 'workspace',
          logoDataUri: 'data:image/png;base64,iVBORw0KGgo=',
        })}
        onOpenDetails={vi.fn()}
        onToggleEnabled={vi.fn()}
      />
    );

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    const img = container.querySelector('img.installed-plugin-card__logo');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');

    rerender(
      <InstalledPluginCard
        plugin={makePlugin({ source: 'sharedSystem' })}
        onOpenDetails={vi.fn()}
        onToggleEnabled={vi.fn()}
      />
    );
    expect(screen.getByText('Sistema')).toBeInTheDocument();
  });

  it('toggles enable switch without opening details drawer', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();
    const onToggleEnabled = vi.fn().mockResolvedValue([]);

    render(
      <InstalledPluginCard
        plugin={makePlugin({ enabled: true })}
        onOpenDetails={onOpenDetails}
        onToggleEnabled={onToggleEnabled}
      />
    );

    const toggle = screen.getByRole('switch', { name: /Desactivar Android Device Tools/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(onToggleEnabled).toHaveBeenCalledWith('android-cli-plugin', false);
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it('dispatches kite:open-right-dock-sidecar when clicking Abrir panel on enabled UI sidecar', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();
    const received: Array<{ sidecarId: string; viewPath: string; title: string }> = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail);
    };
    window.addEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, listener);

    try {
      const { rerender } = render(
        <InstalledPluginCard
          plugin={makePlugin({ enabled: true })}
          onOpenDetails={onOpenDetails}
          onToggleEnabled={vi.fn()}
        />
      );

      const openBtn = screen.getByRole('button', { name: /Abrir panel/i });
      await user.click(openBtn);

      expect(received).toEqual([
        {
          sidecarId: 'android-cli-plugin:device-hub',
          viewPath: '/hub',
          title: 'Device Hub',
        },
      ]);
      expect(onOpenDetails).not.toHaveBeenCalled();

      rerender(
        <InstalledPluginCard
          plugin={makePlugin({ enabled: false })}
          onOpenDetails={onOpenDetails}
          onToggleEnabled={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: /Abrir panel/i })).not.toBeInTheDocument();
    } finally {
      window.removeEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, listener);
    }
  });

  it('opens details drawer when clicking the card surface', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();
    const plugin = makePlugin();

    render(
      <InstalledPluginCard
        plugin={plugin}
        onOpenDetails={onOpenDetails}
        onToggleEnabled={vi.fn()}
      />
    );

    await user.click(screen.getByRole('article', { name: /Android Device Tools/i }));
    expect(onOpenDetails).toHaveBeenCalledWith(plugin);
  });
});
