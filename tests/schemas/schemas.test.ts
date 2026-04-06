import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createFiscalPeriodSchema } from '../../src/schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

// Minimal country pack for testing
const testPack = defineCountryPack({
  code: 'TEST',
  name: 'Test Country',
  defaultCurrency: 'TST',
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: 'Cash',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '2000',
      name: 'Payables',
      category: 'Balance Sheet-Liability',
      description: 'AP',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '8000',
      name: 'Revenue',
      category: 'Income Statement-Income',
      description: 'Sales',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '9000',
      name: 'Expenses',
      category: 'Income Statement-Expense',
      description: 'Costs',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: 'GROUP',
      name: 'Assets',
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

let mongod: MongoMemoryServer;

// ── Multi-tenant config ──────────────────────────────────────────────────────

const mtConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
  multiTenant: { orgField: 'business', orgRef: 'Business' },
};

// ── Single-tenant config ─────────────────────────────────────────────────────

const stConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

describe('Account Schema', () => {
  it('creates multi-tenant schema with org field', () => {
    const schema = createAccountSchema(mtConfig);
    expect(schema.path('business')).toBeDefined();
    expect(schema.path('accountTypeCode')).toBeDefined();
    expect(schema.path('active')).toBeDefined();
  });

  it('creates single-tenant schema without org field', () => {
    const schema = createAccountSchema(stConfig);
    expect(schema.path('business')).toBeUndefined();
    expect(schema.path('accountTypeCode')).toBeDefined();
  });

  it('validates accountTypeCode against country pack', async () => {
    const schema = createAccountSchema(stConfig);
    // Clear any previous model registrations for this test
    if (mongoose.models.TestAccount) delete mongoose.models.TestAccount;
    const Model = mongoose.model('TestAccount', schema);

    // Valid code
    const valid = new Model({ accountTypeCode: '1000' });
    await expect(valid.validate()).resolves.toBeUndefined();

    // Invalid code
    const invalid = new Model({ accountTypeCode: 'NONEXISTENT' });
    await expect(invalid.validate()).rejects.toThrow();
  });

  it('enforces unique accountTypeCode per org in multi-tenant mode', async () => {
    const schema = createAccountSchema(mtConfig);
    if (mongoose.models.MTAccount) delete mongoose.models.MTAccount;
    const Model = mongoose.model('MTAccount', schema);
    await Model.createIndexes();

    const orgId = new mongoose.Types.ObjectId();
    await Model.create({ business: orgId, accountTypeCode: '1000' });

    // Duplicate should fail
    await expect(Model.create({ business: orgId, accountTypeCode: '1000' })).rejects.toThrow();

    // Different org should succeed
    const otherOrg = new mongoose.Types.ObjectId();
    await expect(
      Model.create({ business: otherOrg, accountTypeCode: '1000' }),
    ).resolves.toBeDefined();
  });
});

describe('Journal Entry Schema', () => {
  it('creates schema with journal items', () => {
    const schema = createJournalEntrySchema(mtConfig, 'MTAccount');
    expect(schema.path('journalType')).toBeDefined();
    expect(schema.path('journalItems')).toBeDefined();
    expect(schema.path('state')).toBeDefined();
    expect(schema.path('totalDebit')).toBeDefined();
    expect(schema.path('totalCredit')).toBeDefined();
    expect(schema.path('business')).toBeDefined();
  });

  it('enforces double-entry on posted entries', async () => {
    const accountSchema = createAccountSchema(mtConfig);
    if (mongoose.models.JEAccount) delete mongoose.models.JEAccount;
    const AccountModel = mongoose.model('JEAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(mtConfig, 'JEAccount');
    if (mongoose.models.JE) delete mongoose.models.JE;
    const JEModel = mongoose.model('JE', jeSchema);

    const orgId = new mongoose.Types.ObjectId();
    const acc1 = await AccountModel.create({ business: orgId, accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ business: orgId, accountTypeCode: '8000' });

    // Balanced posted entry should pass
    const balanced = new JEModel({
      business: orgId,
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });
    await expect(balanced.validate()).resolves.toBeUndefined();

    // Unbalanced posted entry should fail
    const unbalanced = new JEModel({
      business: orgId,
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 10000,
      totalCredit: 5000,
    });
    await expect(unbalanced.validate()).rejects.toThrow('Total debit must equal total credit');
  });

  it('rejects journal items with both debit and credit > 0', async () => {
    const accountSchema = createAccountSchema(mtConfig);
    if (mongoose.models.DualAccount) delete mongoose.models.DualAccount;
    const AccountModel = mongoose.model('DualAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(mtConfig, 'DualAccount');
    if (mongoose.models.DualJE) delete mongoose.models.DualJE;
    const JEModel = mongoose.model('DualJE', jeSchema);

    const orgId = new mongoose.Types.ObjectId();
    const acc1 = await AccountModel.create({ business: orgId, accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ business: orgId, accountTypeCode: '8000' });

    const dual = new JEModel({
      business: orgId,
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 5000 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });
    await expect(dual.validate()).rejects.toThrow('cannot have both debit');
  });

  it('rejects non-integer journal item amounts', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.PrecAccount) delete mongoose.models.PrecAccount;
    const AccountModel = mongoose.model('PrecAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'PrecAccount');
    if (mongoose.models.PrecJE) delete mongoose.models.PrecJE;
    const JEModel = mongoose.model('PrecJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const fractional = new JEModel({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date(),
      journalItems: [
        { account: acc1._id, debit: 100.5, credit: 0 },
        { account: acc2._id, debit: 0, credit: 100.5 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });
    await expect(fractional.validate()).rejects.toThrow('must be a non-negative integer');
  });

  it('allows unbalanced drafts', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.DraftAccount) delete mongoose.models.DraftAccount;
    const AccountModel = mongoose.model('DraftAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'DraftAccount');
    if (mongoose.models.DraftJE) delete mongoose.models.DraftJE;
    const JEModel = mongoose.model('DraftJE', jeSchema);

    const acc = await AccountModel.create({ accountTypeCode: '1000' });

    const draft = new JEModel({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date(),
      journalItems: [{ account: acc._id, debit: 10000, credit: 0 }],
      totalDebit: 10000,
      totalCredit: 0,
    });
    // Draft should not throw on imbalance
    await expect(draft.validate()).resolves.toBeUndefined();
  });

  it('auto-generates reference numbers on save', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.RefAccount) delete mongoose.models.RefAccount;
    const AccountModel = mongoose.model('RefAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'RefAccount');
    if (mongoose.models.RefJE) delete mongoose.models.RefJE;
    const JEModel = mongoose.model('RefJE', jeSchema);
    await JEModel.createIndexes();

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const entry = await JEModel.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-03-15'),
      journalItems: [
        { account: acc1._id, debit: 50000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 50000 },
      ],
      totalDebit: 50000,
      totalCredit: 50000,
    });

    expect(entry.referenceNumber).toMatch(/^SALES\/2025\/03\/0001$/);

    // Second entry increments sequence
    const entry2 = await JEModel.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2025-03-20'),
      journalItems: [
        { account: acc1._id, debit: 20000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 20000 },
      ],
      totalDebit: 20000,
      totalCredit: 20000,
    });

    expect(entry2.referenceNumber).toMatch(/^SALES\/2025\/03\/0002$/);
  });
});

describe('Fiscal Period Schema', () => {
  it('creates schema with required fields', () => {
    const schema = createFiscalPeriodSchema(mtConfig);
    expect(schema.path('name')).toBeDefined();
    expect(schema.path('startDate')).toBeDefined();
    expect(schema.path('endDate')).toBeDefined();
    expect(schema.path('closed')).toBeDefined();
    expect(schema.path('business')).toBeDefined();
  });

  it('defaults closed to false', async () => {
    const schema = createFiscalPeriodSchema(stConfig);
    if (mongoose.models.FP) delete mongoose.models.FP;
    const FPModel = mongoose.model('FP', schema);

    const fp = await FPModel.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    expect(fp.closed).toBe(false);
  });

  it('rejects overlapping fiscal periods (single-tenant)', async () => {
    const schema = createFiscalPeriodSchema(stConfig);
    if (mongoose.models.FPOverlap) delete mongoose.models.FPOverlap;
    const FPModel = mongoose.model('FPOverlap', schema);
    await FPModel.createIndexes();

    // Create Q1
    await FPModel.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    // Overlapping period should fail
    await expect(
      FPModel.create({
        name: 'Jan-Feb 2025',
        startDate: new Date('2025-01-15'),
        endDate: new Date('2025-02-28'),
      }),
    ).rejects.toThrow(/overlaps/i);
  });

  it('allows non-overlapping fiscal periods', async () => {
    const schema = createFiscalPeriodSchema(stConfig);
    if (mongoose.models.FPNoOverlap) delete mongoose.models.FPNoOverlap;
    const FPModel = mongoose.model('FPNoOverlap', schema);
    await FPModel.createIndexes();

    await FPModel.create({
      name: 'Q1 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    // Q2 starts after Q1 ends — should succeed
    await expect(
      FPModel.create({
        name: 'Q2 2025',
        startDate: new Date('2025-04-01'),
        endDate: new Date('2025-06-30'),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects overlapping fiscal periods within same tenant (multi-tenant)', async () => {
    const schema = createFiscalPeriodSchema(mtConfig);
    if (mongoose.models.FPMTOverlap) delete mongoose.models.FPMTOverlap;
    const FPModel = mongoose.model('FPMTOverlap', schema);
    await FPModel.createIndexes();

    const org1 = new mongoose.Types.ObjectId();
    const org2 = new mongoose.Types.ObjectId();

    await FPModel.create({
      name: 'Q1 2025',
      business: org1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-03-31'),
    });

    // Same org, overlapping — should fail
    await expect(
      FPModel.create({
        name: 'Jan 2025',
        business: org1,
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-31'),
      }),
    ).rejects.toThrow(/overlaps/i);

    // Different org, same dates — should succeed
    await expect(
      FPModel.create({
        name: 'Q1 2025',
        business: org2,
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-03-31'),
      }),
    ).resolves.toBeDefined();
  });
});
