import { describe, it, expect } from 'vitest';
import { requireOrgScope, orgFilter } from '../../src/utils/tenant-guard.js';

describe('requireOrgScope', () => {
  it('throws when orgField set but organizationId missing', () => {
    expect(() => requireOrgScope('business', undefined)).toThrow('organizationId is required');
    expect(() => requireOrgScope('business', null)).toThrow('organizationId is required');
    expect(() => requireOrgScope('business', '')).toThrow('organizationId is required');
  });

  it('does not throw when orgField is set and organizationId is provided', () => {
    expect(() => requireOrgScope('business', 'org-123')).not.toThrow();
  });

  it('does not throw when orgField is undefined (single-tenant)', () => {
    expect(() => requireOrgScope(undefined, undefined)).not.toThrow();
    expect(() => requireOrgScope(undefined, null)).not.toThrow();
  });

  it('includes orgField name in error message', () => {
    try {
      requireOrgScope('company', undefined);
    } catch (err) {
      expect((err as Error).message).toContain('company');
    }
  });
});

describe('orgFilter', () => {
  it('returns org-scoped filter when both values present', () => {
    expect(orgFilter('business', 'org-123')).toEqual({ business: 'org-123' });
  });

  it('returns empty object when orgField is undefined', () => {
    expect(orgFilter(undefined, 'org-123')).toEqual({});
  });

  it('returns empty object when orgField set but organizationId missing', () => {
    expect(orgFilter('business', undefined)).toEqual({});
    expect(orgFilter('business', null)).toEqual({});
  });

  it('returns empty object when both are undefined', () => {
    expect(orgFilter(undefined, undefined)).toEqual({});
  });

  it('uses dynamic field name', () => {
    expect(orgFilter('organization', 'org-456')).toEqual({ organization: 'org-456' });
  });
});
