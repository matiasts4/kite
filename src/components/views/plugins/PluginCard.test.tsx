import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginCard, resolveCardCopy } from './PluginCard';
import type { ActivePlugin, PluginConnection } from './types';

describe('PluginCard - Layout Integrity', () => {
  const mockPlugin: ActivePlugin = {
    id: 'figma',
    name: 'Figma',
    vendor: 'Figma Inc.',
    version: '1.2.0',
    summary: 'Design file inspector and vector assets sync',
    description: 'Design file inspector and vector assets sync',
    status: 'available',
    logo: { file: 'plugin-figma' },
    category: 'creative',
    authentication: 'apiKey',
    prefersDarkTile: false,
    fallbackIcon: null,
    initialState: 'disconnected',
    permissions: [],
  };

  it('renders authentic 3-part layout: tile, copy, and connect button', () => {
    const onOpenDetails = vi.fn();
    const onConnectAction = vi.fn();
    const onToggleStatus = vi.fn();

    const { container } = render(
      <PluginCard
        plugin={mockPlugin}
        onOpenDetails={onOpenDetails}
        onConnectAction={onConnectAction}
        onToggleStatus={onToggleStatus}
      />
    );

    const card = container.querySelector('.plugin-card');
    expect(card).toBeInTheDocument();

    // 1. Tile
    const tile = container.querySelector('.plugin-card__tile');
    expect(tile).toBeInTheDocument();

    // 2. Copy with title and summary
    const copy = container.querySelector('.plugin-card__copy');
    expect(copy).toBeInTheDocument();
    expect(screen.getByText('Figma')).toBeInTheDocument();
    expect(screen.getByText('Design file inspector and vector assets sync')).toBeInTheDocument();

    // 3. Connect button
    const connectBtn = screen.getByRole('button', { name: /Connect Figma/i });
    expect(connectBtn).toBeInTheDocument();

    // Verify NO unstyled switches or rogue gear buttons exist inside the card
    expect(container.querySelector('.ui-switch')).toBeNull();
    expect(container.querySelector('.chrome-button')).toBeNull();
  });

  it('triggers onOpenDetails when user clicks anywhere on the card surface', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();
    const onConnectAction = vi.fn();
    const onToggleStatus = vi.fn();

    render(
      <PluginCard
        plugin={mockPlugin}
        onOpenDetails={onOpenDetails}
        onConnectAction={onConnectAction}
        onToggleStatus={onToggleStatus}
      />
    );

    await user.click(screen.getByText('Figma'));
    expect(onOpenDetails).toHaveBeenCalledWith(mockPlugin);
  });

  it('triggers onConnectAction when clicking the Connect button', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();
    const onConnectAction = vi.fn();
    const onToggleStatus = vi.fn();

    render(
      <PluginCard
        plugin={mockPlugin}
        onOpenDetails={onOpenDetails}
        onConnectAction={onConnectAction}
        onToggleStatus={onToggleStatus}
      />
    );

    const connectBtn = screen.getByRole('button', { name: /Connect Figma/i });
    await user.click(connectBtn);

    expect(onConnectAction).toHaveBeenCalledWith(mockPlugin);
  });
});

describe('PluginCard - Copy Resolution & Action States', () => {
  const basePlugin: ActivePlugin = {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe Inc.',
    version: '1.0.0',
    summary: 'Process payments and customer invoices.',
    description: 'Process payments and customer invoices.',
    status: 'available',
    logo: { file: 'plugin-stripe' },
    category: 'finance',
    authentication: 'apiKey',
    prefersDarkTile: false,
    fallbackIcon: null,
    initialState: 'disconnected',
    permissions: [],
  };

  it('resolves copy when connection.message exists with failed tone', () => {
    const conn: PluginConnection = {
      id: 'stripe',
      state: 'disconnected',
      account: null,
      message: 'Invalid API key provided.',
    };

    const copy = resolveCardCopy(basePlugin, conn);
    expect(copy.text).toBe('Invalid API key provided.');
    expect(copy.tone).toBe('failed');

    const { container } = render(<PluginCard plugin={basePlugin} connection={conn} />);
    const small = container.querySelector('small');
    expect(small).toHaveAttribute('data-tone', 'failed');
    expect(small).toHaveTextContent('Invalid API key provided.');
  });

  it('resolves copy for connected state with account or fallback', () => {
    const connWithAccount: PluginConnection = {
      id: 'stripe',
      state: 'connected',
      account: 'acct_1849204',
      message: null,
    };
    expect(resolveCardCopy(basePlugin, connWithAccount).text).toBe('acct_1849204');

    const connWithoutAccount: PluginConnection = {
      id: 'stripe',
      state: 'connected',
      account: null,
      message: null,
    };
    expect(resolveCardCopy(basePlugin, connWithoutAccount).text).toBe('Connected');
  });

  it('resolves copy for needsReauth state with account or name', () => {
    const connWithAccount: PluginConnection = {
      id: 'stripe',
      state: 'needsReauth',
      account: 'acct_1849204',
      message: null,
    };
    expect(resolveCardCopy(basePlugin, connWithAccount).text).toBe('acct_1849204 — reconnect to keep using it.');

    const connWithoutAccount: PluginConnection = {
      id: 'stripe',
      state: 'needsReauth',
      account: null,
      message: null,
    };
    expect(resolveCardCopy(basePlugin, connWithoutAccount).text).toBe('Stripe — reconnect to keep using it.');
  });

  it('resolves copy for connecting, unavailable, and default states', () => {
    expect(resolveCardCopy(basePlugin, { id: 'stripe', state: 'connecting', account: null, message: null }).text).toBe(
      'Finish in your browser or local app, then return here.'
    );
    expect(resolveCardCopy(basePlugin, { id: 'stripe', state: 'unavailable', account: null, message: null }).text).toBe(
      'Account setup is not available in this build.'
    );
    expect(resolveCardCopy(basePlugin, { id: 'stripe', state: 'disconnected', account: null, message: null }).text).toBe(
      'Process payments and customer invoices.'
    );
  });

  it('renders static chip for preview and unavailable states', () => {
    const { rerender } = render(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'preview', account: null, message: null }}
      />
    );
    expect(screen.getByText('Preview')).toHaveClass('plugin-connect--chip');

    rerender(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'unavailable', account: null, message: null }}
      />
    );
    expect(screen.getByText('Unavailable')).toHaveClass('plugin-connect--chip');
  });

  it('renders quiet button with spinner and Cancel for connecting state', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();

    const { container } = render(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'connecting', account: null, message: null }}
        onAction={onAction}
      />
    );

    const cancelBtn = screen.getByRole('button', { name: /Cancel Stripe/i });
    expect(cancelBtn).toHaveClass('plugin-connect--quiet');
    expect(container.querySelector('.button-spinner')).toBeInTheDocument();

    await user.click(cancelBtn);
    expect(onAction).toHaveBeenCalledWith('stripe', 'cancel');
  });

  it('renders hover-swap connected button with green dot and Disconnect', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();

    const { container } = render(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'connected', account: 'acct_123', message: null }}
        onAction={onAction}
      />
    );

    const disconnectBtn = screen.getByRole('button', { name: /Disconnect Stripe/i });
    expect(disconnectBtn).toHaveClass('plugin-connect--linked');
    expect(container.querySelector('.plugin-connect__dot')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Disconnect')).toBeInTheDocument();

    await user.click(disconnectBtn);
    expect(onAction).toHaveBeenCalledWith('stripe', 'disconnect');
  });

  it('renders Reconnect button for needsReauth and Disconnect button for disconnectPending', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();

    const { rerender } = render(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'needsReauth', account: null, message: null }}
        onAction={onAction}
      />
    );

    const reconnectBtn = screen.getByRole('button', { name: /Reconnect Stripe/i });
    await user.click(reconnectBtn);
    expect(onAction).toHaveBeenCalledWith('stripe', 'connect');

    rerender(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'disconnectPending', account: null, message: null }}
        onAction={onAction}
      />
    );

    const disconnectBtn = screen.getByRole('button', { name: /Disconnect Stripe/i });
    await user.click(disconnectBtn);
    expect(onAction).toHaveBeenCalledWith('stripe', 'disconnect');
  });

  it('triggers onOpenDetails when card is clicked', async () => {
    const user = userEvent.setup();
    const onOpenDetails = vi.fn();

    render(
      <PluginCard
        plugin={basePlugin}
        connection={{ id: 'stripe', state: 'connected', account: 'acct_123', message: null }}
        onOpenDetails={onOpenDetails}
      />
    );

    const card = screen.getByRole('article', { name: /Stripe/i });
    await user.click(card);
    expect(onOpenDetails).toHaveBeenCalledWith(basePlugin);
  });
});
