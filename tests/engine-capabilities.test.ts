/**
 * assertLedgerCapabilities — the 0.14.0 boot gate. The engine constructor
 * runs it against the journal-entry repository; these tests exercise the
 * exported function directly with fake capability descriptors.
 */
import { describe, expect, it } from 'vitest';
import { assertLedgerCapabilities } from '../src/engine.js';

const FULL_CAPS = {
  transactions: true,
  upsert: true,
  duplicateKeyError: true,
};

describe('assertLedgerCapabilities', () => {
  it('passes for a backend declaring the required flags', () => {
    expect(() => assertLedgerCapabilities({ capabilities: FULL_CAPS })).not.toThrow();
  });

  it('throws when the backend declares no capabilities descriptor at all', () => {
    expect(() => assertLedgerCapabilities({})).toThrow(/no `capabilities` descriptor/);
    expect(() => assertLedgerCapabilities({})).toThrow(/mongokit 3.16/);
  });

  it('throws naming the missing flags', () => {
    expect(() =>
      assertLedgerCapabilities({ capabilities: { transactions: true, upsert: false } }),
    ).toThrow(/upsert, duplicateKeyError/);
  });

  it('does NOT require transactions without an outbox (standalone-Mongo fallback stays legal)', () => {
    expect(() =>
      assertLedgerCapabilities({
        capabilities: { ...FULL_CAPS, transactions: false },
      }),
    ).not.toThrow();
  });

  it('REQUIRES transactions when an outboxStore is configured', () => {
    expect(() =>
      assertLedgerCapabilities(
        { capabilities: { ...FULL_CAPS, transactions: false } },
        { outboxConfigured: true },
      ),
    ).toThrow(/transactions/);
    expect(() =>
      assertLedgerCapabilities(
        { capabilities: { ...FULL_CAPS, transactions: false } },
        { outboxConfigured: true },
      ),
    ).toThrow(/outboxStore is configured/);
  });

  it('passes with outbox when transactions are supported', () => {
    expect(() =>
      assertLedgerCapabilities({ capabilities: FULL_CAPS }, { outboxConfigured: true }),
    ).not.toThrow();
  });
});
