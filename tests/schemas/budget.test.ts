import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createBudgetSchema } from '../../src/schemas/budget.schema.js';
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
      code: '6000',
      name: 'Rent Expense',
      category: 'Income Statement-Expense',
      description: 'Rent',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

// ── Multi-tenant config ──────────────────────────────────────────────────────

const mtConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
  multiTenant: { tenantField: 'business', ref: 'Business' },
};

// ── Single-tenant config ─────────────────────────────────────────────────────

const stConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
};

let mongod: MongoMemoryServer;

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

describe('Budget Schema', () => {
  it('creates schema with valid data', async () => {
    const schema = createBudgetSchema(stConfig);
    if (mongoose.models.BudgetValid) delete mongoose.models.BudgetValid;
    const Model = mongoose.model('BudgetValid', schema);

    const accountId = new mongoose.Types.ObjectId();
    const doc = new Model({
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-03-31'),
      amount: 500000,
      label: 'Q1 Budget',
    });

    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('validates periodEnd > periodStart', async () => {
    const schema = createBudgetSchema(stConfig);
    if (mongoose.models.BudgetDateVal) delete mongoose.models.BudgetDateVal;
    const Model = mongoose.model('BudgetDateVal', schema);

    const accountId = new mongoose.Types.ObjectId();

    // periodEnd before periodStart
    const invalid = new Model({
      account: accountId,
      periodStart: new Date('2025-03-31'),
      periodEnd: new Date('2025-01-01'),
      amount: 100000,
    });
    await expect(invalid.validate()).rejects.toThrow(/periodEnd must be after periodStart/);

    // periodEnd equal to periodStart
    const equal = new Model({
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-01-01'),
      amount: 100000,
    });
    await expect(equal.validate()).rejects.toThrow(/periodEnd must be after periodStart/);
  });

  it('validates amount is integer', async () => {
    const schema = createBudgetSchema(stConfig);
    if (mongoose.models.BudgetIntVal) delete mongoose.models.BudgetIntVal;
    const Model = mongoose.model('BudgetIntVal', schema);

    const accountId = new mongoose.Types.ObjectId();
    const fractional = new Model({
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-03-31'),
      amount: 100.5,
    });
    await expect(fractional.validate()).rejects.toThrow(/amount must be an integer/);

    // Negative integer should be allowed
    const negative = new Model({
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-03-31'),
      amount: -50000,
    });
    await expect(negative.validate()).resolves.toBeUndefined();
  });

  it('unique index prevents duplicate [account, periodStart, periodEnd]', async () => {
    const schema = createBudgetSchema(stConfig);
    if (mongoose.models.BudgetUniq) delete mongoose.models.BudgetUniq;
    const Model = mongoose.model('BudgetUniq', schema);
    await Model.createIndexes();

    const accountId = new mongoose.Types.ObjectId();
    const data = {
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-03-31'),
      amount: 100000,
    };

    await Model.create(data);

    // Duplicate should fail
    await expect(Model.create(data)).rejects.toThrow();

    // Different period should succeed
    await expect(
      Model.create({
        ...data,
        periodStart: new Date('2025-04-01'),
        periodEnd: new Date('2025-06-30'),
      }),
    ).resolves.toBeDefined();
  });

  it('org field added when multi-tenant configured', () => {
    const schema = createBudgetSchema(mtConfig);
    expect(schema.path('business')).toBeDefined();
    expect(schema.path('account')).toBeDefined();
    expect(schema.path('amount')).toBeDefined();
  });

  it('org field not present in single-tenant mode', () => {
    const schema = createBudgetSchema(stConfig);
    expect(schema.path('business')).toBeUndefined();
    expect(schema.path('account')).toBeDefined();
  });

  it('allows duplicate [account, period] across different orgs in multi-tenant mode', async () => {
    const schema = createBudgetSchema(mtConfig);
    if (mongoose.models.BudgetMTUniq) delete mongoose.models.BudgetMTUniq;
    const Model = mongoose.model('BudgetMTUniq', schema);
    await Model.createIndexes();

    const accountId = new mongoose.Types.ObjectId();
    const org1 = new mongoose.Types.ObjectId();
    const org2 = new mongoose.Types.ObjectId();

    const data = {
      account: accountId,
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-03-31'),
      amount: 100000,
    };

    await Model.create({ ...data, business: org1 });

    // Same org should fail
    await expect(Model.create({ ...data, business: org1 })).rejects.toThrow();

    // Different org should succeed
    await expect(Model.create({ ...data, business: org2 })).resolves.toBeDefined();
  });
});
