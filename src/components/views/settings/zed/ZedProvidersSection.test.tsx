import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZedProvidersSection } from './ZedProvidersSection';
import {
  DEFAULT_OPERATOR_CONFIG,
  type OperatorConfig,
} from '../../../../lib/operator/operatorConfig';
import { listZedChatConnections } from '../../../../lib/operator/operatorProviders';

vi.mock('../../../../lib/operator/operatorProviders', () => ({
  listZedChatConnections: vi.fn().mockResolvedValue([]),
  isVerifiedChatEndpoint: () => true,
}));

vi.mock('./ModelSearchField', () => ({
  ModelSearchField: () => null,
}));

const buildProps = (config: OperatorConfig) => ({
  config,
  onFieldChange: vi.fn(),
  onPersistConfig: vi.fn(),
  showApiKeys: {},
  onToggleApiKey: vi.fn(),
  testingProvider: null,
  onRunProbe: vi.fn(),
  openCodeGoCredential: null,
  effectiveOpenCodeModels: [],
  syncingModels: false,
  openCodeSavedAt: null,
  onSyncModels: vi.fn(),
  effectiveVercelModels: [],
  syncingVercelModels: false,
  vercelSavedAt: null,
  onSyncVercelModels: vi.fn(),
  effectiveCloudflareModels: [],
  syncingCloudflareModels: false,
  cloudflareSavedAt: null,
  onSyncCloudflareModels: vi.fn(),
});

const providerGroup = () => screen.getByRole('group', { name: 'Proveedor IA' });

describe('ZedProvidersSection selector + single panel', () => {
  beforeEach(() => {
    vi.mocked(listZedChatConnections).mockResolvedValue([]);
  });

  it('renders the provider chips in one selector row and only the active panel', async () => {
    render(
      <ZedProvidersSection {...buildProps({ ...DEFAULT_OPERATOR_CONFIG, activeProvider: 'opencode' })} />
    );
    await waitFor(() => expect(listZedChatConnections).toHaveBeenCalled());

    const chips = within(providerGroup()).getAllByRole('button');
    expect(chips).toHaveLength(6);
    expect(within(providerGroup()).getByRole('button', { name: 'OpenCode Go' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(providerGroup()).getByRole('button', { name: 'Vercel AI' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    expect(screen.getByText('API Key de OpenCode Go (opcional)')).toBeInTheDocument();
    expect(screen.queryByText('Vercel AI Gateway API Key')).not.toBeInTheDocument();
  });

  it('switches the panel to the provider chosen in the selector', async () => {
    const user = userEvent.setup();
    const props = buildProps({ ...DEFAULT_OPERATOR_CONFIG, activeProvider: 'opencode' });
    const { rerender } = render(<ZedProvidersSection {...props} />);
    await waitFor(() => expect(listZedChatConnections).toHaveBeenCalled());

    await user.click(within(providerGroup()).getByRole('button', { name: 'Vercel AI' }));
    expect(props.onFieldChange).toHaveBeenCalledWith('activeProvider', 'vercel');

    rerender(
      <ZedProvidersSection
        {...props}
        config={{ ...props.config, activeProvider: 'vercel' }}
      />
    );

    expect(screen.getByText('Vercel AI Gateway API Key')).toBeInTheDocument();
    expect(screen.queryByText('API Key de OpenCode Go (opcional)')).not.toBeInTheDocument();
    expect(within(providerGroup()).getByRole('button', { name: 'Vercel AI' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('shows the local provider note without credential fields', async () => {
    render(
      <ZedProvidersSection {...buildProps({ ...DEFAULT_OPERATOR_CONFIG, activeProvider: 'local' })} />
    );
    await waitFor(() => expect(listZedChatConnections).toHaveBeenCalled());

    expect(screen.getByText(/no usa red ni credenciales/i)).toBeInTheDocument();
    expect(screen.queryByText(/API Key/i)).not.toBeInTheDocument();
  });
});
