import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createReconciliationSchema } from '../../src/schemas/reconciliation.schema.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Test',
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
  ],
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

const mtConfig: AccountingEngineConfig = {
  country: testPack,
  currency: 'TST',
  multiTenant: { orgField: 'business', orgRef: 'Business' },
};

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

describe('Reconciliation Schema', () => {
  it('creates schema with valid data', async () => {
    const schema = createReconciliationSchema(stConfig, 'Account', 'JournalEntry');
    if (mongoose.models.ReconTest1) delete mongoose.models.ReconTest1;
    const Model = mongoose.model('ReconTest1', schema);

    const accountId = new mongoose.Types.ObjectId();
    const jeId1 = new mongoose.Types.ObjectId();
    const jeId2 = new mongoose.Types.ObjectId();

    const doc = new Model({
      account: accountId,
      journalEntryIds: [jeId1, jeId2],
      debitTotal: 5000,
      creditTotal: 5000,
      difference: 0,
      note: 'Monthly reconciliation',
      reconciledBy: 'user-1',
    });

    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.account.toString()).toBe(accountId.toString());
    expect(doc.journalEntryIds).toHaveLength(2);
    expect(doc.debitTotal).toBe(5000);
    expect(doc.creditTotal).toBe(5000);
    expect(doc.difference).toBe(0);
  });

  it('validates required fields', async () => {
    const schema = createReconciliationSchema(stConfig, 'Account', 'JournalEntry');
    if (mongoose.models.ReconTest2) delete mongoose.models.ReconTest2;
    const Model = mongoose.model('ReconTest2', schema);

    // Missing account
    const doc1 = new Model({
      journalEntryIds: [new mongoose.Types.ObjectId()],
      debitTotal: 100,
      creditTotal: 100,
    });
    await expect(doc1.validate()).rejects.toThrow();

    // Missing debitTotal
    const doc2 = new Model({
      account: new mongoose.Types.ObjectId(),
      journalEntryIds: [new mongoose.Types.ObjectId()],
      creditTotal: 100,
    });
    await expect(doc2.validate()).rejects.toThrow();

    // Missing creditTotal
    const doc3 = new Model({
      account: new mongoose.Types.ObjectId(),
      journalEntryIds: [new mongoose.Types.ObjectId()],
      debitTotal: 100,
    });
    await expect(doc3.validate()).rejects.toThrow();

    // Empty journalEntryIds
    const doc4 = new Model({
      account: new mongoose.Types.ObjectId(),
      journalEntryIds: [],
      debitTotal: 100,
      creditTotal: 100,
    });
    await expect(doc4.validate()).rejects.toThrow();
  });

  it('adds org field when multi-tenant', () => {
    const schema = createReconciliationSchema(mtConfig, 'Account', 'JournalEntry');
    expect(schema.path('business')).toBeDefined();
  });

  it('omits org field when single-tenant', () => {
    const schema = createReconciliationSchema(stConfig, 'Account', 'JournalEntry');
    expect(schema.path('business')).toBeUndefined();
  });

  it('defaults difference to 0', async () => {
    const schema = createReconciliationSchema(stConfig, 'Account', 'JournalEntry');
    if (mongoose.models.ReconTest3) delete mongoose.models.ReconTest3;
    const Model = mongoose.model('ReconTest3', schema);

    const doc = new Model({
      account: new mongoose.Types.ObjectId(),
      journalEntryIds: [new mongoose.Types.ObjectId()],
      debitTotal: 5000,
      creditTotal: 5000,
    });

    await doc.validate();
    expect(doc.difference).toBe(0);
  });

  it('defaults reconciledAt to now', async () => {
    const schema = createReconciliationSchema(stConfig, 'Account', 'JournalEntry');
    if (mongoose.models.ReconTest4) delete mongoose.models.ReconTest4;
    const Model = mongoose.model('ReconTest4', schema);

    const before = new Date();
    const doc = new Model({
      account: new mongoose.Types.ObjectId(),
      journalEntryIds: [new mongoose.Types.ObjectId()],
      debitTotal: 1000,
      creditTotal: 1000,
    });

    expect(doc.reconciledAt).toBeDefined();
    expect(doc.reconciledAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});
