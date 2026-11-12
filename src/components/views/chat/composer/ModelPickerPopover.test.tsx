import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelPickerPopover } from './ModelPickerPopover';
import type { DriverDeclaration } from '../../../../lib/session/types';

describe('ModelPickerPopover — Multi-Provider Favorites', () => {
  const STORAGE_KEY = 'kite_favorite_models_v1';

  const mockDeclaration: DriverDeclaration = {
    driver: 'antigravity',
    provider: 'antigravity',
    sessionMode: 'persistent',
    providers: [
      { id: 'antigravity', label: 'Antigravity', detail: 'Google DeepMind', engine: 'antigravity' },
      { id: 'grok', label: 'Grok Build', detail: 'xAI Corp.', engine: 'grok' },
    ],
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', detail: 'Fast reasoning' },
      { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', detail: 'Deep reasoning' },
    ],
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('renders trigger with current model name', () => {
    render(
      <ModelPickerPopover
        provider="antigravity"
        model="gemini-3.8-flash"
        declaration={mockDeclaration}
        onSelectModel={vi.fn()}
        onSelectProvider={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Gemini 3.8 Flash');
  });

  it('displays favorite models across multiple providers in the favorites tab', () => {
    // Pre-seed localStorage with favorites from both Antigravity and Grok
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { provider: 'antigravity', modelId: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro' },
        { provider: 'grok', modelId: 'grok-2', label: 'Grok 2' },
      ])
    );

    render(
      <ModelPickerPopover
        provider="antigravity"
        model="gemini-3.8-flash"
        declaration={mockDeclaration}
        onSelectModel={vi.fn()}
        onSelectProvider={vi.fn()}
      />
    );

    // Open popover
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));

    // Click Favorites tab on left rail
    const favTab = screen.getByRole('button', { name: 'Favorite Models' });
    fireEvent.click(favTab);

    // Both Antigravity and Grok models must be visible in favorites view
    expect(screen.getByText('Gemini 3.8 Pro')).toBeInTheDocument();
    expect(screen.getByText('Grok 2')).toBeInTheDocument();
  });

  it('switches provider and selects model when clicking a favorite from another provider', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { provider: 'grok', modelId: 'grok-2', label: 'Grok 2' },
      ])
    );

    const onSelectModel = vi.fn();
    const onSelectProvider = vi.fn();

    render(
      <ModelPickerPopover
        provider="antigravity"
        model="gemini-3.8-flash"
        declaration={mockDeclaration}
        onSelectModel={onSelectModel}
        onSelectProvider={onSelectProvider}
      />
    );

    // Open popover and click favorites tab
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite Models' }));

    // Click the Grok 2 option
    const grokOption = screen.getByText('Grok 2');
    fireEvent.click(grokOption);

    // Should switch provider to grok and select grok-2
    expect(onSelectProvider).toHaveBeenCalledWith('grok');
    expect(onSelectModel).toHaveBeenCalledWith('grok-2', 'grok');
  });
});
