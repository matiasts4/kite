import { describe, expect, it } from 'vitest';
import { zedAssistantFailureMessage } from './assistantFailureNotice';

describe('zedAssistantFailureMessage', () => {
  it('explains a quota failure when the model never answered', () => {
    const message = zedAssistantFailureMessage({
      strategy: 'heuristic-fallback',
      fallbackReason:
        'Error HTTP 402 desde https://api.example/chat/completions: insufficient_quota',
      actionCount: 0,
    });

    expect(message).toMatch(/sin cuota/i);
    expect(message).toMatch(/no se procesó/i);
  });

  it('still explains quota when a local plan recovered the order', () => {
    const message = zedAssistantFailureMessage({
      strategy: 'heuristic-fallback',
      fallbackReason: 'API Gateway error HTTP 429 from https://api.example: rate limit',
      actionCount: 1,
    });

    expect(message).toBe('El modelo del asistente se quedó sin cuota.');
  });

  it('explains a timeout as no response', () => {
    expect(
      zedAssistantFailureMessage({
        strategy: 'heuristic-fallback',
        fallbackReason: 'Provider request timed out after 30s',
        actionCount: 0,
      })
    ).toMatch(/no respondió/i);
  });

  it('stays quiet when the model answered and the local plan ran', () => {
    expect(
      zedAssistantFailureMessage({
        strategy: 'heuristic-fallback',
        fallbackReason: 'Expected object, received string',
        actionCount: 2,
      })
    ).toBeNull();
  });

  it('stays quiet for a user cancellation and for plans that are not a model fallback', () => {
    expect(
      zedAssistantFailureMessage({
        strategy: 'heuristic-fallback',
        fallbackReason: 'The operation was aborted',
        actionCount: 0,
      })
    ).toBeNull();

    expect(
      zedAssistantFailureMessage({
        strategy: 'llm',
        fallbackReason: 'insufficient_quota',
        actionCount: 0,
      })
    ).toBeNull();

    expect(
      zedAssistantFailureMessage({
        strategy: 'heuristic',
        actionCount: 1,
      })
    ).toBeNull();
  });
});
