import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginCard } from './PluginCard';
import type { ActivePlugin } from './types';

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
