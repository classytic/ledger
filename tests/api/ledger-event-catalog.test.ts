/**
 * Full ledger event catalog — unit tests.
 *
 * Asserts:
 *   - Every `LEDGER_EVENTS.*` constant has a matching `LedgerEventDefinition`
 *     (no-drift invariant — adding a constant without a schema fails CI).
 *   - Each definition is structurally compatible with Arc's EventRegistry
 *     (register → catalog → retrieve round-trip).
 *   - Zod schemas accept valid payloads and reject malformed ones.
 *   - `z.toJSONSchema()` produces a usable JSON Schema on each event.
 *
 * See PACKAGE_RULES §18.5 for the pattern.
 */
import { describe, expect, it } from 'vitest';
import {
  ledgerEventDefinitions,
  EntryCreated,
  EntryPosted,
  EntryReversed,
  AccountSeeded,
  ReconciliationMatched,
  ReconciliationUnmatched,
} from '../../src/events/ledger-event-catalog.js';
import { LEDGER_EVENTS } from '../../src/events/event-constants.js';

describe('ledgerEventDefinitions', () => {
  it('covers every LEDGER_EVENTS constant (no-drift invariant)', () => {
    const defined = new Set(ledgerEventDefinitions.map((d) => d.name));
    const declared = Object.values(LEDGER_EVENTS);
    const missing = declared.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('has no duplicate event names', () => {
    const names = ledgerEventDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('each definition has name, version, schema, zodSchema, create()', () => {
    for (const def of ledgerEventDefinitions) {
      expect(typeof def.name).toBe('string');
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.schema.type).toBe('object');
      expect(def.zodSchema).toBeTruthy();
      expect(typeof def.create).toBe('function');
    }
  });

  it('every definition produces a non-empty JSON Schema via z.toJSONSchema()', () => {
    for (const def of ledgerEventDefinitions) {
      expect(def.schema.type).toBe('object');
      expect(def.schema.properties).toBeTruthy();
    }
  });

  it('every event name uses the `ledger:resource.verb` prefix', () => {
    for (const def of ledgerEventDefinitions) {
      expect(def.name.startsWith('ledger:')).toBe(true);
    }
  });
});

describe('Zod schemas — happy paths', () => {
  it('EntryCreated accepts a minimal payload', () => {
    const r = EntryCreated.zodSchema.safeParse({
      entryId: 'e1',
      state: 'draft',
    });
    expect(r.success).toBe(true);
  });

  it('EntryCreated accepts ObjectId-like entryId', () => {
    const r = EntryCreated.zodSchema.safeParse({
      entryId: { toString: () => 'e1' }, // ObjectId-like — passthrough via z.any()
      state: 'posted',
      journalType: 'sales',
      organizationId: 'org_1',
    });
    expect(r.success).toBe(true);
  });

  it('EntryPosted requires total debit + credit', () => {
    const r = EntryPosted.zodSchema.safeParse({
      entryId: 'e1',
      totalDebit: 100,
      totalCredit: 100,
    });
    expect(r.success).toBe(true);
  });

  it('EntryReversed requires ISO reversalDate', () => {
    const r = EntryReversed.zodSchema.safeParse({
      originalEntryId: 'e1',
      reversalEntryId: 'e2',
      reversalDate: '2026-04-20T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('AccountSeeded accepts seed counts', () => {
    const r = AccountSeeded.zodSchema.safeParse({ created: 50, skipped: 2 });
    expect(r.success).toBe(true);
  });

  it('ReconciliationMatched accepts the full payload', () => {
    const r = ReconciliationMatched.zodSchema.safeParse({
      matchingNumber: 'REC-2026-01',
      account: 'acc_1',
      itemCount: 5,
      debitTotal: 500,
      creditTotal: 500,
      isFullReconcile: true,
      currency: 'BDT',
    });
    expect(r.success).toBe(true);
  });

  it('ReconciliationMatched allows null currency (cross-currency)', () => {
    const r = ReconciliationMatched.zodSchema.safeParse({
      matchingNumber: 'REC-2026-02',
      account: 'acc_1',
      itemCount: 2,
      debitTotal: 100,
      creditTotal: 100,
      isFullReconcile: false,
      currency: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('Zod schemas — rejection paths', () => {
  it('EntryCreated rejects missing state', () => {
    const r = EntryCreated.zodSchema.safeParse({ entryId: 'e1' });
    expect(r.success).toBe(false);
  });

  it('EntryReversed rejects malformed reversalDate', () => {
    const r = EntryReversed.zodSchema.safeParse({
      originalEntryId: 'e1',
      reversalEntryId: 'e2',
      reversalDate: 'not-a-date',
    });
    expect(r.success).toBe(false);
  });

  it('ReconciliationUnmatched rejects missing itemCount', () => {
    const r = ReconciliationUnmatched.zodSchema.safeParse({
      matchingNumber: 'REC-1',
    });
    expect(r.success).toBe(false);
  });

  it('EntryPosted rejects non-numeric totalDebit', () => {
    const r = EntryPosted.zodSchema.safeParse({
      entryId: 'e1',
      totalDebit: 'one hundred',
      totalCredit: 100,
    });
    expect(r.success).toBe(false);
  });
});

describe('DomainEvent envelope', () => {
  it('EntryPosted.create() emits a well-formed event', () => {
    const event = EntryPosted.create(
      { entryId: 'e1', totalDebit: 50, totalCredit: 50 },
      { organizationId: 'org_1', correlationId: 'c_1' },
    );
    expect(event.type).toBe('ledger:entry.posted');
    expect(event.meta.organizationId).toBe('org_1');
    expect(event.meta.id).toBeTruthy();
  });
});

describe('Arc EventRegistry structural compatibility', () => {
  // Mirror arc's registry without a runtime arc dep (PACKAGE_RULES §11).
  function makeArcLikeRegistry() {
    const defs = new Map<string, { name: string; version: number; schema: unknown }>();
    return {
      register(def: { name: string; version: number; schema?: unknown }) {
        defs.set(def.name, {
          name: def.name,
          version: def.version,
          schema: def.schema,
        });
      },
      catalog() {
        return [...defs.values()];
      },
      get(name: string) {
        return defs.get(name);
      },
    };
  }

  it('every definition registers cleanly into an Arc-shaped registry', () => {
    const registry = makeArcLikeRegistry();
    for (const def of ledgerEventDefinitions) registry.register(def);
    expect(registry.catalog()).toHaveLength(ledgerEventDefinitions.length);
    expect(registry.get('ledger:entry.posted')?.version).toBe(1);
    expect(registry.get('ledger:reconciliation.matched')?.version).toBe(1);
  });

  it('every entry carries a JSON Schema with type=object', () => {
    const registry = makeArcLikeRegistry();
    for (const def of ledgerEventDefinitions) registry.register(def);
    for (const entry of registry.catalog()) {
      expect(entry.schema).toMatchObject({ type: 'object' });
    }
  });
});
