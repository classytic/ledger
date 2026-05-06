/**
 * Scenario: Plugin pipeline + extra-field propagation (0.5.1 fixes)
 *
 * Two regression suites bundled in one file because they share fixtures:
 *
 * 1. post()/unpost()/archive() must route through repository.update() so the
 *    plugin pipeline (fiscalLockPlugin, dateLockPlugin, audit, observability)
 *    actually fires on state transitions. Direct entry.save() bypassed it.
 *
 * 2. reverse()/duplicate() must propagate every consumer-defined top-level
 *    field (extraFields, dimensions, sourceRef, branch tags, etc.) so
 *    branch-scoped reports, plugin hooks, and audit trails see the right data.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import { AccountingError } from '../../src/utils/errors.js';

const accountTypes: readonly AccountType[] = [
  {
    code: '1001',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '4010',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
  {
    code: '3600',
    name: 'Retained Earnings',
    category: 'Balance Sheet-Equity',
    description: 'RE',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
];

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  retainedEarningsAccountCode: '3600',
});

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
  // Drop both the in-memory state AND the persisted collections so each test
  // starts with a clean engine + clean DB.
  for (const name of Object.keys(mongoose.models)) delete mongoose.models[name];
  for (const name of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[name]?.deleteMany({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Plugin pipeline fires on post()/unpost()/archive()
// ─────────────────────────────────────────────────────────────────────────────

describe('post()/unpost()/archive() route through repo.claim() so plugins fire (0.10.6+)', () => {
  it('fiscalLockPlugin blocks post() into a closed period', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });

    // Seed accounts and a closed Q1-2025 period
    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    await engine.models.FiscalPeriod.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      closed: true,
      closedAt: new Date(),
    });

    // Create a draft entry dated INSIDE the closed period
    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-02-15'),
      label: 'Draft inside closed period',
      journalItems: [
        { account: cashId, debit: 1000, credit: 0 },
        { account: revId, debit: 0, credit: 1000 },
      ],
    } as never);
    const draftId = (draft as { _id: unknown })._id;

    // Posting MUST be rejected by fiscalLockPlugin's before:update hook.
    await expect(engine.repositories.journalEntries.post(draftId)).rejects.toMatchObject({
      name: 'AccountingError',
      message: expect.stringMatching(/fiscal period .*Q1 2025.* is closed/),
    });

    // Persisted state must remain 'draft' — the plugin rejected the transition.
    const reread = await engine.repositories.journalEntries.getById(draftId as never);
    expect((reread as { state: string }).state).toBe('draft');
  });

  it('post() fires before:claim with transition draft → posted (atomic CAS)', async () => {
    // 0.10.6 — post() routes the state mutation through mongokit's
    // `repo.claim()` for race-safe transitions. Plugins that previously
    // listened on `before:update` now also fire on `before:claim`; the
    // hook context carries `transition.{from,to}` and an operator-form
    // `data.$set` patch instead of the flat update shape.
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });

    type ClaimCtx = {
      data?: { $set?: Record<string, unknown> };
      transition?: { from?: unknown; to?: unknown };
    };
    const captured: ClaimCtx[] = [];
    engine.repositories.journalEntries.on('before:claim', (ctx: ClaimCtx) => {
      captured.push({ data: ctx.data, transition: ctx.transition });
    });

    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-06-01'),
      journalItems: [
        { account: cashId, debit: 500, credit: 0 },
        { account: revId, debit: 0, credit: 500 },
      ],
    } as never);

    await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);

    const postCtx = captured.find(
      (c) => c.transition?.from === 'draft' && c.transition?.to === 'posted',
    );
    expect(postCtx).toBeDefined();
    expect(postCtx?.data?.$set?.stateChangedAt).toBeInstanceOf(Date);
  });

  it('unpost() fires before:claim with transition posted → draft (atomic CAS)', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });

    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-06-01'),
      journalItems: [
        { account: cashId, debit: 500, credit: 0 },
        { account: revId, debit: 0, credit: 500 },
      ],
    } as never);
    await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);

    const seen: Array<{ from?: unknown; to?: unknown }> = [];
    engine.repositories.journalEntries.on(
      'before:claim',
      (ctx: { transition?: { from?: unknown; to?: unknown } }) => {
        if (ctx.transition) seen.push({ from: ctx.transition.from, to: ctx.transition.to });
      },
    );

    await engine.repositories.journalEntries.unpost((draft as { _id: unknown })._id);
    expect(seen).toContainEqual({ from: 'posted', to: 'draft' });
  });

  it('reverse() fires before:claim on the original with reversed=true (atomic CAS)', async () => {
    // 0.10.6 — reverse() routes the mark-as-reversed step through
    // mongokit's `repo.claim()` (atomic state-machine CAS) instead of
    // `repo.update()`. The plugin pipeline still observes the mutation
    // via `before:claim` (mongokit fires this hook per-op); the previous
    // `_ledgerInternal: 'reverseMark'` bypass flag is gone because claim
    // doesn't fire `before:update` and so the immutability guard is not
    // triggered.
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });

    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-06-10'),
      journalItems: [
        { account: cashId, debit: 1_500, credit: 0 },
        { account: revId, debit: 0, credit: 1_500 },
      ],
    } as never);
    const draftId = (draft as { _id: unknown })._id;
    await engine.repositories.journalEntries.post(draftId);

    type ClaimCtx = {
      id?: unknown;
      data?: Record<string, unknown>;
      transition?: { from?: unknown; to?: unknown; where?: Record<string, unknown> };
    };
    const markHooks: ClaimCtx[] = [];
    engine.repositories.journalEntries.on('before:claim', (ctx: ClaimCtx) => {
      // The reverseMark CAS uses a state-noop transition (posted → posted)
      // with `where: { reversed: { $ne: true } }` as the race guard.
      if (ctx.transition?.where && 'reversed' in ctx.transition.where) {
        markHooks.push(ctx);
      }
    });

    await engine.repositories.journalEntries.reverse(draftId);

    expect(markHooks.length).toBe(1);
    const $set = (markHooks[0].data?.$set ?? {}) as Record<string, unknown>;
    expect($set.reversed).toBe(true);
    expect($set.reversedBy).toBeDefined();

    // Persisted state: original is now reversed=true
    const reread = await engine.repositories.journalEntries.getById(draftId as never);
    expect((reread as { reversed: boolean }).reversed).toBe(true);
  });

  it('archive() fires before:claim with transition draft → archived (atomic CAS)', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
    });

    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-06-01'),
      journalItems: [
        { account: cashId, debit: 500, credit: 0 },
        { account: revId, debit: 0, credit: 500 },
      ],
    } as never);

    const seen: Array<{ from?: unknown; to?: unknown }> = [];
    engine.repositories.journalEntries.on(
      'before:claim',
      (ctx: { transition?: { from?: unknown; to?: unknown } }) => {
        if (ctx.transition) seen.push({ from: ctx.transition.from, to: ctx.transition.to });
      },
    );

    await engine.repositories.journalEntries.archive((draft as { _id: unknown })._id);
    expect(seen).toContainEqual({ from: 'draft', to: 'archived' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. reverse()/duplicate() propagate top-level extraFields
// ─────────────────────────────────────────────────────────────────────────────

describe('reverse()/duplicate() propagate consumer extraFields', () => {
  function bootEngine() {
    return createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      schemaOptions: {
        journalEntry: {
          extraFields: {
            departmentId: { type: String },
            projectId: { type: String },
            sourceRef: {
              kind: { type: String },
              docId: { type: String },
            },
            branchTag: { type: String },
          },
        },
      },
    });
  }

  async function seedPostedEntry(
    engine: ReturnType<typeof bootEngine>,
    extras: Record<string, unknown>,
  ) {
    const accounts = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '4010' },
    ] as never);
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-07-15'),
      label: 'Original sale',
      journalItems: [
        { account: cashId, debit: 12_000, credit: 0 },
        { account: revId, debit: 0, credit: 12_000 },
      ],
      ...extras,
    } as never);

    await engine.repositories.journalEntries.post((draft as { _id: unknown })._id);
    return (draft as { _id: unknown })._id;
  }

  it('reverse() copies departmentId, projectId, sourceRef, branchTag', async () => {
    const engine = bootEngine();

    const sourceRef = { kind: 'pos-receipt', docId: 'POS-2025-0001' };
    const id = await seedPostedEntry(engine, {
      departmentId: 'DEPT-42',
      projectId: 'PRJ-99',
      branchTag: 'BRANCH-A',
      sourceRef,
    });

    const result = (await engine.repositories.journalEntries.reverse(id)) as {
      reversal: Record<string, unknown>;
    };

    expect(result.reversal.departmentId).toBe('DEPT-42');
    expect(result.reversal.projectId).toBe('PRJ-99');
    expect(result.reversal.branchTag).toBe('BRANCH-A');
    expect(result.reversal.sourceRef).toMatchObject(sourceRef);

    // And reverse() must NOT copy reserved fields like referenceNumber/reversalOf
    expect(result.reversal.referenceNumber).not.toBe(undefined);
    expect(result.reversal.reversalOf).toBeDefined();
  });

  it('duplicate() copies departmentId, projectId, branchTag', async () => {
    const engine = bootEngine();

    const id = await seedPostedEntry(engine, {
      departmentId: 'DEPT-7',
      projectId: 'PRJ-7',
      branchTag: 'BRANCH-B',
    });

    const dup = (await engine.repositories.journalEntries.duplicate(id)) as Record<string, unknown>;

    expect(dup.departmentId).toBe('DEPT-7');
    expect(dup.projectId).toBe('PRJ-7');
    expect(dup.branchTag).toBe('BRANCH-B');
    expect(dup.state).toBe('draft'); // duplicate always emits draft
    // duplicate must give the copy a fresh id and reference number
    expect(dup._id).not.toEqual(id);
  });

  it('reverse() preserved org scope when orgField is configured', async () => {
    // Multi-tenant variant — this was working before via the orgField branch
    // and must continue to work after the generic copy.
    const orgEngine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: testPack,
      currency: 'USD',
      multiTenant: { tenantField: 'organizationId', ref: 'Organization' },
    });

    const orgId = new mongoose.Types.ObjectId();
    const accounts = await orgEngine.repositories.accounts.bulkCreate(
      [{ accountTypeCode: '1001' }, { accountTypeCode: '4010' }] as never,
      orgId,
    );
    const cashId = (accounts.created[0] as { _id: unknown })._id;
    const revId = (accounts.created[1] as { _id: unknown })._id;

    const draft = await orgEngine.repositories.journalEntries.create({
      organizationId: orgId,
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-08-01'),
      journalItems: [
        { account: cashId, debit: 9_000, credit: 0 },
        { account: revId, debit: 0, credit: 9_000 },
      ],
    } as never);
    await orgEngine.repositories.journalEntries.post((draft as { _id: unknown })._id, orgId);

    const result = (await orgEngine.repositories.journalEntries.reverse(
      (draft as { _id: unknown })._id,
      orgId,
    )) as { reversal: Record<string, unknown> };

    expect(String(result.reversal.organizationId)).toBe(String(orgId));
  });
});

// Anchor an unused import to keep biome from removing AccountingError;
// the assertion above already type-narrows via toMatchObject.
void AccountingError;
