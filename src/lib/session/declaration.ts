import type { DriverControlId, DriverDeclaration, DriverChoice } from './types';

/** Fallbacks used when a declaration omits a control without a specific reason. */
export const DEFAULT_UNDECLARED_REASON: Record<DriverControlId, string> = {
  provider: 'This driver did not declare a provider.',
  model: 'This driver did not declare a model catalog.',
  effort: 'This driver did not declare reasoning effort levels.',
  permission: 'This driver did not declare permission modes.',
  workMode: 'This driver did not declare a work mode.',
};

/** A control is declared when the declaration lists at least one row for it. */
export function isControlDeclared<T>(rows: readonly T[] | null | undefined): boolean {
  return Array.isArray(rows) && rows.length > 0;
}

/** The reason rendered on a control the declaration does not list. */
export function undeclaredReason(
  declaration: Pick<DriverDeclaration, 'unlistedReasons'>,
  control: DriverControlId
): string {
  const explicit = declaration.unlistedReasons?.[control]?.trim();
  return explicit && explicit.length > 0 ? explicit : DEFAULT_UNDECLARED_REASON[control];
}

/** True when the provider is one of the rows the declaration lists. */
export function isProviderDeclared(declaration: DriverDeclaration, provider: string): boolean {
  return declaration.providers.some((row: DriverChoice) => row.id === provider);
}
