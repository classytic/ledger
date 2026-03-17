import { Errors } from './errors.js';

/**
 * Multi-tenant scope guard.
 *
 * Throws when orgField is configured (multi-tenant mode active) but
 * organizationId is missing — preventing unscoped cross-tenant queries.
 */
export function requireOrgScope(orgField: string | undefined, organizationId: unknown): void {
  if (orgField && !organizationId) {
    throw Errors.validation(
      'organizationId is required when multi-tenant mode is configured (orgField: "' +
      orgField +
      '"). Refusing to run unscoped query.',
    );
  }
}

/**
 * Build org-scoped query filter.
 * Returns an object like `{ business: orgId }` or `{}`.
 */
export function orgFilter(orgField: string | undefined, organizationId: unknown): Record<string, unknown> {
  if (!orgField) return {};
  // requireOrgScope should be called first; this is a convenience builder
  return organizationId ? { [orgField]: organizationId } : {};
}
