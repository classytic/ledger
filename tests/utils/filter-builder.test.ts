import { describe, expect, it } from 'vitest';
import { buildItemFilters } from '../../src/utils/filter-builder.js';

describe('buildItemFilters', () => {
  // ── Empty / no-op cases ──────────────────────────────────────────────────

  it('returns empty object when filters is undefined', () => {
    expect(buildItemFilters(undefined)).toEqual({});
  });

  it('returns empty object when filters is empty', () => {
    expect(buildItemFilters({})).toEqual({});
  });

  // ── Valid filters ────────────────────────────────────────────────────────

  it('passes through simple equality filters', () => {
    const filters = { 'journalItems.departmentId': 'dept-1', status: 'active' };
    expect(buildItemFilters(filters)).toEqual(filters);
  });

  it('passes through numeric and boolean values', () => {
    const filters = { amount: 10000, active: true };
    expect(buildItemFilters(filters)).toEqual(filters);
  });

  it('passes through null values', () => {
    const filters = { deletedAt: null };
    expect(buildItemFilters(filters)).toEqual({ deletedAt: null });
  });

  it('allows safe MongoDB comparison operators ($gt, $lt, $in, etc.)', () => {
    const filters = {
      amount: { $gt: 1000, $lt: 5000 },
      category: { $in: ['A', 'B'] },
    };
    expect(buildItemFilters(filters)).toEqual(filters);
  });

  it('allows $regex operator', () => {
    const filters = { name: { $regex: '^test', $options: 'i' } };
    expect(buildItemFilters(filters)).toEqual(filters);
  });

  // ── Blocked operators ────────────────────────────────────────────────────

  it('rejects top-level operator keys (starting with $)', () => {
    expect(() => buildItemFilters({ $where: 'this.a > 1' })).toThrow(
      'Filter key "$where" is not allowed',
    );
  });

  it('rejects $expr at top level', () => {
    expect(() => buildItemFilters({ $expr: { $gt: ['$a', '$b'] } })).toThrow(
      'Filter key "$expr" is not allowed',
    );
  });

  it('rejects blocked $where operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $where: 'malicious code' } })).toThrow(
      'Filter operator "$where" is not allowed',
    );
  });

  it('rejects blocked $expr operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $expr: { $gt: ['$a', 1] } } })).toThrow(
      'Filter operator "$expr" is not allowed',
    );
  });

  it('rejects blocked $function operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $function: { body: 'return true' } } })).toThrow(
      'Filter operator "$function" is not allowed',
    );
  });

  it('rejects blocked $accumulator operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $accumulator: {} } })).toThrow(
      'Filter operator "$accumulator" is not allowed',
    );
  });

  it('rejects blocked $merge operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $merge: 'other_collection' } })).toThrow(
      'Filter operator "$merge" is not allowed',
    );
  });

  it('rejects blocked $out operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $out: 'other_collection' } })).toThrow(
      'Filter operator "$out" is not allowed',
    );
  });

  it('rejects blocked $unionWith operator in nested values', () => {
    expect(() => buildItemFilters({ field: { $unionWith: 'other_collection' } })).toThrow(
      'Filter operator "$unionWith" is not allowed',
    );
  });

  // ── Array values are passed through (not treated as objects) ─────────────

  it('passes through array values without checking for operators', () => {
    const filters = { tags: ['$where', '$expr'] }; // array, not object
    expect(buildItemFilters(filters)).toEqual(filters);
  });
});
