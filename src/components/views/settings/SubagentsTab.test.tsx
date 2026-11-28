import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../../../lib/ipc/core', () => ({
  invokeCommand: mockInvoke,
  invokeFlatCommand: mockInvoke,
  isTauriEnvironment: () => true,
}));

import { SubagentsTab, resetSubagentsTabCacheForTest } from './SubagentsTab';
import { SettingsView } from '../SettingsView';

const INITIAL_SNAPSHOT = {
  ok: true,
  workspacePath: 'C:/repo/kite',
  settings: {
    stack: [
      {
        provider: 'grok',
        model: 'grok-4.7-build-fast',
        effort: 'low',
        enabled: true,
      },
    ],
    defaultDelegation: {
      provider: 'grok',
      model: 'grok-4.7-build-fast',
      effort: 'low',
    },
    overridePolicy: 'ask',
  },
  providers: [
    {
      provider: 'grok',
      state: 'ready',
      binaryPresent: true,
      signedIn: true,
      supportsModelDiscovery: true,
      modelCount: 2,
      sampleModels: ['grok-4.7-build-fast', 'grok-4.20'],
      inStack: true,
      stackModels: ['grok-4.7-build-fast'],
      isDefaultDelegation: true,
    },
    {
      provider: 'antigravity',
      state: 'ready',
      binaryPresent: true,
      signedIn: true,
      supportsModelDiscovery: true,
      modelCount: 1,
      sampleModels: ['gemini-3-flash'],
      inStack: false,
      stackModels: [],
      isDefaultDelegation: false,
    },
  ],
  roles: [
    {
      slug: 'fast-reviewer',
      scope: 'workspace',
      path: 'C:/repo/kite/.kite/agents/fast-reviewer.md',
      command: 'grok',
      description: 'Fast code review subagent',
      provider: 'grok',
      model: 'grok-4.7-build-fast',
      effort: 'low',
      workspace: 'inherit',
      body: 'Review edge cases cleanly.',
    },
  ],
};

describe('SubagentsTab', () => {
  let state = structuredClone(INITIAL_SNAPSHOT);
  let runtimeSettingsState = {
    fastLaneEnabled: false,
    mcpHttpHubEnabled: true,
    maxHeavyProcesses: 4,
  };
  let legacyMissingRuntimeMetrics = false;

  beforeEach(() => {
    resetSubagentsTabCacheForTest();
    state = structuredClone(INITIAL_SNAPSHOT);
    runtimeSettingsState = {
      fastLaneEnabled: false,
      mcpHttpHubEnabled: true,
      maxHeavyProcesses: 4,
    };
    legacyMissingRuntimeMetrics = false;
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, any>) => {
      if (cmd === 'get_subagent_settings') {
        return structuredClone(state);
      }
      if (cmd === 'list_chat_provider_models') {
        if (args?.provider === 'antigravity') {
          return {
            provider: 'antigravity',
            catalogState: 'ready',
            models: [
              {
                id: 'gemini-3-flash',
                name: 'Gemini 3 Flash',
                supportsEffort: true,
                defaultEffort: 'medium',
                effortLevels: ['low', 'medium', 'high'],
              },
              {
                id: 'gemini-pro-orchestrator-neon',
                name: 'Orchestrator (Neon)',
                supportsEffort: false,
              },
            ],
          };
        }
        return {
          provider: 'grok',
          catalogState: 'ready',
          models: [
            {
              id: 'grok-4.7-build-fast',
              name: 'Grok 4.7 Build Fast',
              defaultEffort: 'low',
              effortLevels: ['low', 'medium'],
            },
            {
              id: 'grok-4.20',
              name: 'Grok 4.20',
              defaultEffort: 'high',
              effortLevels: ['low', 'medium', 'high'],
            },
          ],
        };
      }
      if (cmd === 'save_subagent_settings') {
        state = {
          ...state,
          settings: structuredClone(args?.settings ?? state.settings),
        };
        return structuredClone(state);
      }
      if (cmd === 'save_subagent_role') {
        const nextRole = {
          ...(args?.role ?? {}),
          path: `C:/repo/kite/.kite/agents/${args?.role?.slug}.md`,
        };
        const rest = state.roles.filter(
          (r) => !(r.slug === nextRole.slug && r.scope === nextRole.scope)
        );
        state = { ...state, roles: [...rest, nextRole] };
        return { ok: true, role: nextRole, roles: structuredClone(state.roles) };
      }
      if (cmd === 'delete_subagent_role') {
        state = {
          ...state,
          roles: state.roles.filter(
            (r) => !(r.slug === args?.slug && r.scope === args?.scope)
          ),
        };
        return { ok: true, roles: structuredClone(state.roles) };
      }
      if (cmd === 'get_runtime_transport_metrics') {
        if (legacyMissingRuntimeMetrics) {
          return undefined;
        }
        return {
          activeMuxDaemons: 1,
          agyAcp: { daemons: 1, sessions: 1 },
          opencode: { servers: 0, leases: 0 },
          grok: { daemons: 0, sessions: 0 },
          mcpHub: { httpRunning: true, port: 43120, requestCount: 0, pooledStdioServers: 1 },
          activeFastLaneSessions: 0,
          governor: {
            heavyActive: 0,
            heavyLimit: runtimeSettingsState.maxHeavyProcesses,
            multiplexedActive: 1,
            multiplexedLimit: 16,
            heavyQueued: 0,
          },
          settings: structuredClone(runtimeSettingsState),
        };
      }
      if (cmd === 'save_runtime_resource_settings') {
        runtimeSettingsState = structuredClone(args?.settings ?? runtimeSettingsState);
        return structuredClone(runtimeSettingsState);
      }
      return { ok: true };
    });
  });

  it('loads stack, override policy, default delegation, and roles, and updates policy/stack', async () => {
    const user = userEvent.setup();
    render(<SubagentsTab />);

    expect((await screen.findAllByText('grok-4.7-build-fast')).length).toBeGreaterThan(0);
    expect(screen.getByText('fast-reviewer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preguntar' })).toHaveAttribute('aria-pressed', 'true');

    // Switch renders animated knob element and clears defaultDelegation when disabling active default.
    const toggleBtn = screen.getByRole('switch', { name: 'Alternar grok/grok-4.7-build-fast' });
    expect(toggleBtn.querySelector('.ui-switch__knob')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Estricto' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'save_subagent_settings',
        expect.objectContaining({
          settings: expect.objectContaining({ overridePolicy: 'strict' }),
        })
      );
    });

    await user.click(toggleBtn);
    await waitFor(() => {
      expect(state.settings.stack[0].enabled).toBe(false);
      expect(state.settings.defaultDelegation).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /Agregar al stack/i }));
    await waitFor(() => {
      expect(state.settings.stack[0].enabled).toBe(true);
    });

    // When curated stack is non-empty, default delegation options exclude out-of-stack sample models.
    const defaultSelectBtn = screen.getByRole('combobox', { name: 'Modelo predeterminado de subagentes' });
    await user.click(defaultSelectBtn);
    expect(screen.queryByText(/gemini-3-flash/)).not.toBeInTheDocument();
    await user.click(defaultSelectBtn);
  });

  it('creates and deletes a role profile via IPC', async () => {
    const user = userEvent.setup();
    render(<SubagentsTab />);

    expect(await screen.findByText('fast-reviewer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Nuevo rol/i }));
    await user.type(screen.getByLabelText(/Identificador del rol/i), 'security-auditor');
    await user.type(screen.getByLabelText(/Descripción/i), 'Checks auth boundaries');
    await user.type(screen.getByLabelText(/Instrucciones de sistema/i), 'Inspect auth flows.');
    await user.click(screen.getByRole('button', { name: /Guardar rol/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'save_subagent_role',
        expect.objectContaining({
          role: expect.objectContaining({
            slug: 'security-auditor',
            scope: 'workspace',
            provider: null,
            command: 'auto',
            description: 'Checks auth boundaries',
            body: 'Inspect auth flows.',
          }),
        })
      );
    });
    expect(await screen.findByText('security-auditor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Eliminar rol security-auditor' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'delete_subagent_role',
        expect.objectContaining({ scope: 'workspace', slug: 'security-auditor' })
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('security-auditor')).not.toBeInTheDocument();
    });
  });

  it('exposes the Subagents tab inside SettingsView navigation', async () => {
    const user = userEvent.setup();
    render(<SettingsView isOpen={true} onClose={vi.fn()} />);

    const navBtn = screen.getByRole('button', { name: /Subagentes/i });
    await user.click(navBtn);

    expect(await screen.findByText('Política de delegación y modelo predeterminado')).toBeInTheDocument();
    expect(await screen.findByText('fast-reviewer')).toBeInTheDocument();
  });

  it('auto-populates stack and upgrades allow policy to ask when selecting a default lightweight model on an empty stack', async () => {
    const user = userEvent.setup();
    state.settings = {
      stack: [],
      defaultDelegation: null as any,
      overridePolicy: 'allow',
    };
    render(<SubagentsTab />);

    const defaultSelectBtn = await screen.findByRole('combobox', {
      name: 'Modelo predeterminado de subagentes',
    });
    await user.click(defaultSelectBtn);
    await user.click(screen.getByText(/gemini-3-flash/));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'save_subagent_settings',
        expect.objectContaining({
          settings: expect.objectContaining({
            overridePolicy: 'ask',
            defaultDelegation: expect.objectContaining({
              provider: 'antigravity',
              model: 'gemini-3-flash',
            }),
            stack: [
              expect.objectContaining({
                provider: 'antigravity',
                model: 'gemini-3-flash',
                enabled: true,
              }),
            ],
          }),
        })
      );
    });
  });

  it('toggles Fast Lane, MCP Hub pooling, and updates concurrent heavy process cap via IPC', async () => {
    const user = userEvent.setup();
    render(<SubagentsTab />);

    expect(await screen.findByText('Motor de ejecución y recursos')).toBeInTheDocument();

    const fastLaneSwitch = screen.getByRole('switch', {
      name: /Fast Lane nativo en Rust/i,
    });
    const mcpHubSwitch = screen.getByRole('switch', {
      name: /Pool HTTP\/Stdio del Hub MCP/i,
    });

    expect(fastLaneSwitch).toHaveAttribute('aria-checked', 'false');
    expect(mcpHubSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(fastLaneSwitch);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_runtime_resource_settings', {
        settings: {
          fastLaneEnabled: true,
          mcpHttpHubEnabled: true,
          maxHeavyProcesses: 4,
        },
      });
    });
    expect(fastLaneSwitch).toHaveAttribute('aria-checked', 'true');

    await user.click(mcpHubSwitch);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_runtime_resource_settings', {
        settings: {
          fastLaneEnabled: true,
          mcpHttpHubEnabled: false,
          maxHeavyProcesses: 4,
        },
      });
    });
    expect(mcpHubSwitch).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('button', { name: '8' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_runtime_resource_settings', {
        settings: {
          fastLaneEnabled: true,
          mcpHttpHubEnabled: false,
          maxHeavyProcesses: 8,
        },
      });
    });
    expect(screen.getByRole('button', { name: '8' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to safe default runtime resource settings when legacy IPC returns undefined', async () => {
    legacyMissingRuntimeMetrics = true;
    const user = userEvent.setup();
    render(<SubagentsTab />);

    expect(await screen.findByText('Motor de ejecución y recursos')).toBeInTheDocument();
    const fastLaneSwitch = screen.getByRole('switch', {
      name: /Fast Lane nativo en Rust/i,
    });
    const mcpHubSwitch = screen.getByRole('switch', {
      name: /Pool HTTP\/Stdio del Hub MCP/i,
    });

    expect(fastLaneSwitch).toHaveAttribute('aria-checked', 'false');
    expect(mcpHubSwitch).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_runtime_resource_settings', {
        settings: {
          fastLaneEnabled: false,
          mcpHttpHubEnabled: true,
          maxHeavyProcesses: 2,
        },
      });
    });
  });

  it('omits effort levels and resets effort to default when a non-effort model is selected', async () => {
    const user = userEvent.setup();
    render(<SubagentsTab />);

    expect(await screen.findByText('Política de delegación y modelo predeterminado')).toBeInTheDocument();

    // Select Antigravity provider
    await user.click(screen.getByRole('combobox', { name: 'Proveedor' }));
    await user.click(await screen.findByRole('option', { name: /Antigravity/i }));

    // Pick Gemini 3 Flash and choose "high" effort
    await user.click(screen.getByRole('combobox', { name: 'Esfuerzo' }));
    await user.click(await screen.findByRole('option', { name: 'high' }));
    expect(screen.getByRole('combobox', { name: 'Esfuerzo' })).toHaveTextContent('Esfuerzo: high');

    // Switch to Orchestrator (Neon) which has supportsEffort: false
    await user.click(screen.getByRole('combobox', { name: 'Modelo' }));
    await user.click(await screen.findByRole('option', { name: /Orchestrator \(Neon\)/i }));

    // Effort must reset to Por defecto and not offer fabricated levels like "high"
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Esfuerzo' })).toHaveTextContent(
        'Esfuerzo: Por defecto'
      );
    });
    await user.click(screen.getByRole('combobox', { name: 'Esfuerzo' }));
    expect(screen.queryByRole('option', { name: 'high' })).not.toBeInTheDocument();
  });
});
