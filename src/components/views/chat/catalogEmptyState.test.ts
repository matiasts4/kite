import { describe, expect, it } from 'vitest';
import { catalogEmptyMessage } from './catalogEmptyState';

describe('catalog empty states', () => {
  it('tells the person to open provider settings when nothing is installed', () => {
    expect(catalogEmptyMessage('missing-binary', 'Grok')).toBe('Open provider settings.');
  });

  it('tells the person to sign in when the provider is installed and signed out', () => {
    expect(catalogEmptyMessage('signed-out', 'Grok')).toBe('Sign in.');
  });

  it('says the program has not listed its models yet when the account is signed in', () => {
    expect(catalogEmptyMessage('empty', 'Grok')).toBe('The program has not listed its models yet.');
  });
});
