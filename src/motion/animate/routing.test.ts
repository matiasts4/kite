import { describe, expect, it } from 'vitest';
import main from '../../main.tsx?raw';
import packageRaw from '../../../package.json?raw';

const pkg = JSON.parse(packageRaw) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('dev-only routing (S2, S3)', () => {
  it('keeps both labs behind import.meta.env.DEV', () => {
    expect(main).toMatch(/import\.meta\.env\.DEV && params\.has\('animate'\)/);
    expect(main).toMatch(/import\.meta\.env\.DEV && params\.has\('motion'\)/);
  });

  it('keeps motion as a production dependency for the standard layer', () => {
    expect(pkg.dependencies).toHaveProperty('motion');
    expect(pkg.devDependencies?.motion).toBeUndefined();
  });
});
