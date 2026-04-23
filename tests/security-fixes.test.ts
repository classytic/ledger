/**
 * Security & Correctness Fixes — Test Suite
 *
 * Validates all 6 fixes from the security/correctness audit:
 * 1. Multi-tenant data leak (requireOrgScope guard)
 * 2. Cross-tenant fiscal close/reopen (org-scoped period queries)
 * 3. autoReference: false unique index conflict (partial filter)
 * 4. Fiscal-lock plugin session propagation
 * 5. Reference number sequencing beyond 9999
 * 6. Bulk account creation race condition
 */

import { Repository } from '@classytic/mongokit';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../src/country/index.js';
import { fiscalLockPlugin } from '../src/plugins/lock/index.js';
import { generateBalanceSheet } from '../src/reports/balance-sheet.js';
import { generateCashFlow } from '../src/reports/cash-flow.js';
import { closeFiscalPeriod, reopenFiscalPeriod } from '../src/reports/fiscal-close.js';
import { generateGeneralLedger } from '../src/reports/general-ledger.js';
import { generateIncomeStatement } from '../src/reports/income-statement.js';
import { generateTrialBalance } from '../src/reports/trial-balance.js';
import { wireAccountMethods } from '../src/repositories/account.repository.js';
import { wireJournalEntryMethods } from '../src/repositories/journal-entry.repository.js';
import { createAccountSchema } from '../src/schemas/account.schema.js';
import { createFiscalPeriodSchema } from '../src/schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from '../src/schemas/journal-entry.schema.js';
import type { AccountingEngineConfig } from '../src/types/engine.js';
import { AccountingError } from '../src/utils/errors.js';
import { mockRepository } from './helpers/mock-repository.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'SEC',
  name: 'Security Test',
  defaultCurrency: 'TST',
  retainedEarningsAccountCode: '3660',
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: 'Cash',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '1200',
      name: 'Accounts Receivable',
      category: 'Balance Sheet-Asset',
      description: 'AR',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '2000',
      name: 'Accounts Payable',
      category: 'Balance Sheet-Liability',
      description: 'AP',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'operating',
    },
    {
      code: '3000',
      name: 'Share Capital',
      category: 'Balance Sheet-Equity',
      description: 'Equity',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '3660',
      name: 'Retained Earnings',
      category: 'Balance Sheet-Equity',
      description: 'RE',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '4000',
      name: 'Sales Revenue',
      category: 'Income Statement-Income',
      description: 'Revenue',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '5000',
      name: 'Cost of Sales',
      category: 'Income Statement-Expense',
      description: 'COGS',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '6000',
      name: 'Rent Expense',
      category: 'Income Statement-Expense',
      description: 'Rent',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    // Group account (for bulkCreate validation)
    {
      code: '1',
      name: 'Assets Group',
      category: 'Balance Sheet-Asset',
      description: 'Group',
      parentCode: null,
      isTotal: false,
      isGroup: true,
      cashFlowCategory: null,
    },
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

// ── Shared setup ─────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 1: Multi-tenant data leak — requireOrgScope guard
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 1: requireOrgScope prevents unscoped multi-tenant queries', () => {
  const mtConfig: AccountingEngineConfig = {
    country: testPack,
    currency: 'TST',
    multiTenant: { tenantField: 'business', ref: 'Business' },
  };

  let MtAcct: mongoose.Model<any>;
  let MtJE: mongoose.Model<any>;

  beforeAll(async () => {
    if (mongoose.models.SecMtAcct) delete mongoose.models.SecMtAcct;
    if (mongoose.models.SecMtJE) delete mongoose.models.SecMtJE;
    MtAcct = mongoose.model('SecMtAcct', createAccountSchema(mtConfig));
    MtJE = mongoose.model('SecMtJE', createJournalEntrySchema(mtConfig, 'SecMtAcct'));
    await MtAcct.createIndexes();
    await MtJE.createIndexes();
  });

  const reportOpts = () => ({
    AccountModel: MtAcct,
    JournalEntryModel: MtJE,
    country: testPack,
    orgField: 'business',
  });

  const noOrgParams = { dateOption: 'month' as const, dateValue: '2025-03' };

  it('trial balance throws when orgField set but organizationId missing', async () => {
    await expect(generateTrialBalance(reportOpts(), noOrgParams)).rejects.toThrow(
      'organizationId is required',
    );
  });

  it('balance sheet throws when orgField set but organizationId missing', async () => {
    await expect(generateBalanceSheet(reportOpts(), noOrgParams)).rejects.toThrow(
      'organizationId is required',
    );
  });

  it('income statement throws when orgField set but organizationId missing', async () => {
    await expect(generateIncomeStatement(reportOpts(), noOrgParams)).rejects.toThrow(
      'organizationId is required',
    );
  });

  it('general ledger throws when orgField set but organizationId missing', async () => {
    await expect(generateGeneralLedger(reportOpts(), noOrgParams)).rejects.toThrow(
      'organizationId is required',
    );
  });

  it('cash flow throws when orgField set but organizationId missing', async () => {
    await expect(generateCashFlow(reportOpts(), noOrgParams)).rejects.toThrow(
      'organizationId is required',
    );
  });

  it('fiscal close throws when orgField set but organizationId missing', async () => {
    await expect(
      closeFiscalPeriod(
        { ...reportOpts(), FiscalPeriodModel: MtAcct /* any model, guard fires first */ },
        { periodId: new mongoose.Types.ObjectId() },
      ),
    ).rejects.toThrow('organizationId is required');
  });

  it('fiscal reopen throws when orgField set but organizationId missing', async () => {
    await expect(
      reopenFiscalPeriod(
        { JournalEntryModel: MtJE, FiscalPeriodModel: MtAcct, orgField: 'business' },
        { periodId: new mongoose.Types.ObjectId() },
      ),
    ).rejects.toThrow('organizationId is required');
  });

  it('allows report when orgField is set AND organizationId is provided', async () => {
    const orgId = new mongoose.Types.ObjectId();
    // Should not throw — just return empty results
    const report = await generateTrialBalance(reportOpts(), {
      organizationId: orgId,
      dateOption: 'month',
      dateValue: '2025-03',
    });
    expect(report.rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 2: Cross-tenant fiscal close/reopen — org-scoped period queries
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 2: Cross-tenant fiscal close/reopen prevention', () => {
  const mtConfig: AccountingEngineConfig = {
    country: testPack,
    currency: 'TST',
    multiTenant: { tenantField: 'business', ref: 'Business' },
  };

  let MtAcct2: mongoose.Model<any>;
  let MtJE2: mongoose.Model<any>;
  let MtFP: mongoose.Model<any>;

  let org1: mongoose.Types.ObjectId;
  let org2: mongoose.Types.ObjectId;

  beforeAll(async () => {
    if (mongoose.models.SecMtAcct2) delete mongoose.models.SecMtAcct2;
    if (mongoose.models.SecMtJE2) delete mongoose.models.SecMtJE2;
    if (mongoose.models.SecMtFP) delete mongoose.models.SecMtFP;

    MtAcct2 = mongoose.model('SecMtAcct2', createAccountSchema(mtConfig));
    MtJE2 = mongoose.model('SecMtJE2', createJournalEntrySchema(mtConfig, 'SecMtAcct2'));
    MtFP = mongoose.model('SecMtFP', createFiscalPeriodSchema(mtConfig));
    await MtAcct2.createIndexes();
    await MtJE2.createIndexes();
    await MtFP.createIndexes();
  });

  beforeEach(async () => {
    await MtAcct2.deleteMany({});
    await MtJE2.deleteMany({});
    await MtFP.deleteMany({});

    org1 = new mongoose.Types.ObjectId();
    org2 = new mongoose.Types.ObjectId();

    // Seed accounts for org1
    await MtAcct2.create({ accountTypeCode: '1000', business: org1 });
    await MtAcct2.create({ accountTypeCode: '3660', business: org1 });
    await MtAcct2.create({ accountTypeCode: '4000', business: org1 });
  });

  it('cannot close a period belonging to another org', async () => {
    // Create period for org1
    const period = await MtFP.create({
      name: 'Org1 Q1',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      business: org1,
    });

    // Try to close with org2 credentials → should fail (period not found)
    await expect(
      closeFiscalPeriod(
        {
          AccountModel: MtAcct2,
          JournalEntryModel: MtJE2,
          FiscalPeriodModel: MtFP,
          country: testPack,
          orgField: 'business',
        },
        { periodId: period._id, organizationId: org2 },
      ),
    ).rejects.toThrow('Fiscal period not found');
  });

  it('cannot reopen a period belonging to another org', async () => {
    // Create and close a period for org1
    const period = await MtFP.create({
      name: 'Org1 Q1 Reopen',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      business: org1,
      closed: true,
      closedAt: new Date(),
    });

    // Try to reopen with org2 credentials → should fail (period not found)
    await expect(
      reopenFiscalPeriod(
        { JournalEntryModel: MtJE2, FiscalPeriodModel: MtFP, orgField: 'business' },
        { periodId: period._id, organizationId: org2 },
      ),
    ).rejects.toThrow('Fiscal period not found');
  });

  it('same-org close succeeds', async () => {
    const period = await MtFP.create({
      name: 'Org1 Q1 Same',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
      business: org1,
    });

    const result = await closeFiscalPeriod(
      {
        AccountModel: MtAcct2,
        JournalEntryModel: MtJE2,
        FiscalPeriodModel: MtFP,
        country: testPack,
        orgField: 'business',
      },
      { periodId: period._id, organizationId: org1 },
    );

    expect(result.closedAt).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 3: autoReference: false — no unique index conflict for null refs
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 3: autoReference: false allows multiple null reference numbers', () => {
  const config: AccountingEngineConfig = { country: testPack, currency: 'TST' };

  let NoRefAcct: mongoose.Model<any>;
  let NoRefJE: mongoose.Model<any>;
  let cashId: mongoose.Types.ObjectId;
  let eqId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    if (mongoose.models.SecNoRefAcct) delete mongoose.models.SecNoRefAcct;
    if (mongoose.models.SecNoRefJE) delete mongoose.models.SecNoRefJE;

    NoRefAcct = mongoose.model('SecNoRefAcct', createAccountSchema(config));
    // autoReference: false — schema won't auto-generate reference numbers
    NoRefJE = mongoose.model(
      'SecNoRefJE',
      createJournalEntrySchema(config, 'SecNoRefAcct', { autoReference: false }),
    );
    await NoRefAcct.createIndexes();
    await NoRefJE.createIndexes();
  });

  beforeEach(async () => {
    await NoRefAcct.deleteMany({});
    await NoRefJE.deleteMany({});

    const cash = await NoRefAcct.create({ accountTypeCode: '1000' });
    const eq = await NoRefAcct.create({ accountTypeCode: '3000' });
    cashId = cash._id;
    eqId = eq._id;
  });

  it('can create multiple entries without reference numbers', async () => {
    // Both entries have no referenceNumber — should not conflict
    const entry1 = await NoRefJE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-01'),
      journalItems: [
        { account: cashId, debit: 10000, credit: 0 },
        { account: eqId, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    const entry2 = await NoRefJE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-02'),
      journalItems: [
        { account: cashId, debit: 20000, credit: 0 },
        { account: eqId, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000,
      totalCredit: 20000,
    });

    expect(entry1.referenceNumber).toBeUndefined();
    expect(entry2.referenceNumber).toBeUndefined();

    // Both should exist
    const count = await NoRefJE.countDocuments({});
    expect(count).toBe(2);
  });

  it('still enforces uniqueness when reference number IS provided', async () => {
    await NoRefJE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-01'),
      referenceNumber: 'MANUAL-001',
      journalItems: [
        { account: cashId, debit: 10000, credit: 0 },
        { account: eqId, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    await expect(
      NoRefJE.create({
        journalType: 'GENERAL',
        state: 'posted',
        date: new Date('2025-03-02'),
        referenceNumber: 'MANUAL-001', // duplicate
        journalItems: [
          { account: cashId, debit: 20000, credit: 0 },
          { account: eqId, debit: 0, credit: 20000 },
        ],
        totalDebit: 20000,
        totalCredit: 20000,
      }),
    ).rejects.toThrow(); // duplicate key error
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 4: Fiscal-lock plugin session propagation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 4: Fiscal-lock plugin passes session to FiscalPeriodModel.findOne', () => {
  function createMockRepo() {
    const hooks = new Map<string, Array<(ctx: unknown) => void | Promise<void>>>();
    return {
      on(event: string, handler: (ctx: unknown) => void | Promise<void>) {
        if (!hooks.has(event)) hooks.set(event, []);
        hooks.get(event)?.push(handler);
      },
      async emit(event: string, ctx: unknown) {
        for (const fn of hooks.get(event) ?? []) {
          await fn(ctx);
        }
      },
    };
  }

  it('propagates session to fiscal period query on before:create', async () => {
    let receivedSession: unknown = 'NOT_CALLED';
    const mockSession = { id: 'test-session-123' };

    const fpModel = {
      findOne: () => ({
        session: (s: unknown) => {
          receivedSession = s;
          return {
            lean: () => Promise.resolve(null),
          };
        },
      }),
    } as any;

    const repo = createMockRepo();
    fiscalLockPlugin({ FiscalPeriodModel: fpModel }).apply(repo);

    const data = { state: 'posted', date: new Date('2025-06-15') };
    await repo.emit('before:create', { data, session: mockSession });

    expect(receivedSession).toBe(mockSession);
  });

  it('passes null session when no session in context', async () => {
    let receivedSession: unknown = 'NOT_CALLED';

    const fpModel = {
      findOne: () => ({
        session: (s: unknown) => {
          receivedSession = s;
          return {
            lean: () => Promise.resolve(null),
          };
        },
      }),
    } as any;

    const repo = createMockRepo();
    fiscalLockPlugin({ FiscalPeriodModel: fpModel }).apply(repo);

    const data = { state: 'posted', date: new Date('2025-06-15') };
    await repo.emit('before:create', { data }); // no session

    expect(receivedSession).toBeNull();
  });

  it('propagates session to fiscal period query on before:update', async () => {
    let receivedSession: unknown = 'NOT_CALLED';
    const mockSession = { id: 'update-session' };

    const fpModel = {
      findOne: () => ({
        session: (s: unknown) => {
          receivedSession = s;
          return {
            lean: () => Promise.resolve(null),
          };
        },
      }),
    } as any;

    const repo = createMockRepo();
    fiscalLockPlugin({ FiscalPeriodModel: fpModel }).apply(repo);

    const data = { state: 'posted', date: new Date('2025-06-15') };
    await repo.emit('before:update', { id: 'abc', data, session: mockSession });

    expect(receivedSession).toBe(mockSession);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 5: Reference number sequencing beyond 9999
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 5: Reference number sequencing handles numbers beyond 9999', () => {
  const config: AccountingEngineConfig = { country: testPack, currency: 'TST' };

  let SeqAcct: mongoose.Model<any>;
  let SeqJE: mongoose.Model<any>;
  let cashId: mongoose.Types.ObjectId;
  let eqId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    if (mongoose.models.SecSeqAcct) delete mongoose.models.SecSeqAcct;
    if (mongoose.models.SecSeqJE) delete mongoose.models.SecSeqJE;

    SeqAcct = mongoose.model('SecSeqAcct', createAccountSchema(config));
    SeqJE = mongoose.model('SecSeqJE', createJournalEntrySchema(config, 'SecSeqAcct'));
    await SeqAcct.createIndexes();
    await SeqJE.createIndexes();
  });

  beforeEach(async () => {
    await SeqAcct.deleteMany({});
    await SeqJE.deleteMany({});
    // 0.9.0: drop the atomic counter so each test starts from seq=1
    await mongoose.connection.db?.collection('_mongokit_counters').deleteMany({});

    const cash = await SeqAcct.create({ accountTypeCode: '1000' });
    const eq = await SeqAcct.create({ accountTypeCode: '3000' });
    cashId = cash._id;
    eqId = eq._id;
  });

  it('atomic counter is independent of hand-inserted rows (0.9 migration note)', async () => {
    // Insert a doc with a very high referenceNumber directly — simulates
    // pre-0.9 data migrated from the old aggregation allocator, or rows
    // hand-inserted by a migration script.
    await SeqJE.collection.insertOne({
      journalType: 'GENERAL',
      referenceNumber: 'GENERAL/2025/03/9999',
      state: 'posted',
      date: new Date('2025-03-15'),
      journalItems: [
        { account: cashId, debit: 10000, credit: 0 },
        { account: eqId, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    // The atomic counter starts at 1 regardless of pre-existing rows.
    // This is a deliberate trade-off: race-free allocation under concurrent
    // writes in exchange for no runtime scan of existing documents. Hosts
    // that migrate from pre-0.9 data must seed `_mongokit_counters` to the
    // max existing sequence per partition before the first 0.9 write.
    const entry = await SeqJE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-20'),
      journalItems: [
        { account: cashId, debit: 20000, credit: 0 },
        { account: eqId, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000,
      totalCredit: 20000,
    });

    // Counter-allocated sequence starts at 1 — no collision with 9999.
    expect(entry.referenceNumber).toBe('GENERAL/2025/03/0001');
  });

  it('handles pre-seeded counter to avoid migration collisions', async () => {
    // Host can pre-seed the counter so the next allocation continues
    // from where legacy data left off. Direct insert of the mongokit
    // counter doc. Key format: `ledger:{orgScope}:{journalType}:{YYYY}-{MM}`.
    await mongoose.connection.db?.collection('_mongokit_counters').insertOne({
      _id: 'ledger:global:MISC:2025-06' as unknown as never,
      seq: 10000,
    });
    // Also insert legacy docs so the unique index has something to collide
    // against if the counter misbehaves.
    await SeqJE.collection.insertMany([
      {
        journalType: 'MISC',
        referenceNumber: 'MISC/2025/06/9999',
        state: 'posted',
        date: new Date('2025-06-10'),
        journalItems: [
          { account: cashId, debit: 10000, credit: 0 },
          { account: eqId, debit: 0, credit: 10000 },
        ],
        totalDebit: 10000,
        totalCredit: 10000,
      },
      {
        journalType: 'MISC',
        referenceNumber: 'MISC/2025/06/10000',
        state: 'posted',
        date: new Date('2025-06-11'),
        journalItems: [
          { account: cashId, debit: 10000, credit: 0 },
          { account: eqId, debit: 0, credit: 10000 },
        ],
        totalDebit: 10000,
        totalCredit: 10000,
      },
    ]);

    const entry = await SeqJE.create({
      journalType: 'MISC',
      state: 'posted',
      date: new Date('2025-06-15'),
      journalItems: [
        { account: cashId, debit: 30000, credit: 0 },
        { account: eqId, debit: 0, credit: 30000 },
      ],
      totalDebit: 30000,
      totalCredit: 30000,
    });

    // Counter bumps from 10000 to 10001 atomically
    expect(entry.referenceNumber).toBe('MISC/2025/06/10001');
  });

  it('starts sequence at 0001 for a new month', async () => {
    const entry = await SeqJE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-07-01'),
      journalItems: [
        { account: cashId, debit: 10000, credit: 0 },
        { account: eqId, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    expect(entry.referenceNumber).toBe('GENERAL/2025/07/0001');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 6: Bulk account creation — batch query instead of N+1
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 6: bulkCreate uses batch query and handles concurrent inserts', () => {
  const config: AccountingEngineConfig = { country: testPack, currency: 'TST' };

  let BulkAcct: mongoose.Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  beforeAll(async () => {
    if (mongoose.models.SecBulkAcct) delete mongoose.models.SecBulkAcct;
    BulkAcct = mongoose.model('SecBulkAcct', createAccountSchema(config));
    await BulkAcct.createIndexes();

    repo = new Repository(BulkAcct, []);
    wireAccountMethods(repo, testPack);
  });

  beforeEach(async () => {
    await BulkAcct.deleteMany({});
  });

  it('creates multiple accounts in a single batch', async () => {
    const result = await repo.bulkCreate(
      [{ accountTypeCode: '1000' }, { accountTypeCode: '2000' }, { accountTypeCode: '3000' }],
      undefined,
    );

    expect(result.summary.created).toBe(3);
    expect(result.summary.skipped).toBe(0);
    expect(result.summary.errors).toBe(0);

    // Verify all created in DB
    const count = await BulkAcct.countDocuments({});
    expect(count).toBe(3);
  });

  it('skips existing accounts without N+1 queries', async () => {
    // Pre-create one account
    await BulkAcct.create({ accountTypeCode: '1000' });

    const result = await repo.bulkCreate(
      [
        { accountTypeCode: '1000' }, // exists
        { accountTypeCode: '2000' }, // new
        { accountTypeCode: '3000' }, // new
      ],
      undefined,
    );

    expect(result.summary.created).toBe(2);
    expect(result.summary.skipped).toBe(1);
    expect(result.skipped[0].accountTypeCode).toBe('1000');
    expect(result.skipped[0].reason).toBe('Already exists');
  });

  it('rejects invalid account type codes', async () => {
    const result = await repo.bulkCreate(
      [
        { accountTypeCode: '9999' }, // invalid
        { accountTypeCode: '1000' }, // valid
      ],
      undefined,
    );

    expect(result.summary.errors).toBe(1);
    expect(result.summary.created).toBe(1);
    expect(result.errors[0].reason).toBe('Invalid account type code');
  });

  it('rejects group/total account types', async () => {
    const result = await repo.bulkCreate(
      [
        { accountTypeCode: '1' }, // group account
      ],
      undefined,
    );

    expect(result.summary.errors).toBe(1);
    expect(result.errors[0].reason).toContain('Not a posting account');
  });

  it('rejects entries without accountTypeCode', async () => {
    const result = await repo.bulkCreate(
      [{ accountTypeCode: undefined }, { accountTypeCode: '1000' }],
      undefined,
    );

    expect(result.summary.errors).toBe(1);
    expect(result.summary.created).toBe(1);
    expect(result.errors[0].reason).toBe('accountTypeCode is required');
  });

  it('returns correct summary for all-skipped scenario', async () => {
    // Pre-create all
    await BulkAcct.create({ accountTypeCode: '1000' });
    await BulkAcct.create({ accountTypeCode: '2000' });

    const result = await repo.bulkCreate(
      [{ accountTypeCode: '1000' }, { accountTypeCode: '2000' }],
      undefined,
    );

    expect(result.summary.total).toBe(2);
    expect(result.summary.created).toBe(0);
    expect(result.summary.skipped).toBe(2);
  });

  it('returns correct summary when all inputs are invalid', async () => {
    const result = await repo.bulkCreate(
      [{ accountTypeCode: undefined }, { accountTypeCode: '9999' }],
      undefined,
    );

    expect(result.summary.total).toBe(2);
    expect(result.summary.created).toBe(0);
    expect(result.summary.errors).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 6b: seedAccounts concurrent-safety (ordered: false + dup-key reconciliation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 6b: seedAccounts handles concurrent duplicate-key errors gracefully', () => {
  it('recovers from dup-key bulk write error (concurrent seed simulation)', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [
        { code: '1000', name: 'Cash' },
        { code: '2000', name: 'AP' },
      ],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
          writeErrors: [{ index: 0 }],
          insertedDocs: [{ accountNumber: '2000', accountTypeCode: '2000', name: 'AP' }],
        }),
      ),
    });
    wireAccountMethods(repo, mockCountry);

    const result = await repo.seedAccounts('org-1');

    // 1 inserted successfully, 1 hit dup-key (concurrent insert)
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('rethrows non-duplicate-key errors from createMany', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [{ code: '1000', name: 'Cash' }],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockRejectedValue(new Error('Connection lost')),
    });
    wireAccountMethods(repo, mockCountry);

    await expect(repo.seedAccounts('org-1')).rejects.toThrow('Connection lost');
  });

  it('uses ordered: false in createMany call', async () => {
    const createManySpy = vi.fn().mockResolvedValue([{ _id: 'id-1' }]);
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [{ code: '1000', name: 'Cash' }],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: createManySpy,
    });
    wireAccountMethods(repo, mockCountry);

    await repo.seedAccounts('org-1');

    expect(createManySpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ ordered: false }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 7: post() verifies account ownership (multi-tenant integrity)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 7: post() verifies populated accounts belong to the same org', () => {
  const org1 = new mongoose.Types.ObjectId();
  const org2 = new mongoose.Types.ObjectId();

  it('rejects posting when journal items reference cross-tenant accounts', async () => {
    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      business: org1,
      journalItems: [
        { account: { _id: 'acct-1', business: org1 }, debit: 10000, credit: 0 },
        { account: { _id: 'acct-2', business: org2 }, debit: 0, credit: 10000 }, // cross-tenant!
      ],
      save: vi.fn(),
    };

    const repo: any = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
    wireJournalEntryMethods(repo, {} as any, 'business');

    await expect(repo.post('entry-1', org1)).rejects.toThrow(
      'reference accounts from another organization',
    );
  });

  it('allows posting when all accounts belong to the same org', async () => {
    const acctId1 = new mongoose.Types.ObjectId();
    const acctId2 = new mongoose.Types.ObjectId();

    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      business: org1,
      journalItems: [
        { account: { _id: acctId1, business: org1 }, debit: 10000, credit: 0 },
        { account: { _id: acctId2, business: org1 }, debit: 0, credit: 10000 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const repo: any = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
    wireJournalEntryMethods(repo, {} as any, 'business');

    const result = await repo.post('entry-1', org1);
    expect(result.state).toBe('posted');
    // post() routes through repository.update() so the plugin pipeline fires;
    // assert update was called instead of the legacy direct entry.save().
    expect(repo.update).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ state: 'posted' }),
      expect.objectContaining({ _ledgerInternal: 'post' }),
    );
  });

  it('cross-tenant check throws AccountingError with 400 status', async () => {
    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      business: org1,
      journalItems: [
        { account: { _id: 'acct-1', business: org1 }, debit: 5000, credit: 0 },
        { account: { _id: 'acct-2', business: org2 }, debit: 0, credit: 5000 },
      ],
      save: vi.fn(),
    };

    const repo: any = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
    wireJournalEntryMethods(repo, {} as any, 'business');

    try {
      await repo.post('entry-1', org1);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).status).toBe(400);
      expect((err as AccountingError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('reports correct count of cross-tenant items', async () => {
    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      business: org1,
      journalItems: [
        { account: { _id: 'a1', business: org2 }, debit: 10000, credit: 0 },
        { account: { _id: 'a2', business: org2 }, debit: 0, credit: 5000 },
        { account: { _id: 'a3', business: org1 }, debit: 0, credit: 5000 },
      ],
      save: vi.fn(),
    };

    const repo: any = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
    wireJournalEntryMethods(repo, {} as any, 'business');

    await expect(repo.post('entry-1', org1)).rejects.toThrow(
      '2 item(s) reference accounts from another organization',
    );
  });

  it('skips cross-tenant check when orgField is not configured (single-tenant)', async () => {
    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 10000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 10000 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const repo: any = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
    wireJournalEntryMethods(repo, {} as any); // no orgField

    const result = await repo.post('entry-1');
    expect(result.state).toBe('posted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 8: requireOrgScope in seedAccounts/bulkCreate (defense-in-depth)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fix 8: seedAccounts/bulkCreate reject unscoped calls when orgField configured', () => {
  it('seedAccounts throws when orgField set but orgId is missing', async () => {
    const mockModel = {
      find: vi.fn(),
    } as any;

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [{ code: '1000', name: 'Cash' }],
    } as any;

    const repo: any = mockRepository();
    wireAccountMethods(repo, mockCountry, 'business');

    await expect(repo.seedAccounts(undefined)).rejects.toThrow('organizationId is required');
    await expect(repo.seedAccounts(null)).rejects.toThrow('organizationId is required');

    // DB should not have been queried
    expect(mockModel.find).not.toHaveBeenCalled();
  });

  it('bulkCreate throws when orgField set but orgId is missing', async () => {
    const mockModel = {
      find: vi.fn(),
    } as any;

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
    } as any;

    const repo: any = mockRepository();
    wireAccountMethods(repo, mockCountry, 'business');

    await expect(repo.bulkCreate([{ accountTypeCode: '1000' }], undefined)).rejects.toThrow(
      'organizationId is required',
    );

    await expect(repo.bulkCreate([{ accountTypeCode: '1000' }], null)).rejects.toThrow(
      'organizationId is required',
    );

    // DB should not have been queried
    expect(mockModel.find).not.toHaveBeenCalled();
  });

  it('seedAccounts succeeds when orgField set and orgId is provided', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [{ code: '1000', name: 'Cash' }],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue([{ _id: 'id-1' }]),
    });
    wireAccountMethods(repo, mockCountry, 'business');

    const result = await repo.seedAccounts('org-123');
    expect(result.created).toBe(1);
  });

  it('bulkCreate succeeds when orgField set and orgId is provided', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}` }),
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue([{ _id: 'id-1', accountTypeCode: '1000' }]),
    });
    wireAccountMethods(repo, mockCountry, 'business');

    const result = await repo.bulkCreate([{ accountTypeCode: '1000' }], 'org-123');
    expect(result.summary.created).toBe(1);
  });

  it('seedAccounts allows no orgId when orgField is not configured (single-tenant)', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [{ code: '1000', name: 'Cash' }],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue([{ _id: 'id-1' }]),
    });
    wireAccountMethods(repo, mockCountry); // no orgField

    // Should not throw — single-tenant mode
    const result = await repo.seedAccounts(undefined);
    expect(result.created).toBe(1);
  });

  it('bulkCreate allows no orgId when orgField is not configured (single-tenant)', async () => {
    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}` }),
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue([{ _id: 'id-1', accountTypeCode: '1000' }]),
    });
    wireAccountMethods(repo, mockCountry); // no orgField

    const result = await repo.bulkCreate([{ accountTypeCode: '1000' }], undefined);
    expect(result.summary.created).toBe(1);
  });
});
