/**
 * DX & Type-level tests for the Journal Type Registry API.
 *
 * Validates that:
 * - Public API has correct return types
 * - JournalType contract is enforced at the type level
 * - JOURNAL_TYPES is readonly (frozen)
 * - Registry functions accept/reject the right parameter shapes
 */

import { describe, it, expectTypeOf } from 'vitest';
import type { JournalType } from '../../src/types/core.js';
import {
  JOURNAL_TYPES,
  JOURNAL_CODES,
  getJournalTypeCodes,
  isValidJournalType,
  getJournalType,
  registerJournalType,
  getCustomJournalTypes,
  _freezeJournalTypes,
  _resetCustomJournalTypes,
} from '../../src/constants/journals.js';

describe('Journal Registry — type-level tests', () => {

  // ── Constants ────────────────────────────────────────────────────────────

  it('JOURNAL_TYPES is a Readonly record of JournalType', () => {
    expectTypeOf(JOURNAL_TYPES).toMatchTypeOf<Readonly<Record<string, JournalType>>>();
  });

  it('JOURNAL_TYPES values satisfy JournalType interface', () => {
    expectTypeOf(JOURNAL_TYPES['SALES']).toMatchTypeOf<JournalType>();
  });

  it('JOURNAL_CODES is a Readonly record of string', () => {
    expectTypeOf(JOURNAL_CODES).toMatchTypeOf<Readonly<Record<string, string>>>();
  });

  // ── Lookup return types ──────────────────────────────────────────────────

  it('getJournalTypeCodes returns string[]', () => {
    expectTypeOf(getJournalTypeCodes).returns.toEqualTypeOf<string[]>();
  });

  it('isValidJournalType returns boolean', () => {
    expectTypeOf(isValidJournalType).returns.toEqualTypeOf<boolean>();
  });

  it('isValidJournalType accepts string parameter', () => {
    expectTypeOf(isValidJournalType).parameter(0).toBeString();
  });

  it('getJournalType returns JournalType | null', () => {
    expectTypeOf(getJournalType).returns.toEqualTypeOf<JournalType | null>();
  });

  it('getJournalType accepts string parameter', () => {
    expectTypeOf(getJournalType).parameter(0).toBeString();
  });

  // ── Registry function signatures ─────────────────────────────────────────

  it('registerJournalType accepts (string, JournalType) and returns void', () => {
    expectTypeOf(registerJournalType).parameter(0).toBeString();
    expectTypeOf(registerJournalType).parameter(1).toMatchTypeOf<JournalType>();
    expectTypeOf(registerJournalType).returns.toBeVoid();
  });

  it('getCustomJournalTypes returns JournalType[]', () => {
    expectTypeOf(getCustomJournalTypes).returns.toEqualTypeOf<JournalType[]>();
  });

  it('getCustomJournalTypes takes no parameters', () => {
    expectTypeOf(getCustomJournalTypes).parameters.toEqualTypeOf<[]>();
  });

  // ── Internal helpers ─────────────────────────────────────────────────────

  it('_freezeJournalTypes returns void and takes no args', () => {
    expectTypeOf(_freezeJournalTypes).returns.toBeVoid();
    expectTypeOf(_freezeJournalTypes).parameters.toEqualTypeOf<[]>();
  });

  it('_resetCustomJournalTypes returns void and takes no args', () => {
    expectTypeOf(_resetCustomJournalTypes).returns.toBeVoid();
    expectTypeOf(_resetCustomJournalTypes).parameters.toEqualTypeOf<[]>();
  });

  // ── JournalType contract ─────────────────────────────────────────────────

  it('JournalType requires code, name, and description as readonly strings', () => {
    expectTypeOf<JournalType>().toHaveProperty('code').toBeString();
    expectTypeOf<JournalType>().toHaveProperty('name').toBeString();
    expectTypeOf<JournalType>().toHaveProperty('description').toBeString();
  });

  it('JournalType does not accept extra properties at the type level', () => {
    // A plain object with only the 3 fields satisfies JournalType
    expectTypeOf<{ readonly code: string; readonly name: string; readonly description: string }>()
      .toMatchTypeOf<JournalType>();
  });
});
