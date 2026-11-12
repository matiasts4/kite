import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadErrorBanner } from './ThreadErrorBanner';

describe('ThreadErrorBanner', () => {
  it('dismisses an error and schedules resume at reset', () => {
    const onDismiss = vi.fn();
    const onResumeAtReset = vi.fn();
    const resetAt = Date.parse('2026-11-09T22:00:00');
    render(
      <ThreadErrorBanner
        failure={{ kind: 'usageLimit', message: 'quota', resetAtUnixMs: resetAt }}
        onDismiss={onDismiss}
        onResumeAtReset={onResumeAtReset}
      />
    );
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume at reset' }));
    expect(onResumeAtReset).toHaveBeenCalledWith(resetAt);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
