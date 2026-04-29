/**
 * 0.9.0 integration contract — events + bridges + multiTenantPlugin.
 *
 * Scenario-oriented test (openclaw pattern): set up two tenants, run a
 * realistic accounting flow (seed → post → reverse → match → unmatch),
 * assert on the full DomainEvent sequence, verify bridge invocation,
 * and confirm multiTenantPlugin scoping.
 *
 * Anti-regression anchors:
 *   - Arc EventTransport shape compatibility (DomainEvent, publishMany)
 *   - meta.organizationId + meta.userId threading
 *   - ledger:entry.* glob matching
 *   - Notification bridge fires on reconciliation mismatch
 *   - Tenant plugin scopes getAll/countDocuments without manual filter
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NotificationBridge,
  ReconciliationMismatchNotification,
} from '../../src/bridges/index.js';
import type { SourceBridge } from '../../src/bridges/source.bridge.js';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import { LEDGER_EVENTS } from '../../src/events/event-constants.js';
import { InProcessLedgerBus } from '../../src/events/in-process-bus.js';
import type { DomainEvent, EventTransport } from '../../src/events/transport.js';
import type { AccountType } from '../../src/types/core.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const accountTypes: readonly AccountType[] = [
  { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset' },
  { code: '1100', name: 'Accounts Receivable', category: 'Balance Sheet-Asset' },
  { code: '2100', name: 'Accounts Payable', category: 'Balance Sheet-Liability' },
  { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity' },
  { code: '4000', name: 'Sales', category: 'Income Statement-Income' },
  { code: '5000', name: 'Expenses', category: 'Income Statement-Expense' },
];

const testPack = defineCountryPack({
  code: 'T9',
  name: '0.9 Test Pack',
  defaultCurrency: 'USD',
  accountTypes,
  retainedEarningsAccountCode: '3600',
});

// ── Test-only EventTransport spy ────────────────────────────────────────────

interface CapturedEvent {
  type: string;
  payload: unknown;
  meta: DomainEvent['meta'];
}

function makeCapturingTransport(): {
  transport: EventTransport;
  captured: CapturedEvent[];
  bus: InProcessLedgerBus;
} {
  const captured: CapturedEvent[] = [];
  const bus = new InProcessLedgerBus();

  // Wrap publish to capture — structurally still an EventTransport.
  const transport: EventTransport = {
    name: 'capturing-ledger',
    publish: async (event) => {
      captured.push({ type: event.type, payload: event.payload, meta: event.meta });
      await bus.publish(event);
    },
    subscribe: (p, h) => bus.subscribe(p, h),
    close: () => bus.close(),
  };
  return { transport, captured, bus };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  for (const name of Object.keys(mongoose.models)) delete mongoose.models[name];
  for (const name of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[name]?.deleteMany({});
  }
});

// ── Scenario 1: full event sequence on a single-tenant flow ─────────────────

describe('0.9.0 — EventTransport contract', () => {
  it('emits ledger:account.seeded + entry.posted + entry.reversed in order with arc-shaped metadata', async () => {
    const { transport, captured } = makeCapturingTransport();

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      eventTransport: transport,
    });
    await engine.models.Account.createIndexes();
    await engine.models.JournalEntry.createIndexes();

    // 1. Seed accounts — expect ledger:account.seeded
    await engine.repositories.accounts.seedAccounts(null);

    // 2. Post an entry — expect ledger:entry.posted with balanced totals
    const cash = await engine.models.Account.findOne({ accountTypeCode: '1000' });
    const sales = await engine.models.Account.findOne({ accountTypeCode: '4000' });
    const entry = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: cash?._id, debit: 10_000, credit: 0 },
        { account: sales?._id, debit: 0, credit: 10_000 },
      ],
    } as never);
    await engine.repositories.journalEntries.post(
      (entry as { _id: unknown })._id,
      null,
      { actorId: 'tester-1' },
    );

    // 3. Reverse — expect ledger:entry.reversed with original + reversal IDs
    await engine.repositories.journalEntries.reverse(
      (entry as { _id: unknown })._id,
      null,
      { actorId: 'tester-1' },
    );

    const types = captured.map((e) => e.type);
    expect(types).toEqual([
      LEDGER_EVENTS.ACCOUNT_SEEDED,
      LEDGER_EVENTS.ENTRY_POSTED,
      LEDGER_EVENTS.ENTRY_REVERSED,
    ]);

    // meta.id must be unique; meta.timestamp must be a Date; meta.userId threaded from actorId
    for (const ev of captured) {
      expect(ev.meta.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(ev.meta.timestamp).toBeInstanceOf(Date);
    }
    const posted = captured.find((e) => e.type === LEDGER_EVENTS.ENTRY_POSTED);
    expect(posted?.meta.userId).toBe('tester-1');
    expect(posted?.meta.resource).toBe('journal-entry');
    const reversed = captured.find((e) => e.type === LEDGER_EVENTS.ENTRY_REVERSED);
    expect((reversed?.payload as { reversalEntryId: unknown }).reversalEntryId).toBeTruthy();

    // Arc publishMany contract still holds on the default in-process bus
    const defaultBus = new InProcessLedgerBus();
    expect(typeof defaultBus.publishMany).toBe('function');
  });

  it('supports glob subscribe `ledger:entry.*` — anti-regression for arc compatibility', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });
    await engine.models.Account.createIndexes();
    await engine.models.JournalEntry.createIndexes();

    const seen: string[] = [];
    const unsubscribe = await engine.events.subscribe('ledger:entry.*', (event) => {
      seen.push(event.type);
    });

    await engine.repositories.accounts.seedAccounts(null);
    const cash = await engine.models.Account.findOne({ accountTypeCode: '1000' });
    const sales = await engine.models.Account.findOne({ accountTypeCode: '4000' });
    const entry = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date(),
      journalItems: [
        { account: cash?._id, debit: 500, credit: 0 },
        { account: sales?._id, debit: 0, credit: 500 },
      ],
    } as never);
    await engine.repositories.journalEntries.post((entry as { _id: unknown })._id, null);
    await engine.repositories.journalEntries.archive((entry as { _id: unknown })._id, null).catch(() => {
      // archive on posted entry throws — that's fine, we just need the posted event
    });

    // Glob must have caught entry.posted — and NOT account.seeded (namespace mismatch)
    expect(seen).toContain(LEDGER_EVENTS.ENTRY_POSTED);
    expect(seen).not.toContain(LEDGER_EVENTS.ACCOUNT_SEEDED);

    unsubscribe();
  });

  it('swallows transport errors — a broken subscriber cannot break the write path', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });
    await engine.models.Account.createIndexes();
    await engine.models.JournalEntry.createIndexes();

    await engine.events.subscribe('ledger:*', async () => {
      throw new Error('subscriber blew up');
    });

    // seedAccounts must still succeed despite the throwing subscriber
    const result = await engine.repositories.accounts.seedAccounts(null);
    expect(result.created).toBeGreaterThan(0);
  });
});

// ── Scenario 2: bridges — source + notification ─────────────────────────────

describe('0.9.0 — Bridges', () => {
  it('fires notificationBridge.onReconciliationMismatch when debit ≠ credit', async () => {
    const onMismatch = vi.fn(async (_p: ReconciliationMismatchNotification) => undefined);
    const notification: NotificationBridge = { onReconciliationMismatch: onMismatch };

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      bridges: { notification },
    });
    await engine.models.Account.createIndexes();
    await engine.models.JournalEntry.createIndexes();
    await engine.models.Reconciliation.createIndexes();

    await engine.repositories.accounts.seedAccounts(null);
    const ar = await engine.models.Account.findOne({ accountTypeCode: '1100' });
    const cash = await engine.models.Account.findOne({ accountTypeCode: '1000' });
    const sales = await engine.models.Account.findOne({ accountTypeCode: '4000' });

    // Invoice: 100 AR / 100 Sales
    const invoice = (await engine.models.JournalEntry.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-01-10'),
      journalItems: [
        { account: ar?._id, debit: 100_00, credit: 0 },
        { account: sales?._id, debit: 0, credit: 100_00 },
      ],
    })) as { _id: unknown; journalItems: unknown[] };

    // Partial payment: 95 Cash / 95 AR (leaves 5 mismatch → FX / write-off)
    const payment = (await engine.models.JournalEntry.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-01-12'),
      journalItems: [
        { account: cash?._id, debit: 95_00, credit: 0 },
        { account: ar?._id, debit: 0, credit: 95_00 },
      ],
    })) as { _id: unknown };

    await engine.repositories.reconciliations.match({
      account: ar?._id,
      items: [
        { entry: invoice._id, itemIndex: 0 }, // debit AR 100
        { entry: payment._id, itemIndex: 1 }, // credit AR 95
      ],
    });

    expect(onMismatch).toHaveBeenCalledOnce();
    const payload = onMismatch.mock.calls[0]![0];
    expect(payload.debitTotal).toBe(100_00);
    expect(payload.creditTotal).toBe(95_00);
    expect(payload.difference).toBe(500);
  });

  it('sourceBridge.resolve is reachable via engine.bridges.source — host-implemented contract', async () => {
    const resolve = vi.fn(async (_id: string, model: string) => {
      if (model === 'Invoice') return { number: 'INV-42', total: 100_00 };
      return null;
    });
    const sourceBridge: SourceBridge = { resolve };

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      bridges: { source: sourceBridge },
    });

    expect(engine.bridges.source).toBeDefined();
    const out = await engine.bridges.source?.resolve?.('inv-42', 'Invoice', {});
    expect(out).toEqual({ number: 'INV-42', total: 100_00 });
    expect(resolve).toHaveBeenCalledWith('inv-42', 'Invoice', {});
  });
});

// ── Scenario 3: multiTenantPlugin scoping ────────────────────────────────────

describe('0.9.0 — multiTenantPlugin opt-in', () => {
  it('injects tenant filter from ctx.organizationId without manual scoping', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      multiTenant: { tenantField: 'business', ref: 'Business', plugin: true },
    });
    await engine.models.Account.createIndexes();

    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    // Seed directly on the model to bypass plugin injection — we WANT rows
    // for both tenants to exist so we can prove isolation on read. Use
    // distinct accountNumbers because the global unique index on
    // accountNumber is not compound with business in the default schema.
    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'A-1000',
      name: 'Cash A',
      business: orgA,
    });
    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'B-1000',
      name: 'Cash B',
      business: orgB,
    });

    // findAll WITHOUT context — plugin.required=false means no injection,
    // both rows visible. Anti-regression for default back-compat behavior.
    const all = await engine.repositories.accounts.findAll({});
    expect(all.length).toBe(2);

    // findAll WITH context.organizationId — plugin injects filter.
    const scopedA = await engine.repositories.accounts.findAll(
      {} as never,
      { organizationId: orgA } as never,
    );
    expect(scopedA.length).toBe(1);
    expect((scopedA[0] as { name: string }).name).toBe('Cash A');

    const scopedB = await engine.repositories.accounts.findAll(
      {} as never,
      { organizationId: orgB } as never,
    );
    expect(scopedB.length).toBe(1);
    expect((scopedB[0] as { name: string }).name).toBe('Cash B');
  });

  it('casts hex-string organizationId to match default ObjectId tenant fields', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      multiTenant: { tenantField: 'business', ref: 'Business', plugin: true },
    });
    await engine.models.Account.createIndexes();

    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'A-HEX',
      name: 'Cash A Hex',
      business: orgA,
    });
    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'B-HEX',
      name: 'Cash B Hex',
      business: orgB,
    });

    const scopedA = await engine.repositories.accounts.findAll(
      {} as never,
      { organizationId: orgA.toHexString() } as never,
    );

    expect(scopedA.length).toBe(1);
    expect((scopedA[0] as { name: string }).name).toBe('Cash A Hex');
  });

  // Divergent runtime key — ctx.<custom> instead of ctx.organizationId.
  // Earlier the factory hardcoded `contextKey: 'organizationId'`, silently
  // ignoring `multiTenant.contextKey` and either leaking (required: false)
  // or throwing on every call (required: true). This proves the explicit
  // contextKey override now reaches the plugin.
  it('honors explicit multiTenant.contextKey (e.g. ctx.businessId)', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      multiTenant: {
        tenantField: 'business',
        ref: 'Business',
        plugin: true,
        contextKey: 'businessId',
        required: true, // fail-closed proves the wiring fires
      },
    });
    await engine.models.Account.createIndexes();

    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'CK-A',
      name: 'Cash A CK',
      business: orgA,
    });
    await engine.models.Account.create({
      accountTypeCode: '1000',
      accountNumber: 'CK-B',
      name: 'Cash B CK',
      business: orgB,
    });

    // ctx under the configured contextKey — must scope.
    const scopedA = await engine.repositories.accounts.findAll(
      {} as never,
      { businessId: orgA } as never,
    );
    expect(scopedA.length).toBe(1);
    expect((scopedA[0] as { name: string }).name).toBe('Cash A CK');

    // ctx under the WRONG key — plugin can't find tenant; with required: true
    // it must throw, proving the contextKey rename is what's being read.
    await expect(
      engine.repositories.accounts.findAll(
        {} as never,
        { organizationId: orgA } as never,
      ),
    ).rejects.toThrow();
  });
});

// ── Scenario 4: arc drop-in structural test ─────────────────────────────────

describe('0.9.0 — arc EventTransport structural compatibility', () => {
  it('accepts a minimal arc-shaped transport without adapter', async () => {
    // This object matches @classytic/arc's MemoryEventTransport interface
    // by STRUCTURE only — no import from arc. If arc's EventTransport
    // ever changes shape, this test will fail at compile time (and at
    // runtime, the subscribe/publish wiring will break).
    const handlers: Array<(e: DomainEvent) => void | Promise<void>> = [];
    const arcLike: EventTransport = {
      name: 'test-arc-shaped',
      publish: async (e) => {
        for (const h of handlers) await h(e);
      },
      subscribe: async (_p, h) => {
        handlers.push(h);
        return () => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    };

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      eventTransport: arcLike,
    });
    await engine.models.Account.createIndexes();

    expect(engine.events).toBe(arcLike);
    await engine.repositories.accounts.seedAccounts(null);
    expect(handlers.length).toBe(0); // nothing subscribed yet
  });
});
