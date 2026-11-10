export type CatalogEmptyKind = 'missing-binary' | 'signed-out' | 'loading' | 'empty';

export function catalogEmptyMessage(kind: CatalogEmptyKind, _provider: string): string {
  if (kind === 'missing-binary') return 'Open provider settings.';
  if (kind === 'signed-out') return 'Sign in.';
  if (kind === 'loading') return 'The catalog is still loading.';
  return 'The program has not listed its models yet.';
}
