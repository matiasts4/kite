import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatApprovalCard } from './ChatApprovalCard';
import type { ApprovalRequest } from './types';

const DIFF_DETAIL = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,3 +1,3 @@',
  ' export function value() {',
  '-  return 1;',
  '+  return 2;',
  ' }',
].join('\n');

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    toolName: 'edit',
    title: 'Edit src/example.ts',
    detail: DIFF_DETAIL,
    risk: 'fileChange',
    impact: 'Modifies 1 file',
    ...overrides,
  };
}

describe('ChatApprovalCard', () => {
  it('renders unified diff approval detail with a single line-number gutter via @pierre/diffs', async () => {
    const { container } = render(
      <ChatApprovalCard approval={makeApproval()} onDecision={vi.fn()} />
    );

    expect(screen.queryByTestId('chat-approval-detail')).not.toBeInTheDocument();

    await waitFor(() => {
      const shadowRoot = container.querySelector('diffs-container')?.shadowRoot;
      expect(shadowRoot).toBeTruthy();
      expect(shadowRoot?.querySelector('[data-diff-type="single"]')).toBeTruthy();
      expect(shadowRoot?.querySelectorAll('[data-gutter]').length).toBe(1);
      const code = shadowRoot?.querySelector('[data-code]');
      expect(code?.textContent).toContain('return 2;');
    });
  });

  it('keeps non-patch prose detail on fileChange approvals as raw code text', () => {
    render(
      <ChatApprovalCard
        approval={makeApproval({
          toolName: 'write',
          title: 'Write README notes',
          detail: 'Append onboarding instructions to README.md',
        })}
        onDecision={vi.fn()}
      />
    );

    const rawDetail = screen.getByTestId('chat-approval-detail');
    expect(rawDetail).toHaveTextContent('Append onboarding instructions to README.md');
    expect(document.querySelector('diffs-container')).toBeNull();
    expect(screen.queryByText('No changes in this diff.')).not.toBeInTheDocument();
  });

  it('renders Always allow button and dispatches alwaysAllow decision', () => {
    const onDecision = vi.fn();
    render(<ChatApprovalCard approval={makeApproval()} onDecision={onDecision} />);

    const alwaysAllowBtn = screen.getByRole('button', { name: 'Always allow' });
    expect(alwaysAllowBtn).toBeInTheDocument();
    alwaysAllowBtn.click();
    expect(onDecision).toHaveBeenCalledWith('alwaysAllow', 'req-1');
  });
});
