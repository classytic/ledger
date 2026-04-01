/**
 * Reconciliation Repository Tests
 *
 * Tests reconcile, unreconcile, and getUnreconciled from wireReconciliationMethods().
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createReconciliationSchema } from '../../src/schemas/reconciliation.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { wireReconciliationMethods } from '../../src/repositories/reconciliation.repository.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

const testPack = defineCountryPack({
  code: 'TS', name: 'Test', defaultCurrency: 'TST',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '2000', name: 'AP', category: 'Balance Sheet-Liability', description: 'AP', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
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
let ReconciliationModel: mongoose.Model<any>;
let JournalEntryModel: mongoose.Model<any>;
let AccountModel: mongoose.Model<any>;
let ReconciliationModelMT: mongoose.Model<any>;
let JournalEntryModelMT: mongoose.Model<any>;
let AccountModelMT: mongoose.Model<any>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Single-tenant models
  if (mongoose.models['ReconRepoAccount']) delete mongoose.models['ReconRepoAccount'];
  AccountModel = mongoose.model('ReconRepoAccount', createAccountSchema(stConfig));

  if (mongoose.models['ReconRepoJE']) delete mongoose.models['ReconRepoJE'];
  JournalEntryModel = mongoose.model('ReconRepoJE', createJournalEntrySchema(stConfig, 'ReconRepoAccount'));

  if (mongoose.models['ReconRepoRecon']) delete mongoose.models['ReconRepoRecon'];
  ReconciliationModel = mongoose.model('ReconRepoRecon', createReconciliationSchema(stConfig, 'ReconRepoAccount', 'ReconRepoJE'));

  // Multi-tenant models
  if (mongoose.models['ReconRepoAccountMT']) delete mongoose.models['ReconRepoAccountMT'];
  AccountModelMT = mongoose.model('ReconRepoAccountMT', createAccountSchema(mtConfig));

  if (mongoose.models['ReconRepoJEMT']) delete mongoose.models['ReconRepoJEMT'];
  JournalEntryModelMT = mongoose.model('ReconRepoJEMT', createJournalEntrySchema(mtConfig, 'ReconRepoAccountMT'));

  if (mongoose.models['ReconRepoReconMT']) delete mongoose.models['ReconRepoReconMT'];
  ReconciliationModelMT = mongoose.model('ReconRepoReconMT', createReconciliationSchema(mtConfig, 'ReconRepoAccountMT', 'ReconRepoJEMT'));
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

function createRepo(orgField?: string) {
  const reconModel = orgField ? ReconciliationModelMT : ReconciliationModel;
  const jeModel = orgField ? JournalEntryModelMT : JournalEntryModel;
  // Provide the repository methods that wired functions now delegate to
  const repo: any = {
    create: async (data: any) => reconModel.create(data),
    delete: async (id: any) => {
      const doc = await reconModel.findByIdAndDelete(id);
      return doc ? { success: true } : null;
    },
    _executeQuery: async (fn: any) => fn(reconModel),
  };
  wireReconciliationMethods(repo, reconModel, jeModel, orgField);
  return repo;
}

/**
 * Helper to create a posted journal entry.
 * The journal entry schema requires at least 2 balanced items for posted entries,
 * so we always create a balancing counterpart item using a second account.
 */
async function createPostedEntry(
  accountId: mongoose.Types.ObjectId,
  items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>,
  orgId?: mongoose.Types.ObjectId,
) {
  const jeModel = orgId ? JournalEntryModelMT : JournalEntryModel;
  const acctModel = orgId ? AccountModelMT : AccountModel;

  // Create a counterpart account for balancing
  const counterData: Record<string, unknown> = {
    accountTypeCode: '2000',
    accountNumber: '2000-ctr-' + Math.random().toString(36).slice(2, 8),
    name: 'Counter Account',
  };
  if (orgId) counterData.business = orgId;
  const counterAcct = await acctModel.create(counterData);

  // Build balanced items: original items + balancing counterpart
  const totalDebit = items.reduce((s, i) => s + i.debit, 0);
  const totalCredit = items.reduce((s, i) => s + i.credit, 0);

  const balancedItems = [...items];
  if (totalDebit > totalCredit) {
    balancedItems.push({ account: counterAcct._id, debit: 0, credit: totalDebit - totalCredit });
  } else if (totalCredit > totalDebit) {
    balancedItems.push({ account: counterAcct._id, debit: totalCredit - totalDebit, credit: 0 });
  }

  const data: Record<string, unknown> = {
    state: 'posted',
    stateChangedAt: new Date(),
    date: new Date(),
    journalItems: balancedItems,
  };
  if (orgId) data.business = orgId;

  const entry = await jeModel.create(data);
  return entry;
}

async function createAccount(code: string, orgId?: mongoose.Types.ObjectId) {
  const model = orgId ? AccountModelMT : AccountModel;
  const data: Record<string, unknown> = {
    accountTypeCode: code,
    accountNumber: code + '-' + Math.random().toString(36).slice(2, 8),
    name: `Test ${code}`,
  };
  if (orgId) data.business = orgId;

  return model.create(data);
}

// ── Single-tenant tests ──────────────────────────────────────────────────────

describe('wireReconciliationMethods (single-tenant)', () => {
  it('reconcile creates a record linking entries', async () => {
    const repo = createRepo();
    const account = await createAccount('1000');
    const accountId = account._id;

    const entry1 = await createPostedEntry(accountId, [
      { account: accountId, debit: 5000, credit: 0 },
    ]);
    const entry2 = await createPostedEntry(accountId, [
      { account: accountId, debit: 0, credit: 5000 },
    ]);

    const result = await repo.reconcile({
      account: accountId,
      journalEntryIds: [entry1._id, entry2._id],
      note: 'Test reconciliation',
      reconciledBy: 'tester',
    });

    expect(result).toBeDefined();
    expect(result.account.toString()).toBe(accountId.toString());
    expect(result.journalEntryIds).toHaveLength(2);
    expect(result.debitTotal).toBe(5000);
    expect(result.creditTotal).toBe(5000);
    expect(result.difference).toBe(0);
    expect(result.note).toBe('Test reconciliation');
    expect(result.reconciledBy).toBe('tester');
  });

  it('reconcile validates entries are posted', async () => {
    const repo = createRepo();
    const account = await createAccount('1000');
    const accountId = account._id;

    // Create a draft entry
    const entry = await JournalEntryModel.create({
      state: 'draft',
      date: new Date(),
      journalItems: [{ account: accountId, debit: 5000, credit: 0 }],
    });

    await expect(
      repo.reconcile({ account: accountId, journalEntryIds: [entry._id] }),
    ).rejects.toThrow('not posted');
  });

  it('reconcile validates entries belong to the same account', async () => {
    const repo = createRepo();
    const account1 = await createAccount('1000');
    const account2 = await createAccount('2000');

    // Entry with items only for account2, not account1
    const entry = await createPostedEntry(account2._id, [
      { account: account2._id, debit: 5000, credit: 0 },
    ]);

    await expect(
      repo.reconcile({ account: account1._id, journalEntryIds: [entry._id] }),
    ).rejects.toThrow('does not contain any items for account');
  });

  it('reconcile throws when entries do not exist', async () => {
    const repo = createRepo();
    const fakeId = new mongoose.Types.ObjectId();

    await expect(
      repo.reconcile({ account: fakeId, journalEntryIds: [fakeId] }),
    ).rejects.toThrow('do not exist');
  });

  it('unreconcile removes the record', async () => {
    const repo = createRepo();
    const account = await createAccount('1000');
    const accountId = account._id;

    const entry1 = await createPostedEntry(accountId, [
      { account: accountId, debit: 3000, credit: 0 },
    ]);
    const entry2 = await createPostedEntry(accountId, [
      { account: accountId, debit: 0, credit: 3000 },
    ]);

    const recon = await repo.reconcile({
      account: accountId,
      journalEntryIds: [entry1._id, entry2._id],
    });

    await repo.unreconcile({ reconciliationId: recon._id });

    const remaining = await ReconciliationModel.countDocuments({});
    expect(remaining).toBe(0);
  });

  it('unreconcile throws for non-existent record', async () => {
    const repo = createRepo();
    const fakeId = new mongoose.Types.ObjectId();

    await expect(
      repo.unreconcile({ reconciliationId: fakeId }),
    ).rejects.toThrow('not found');
  });

  it('getUnreconciled excludes reconciled entries', async () => {
    const repo = createRepo();
    const account = await createAccount('1000');
    const accountId = account._id;

    const entry1 = await createPostedEntry(accountId, [
      { account: accountId, debit: 5000, credit: 0 },
    ]);
    const entry2 = await createPostedEntry(accountId, [
      { account: accountId, debit: 0, credit: 5000 },
    ]);
    const entry3 = await createPostedEntry(accountId, [
      { account: accountId, debit: 2000, credit: 0 },
    ]);

    // Reconcile entry1 and entry2
    await repo.reconcile({
      account: accountId,
      journalEntryIds: [entry1._id, entry2._id],
    });

    // Only entry3 should be unreconciled
    const unreconciled = await repo.getUnreconciled({ accountId });
    expect(unreconciled).toHaveLength(1);
    expect(unreconciled[0]._id.toString()).toBe(entry3._id.toString());
  });

  it('getUnreconciled returns all entries when none reconciled', async () => {
    const repo = createRepo();
    const account = await createAccount('1000');
    const accountId = account._id;

    await createPostedEntry(accountId, [
      { account: accountId, debit: 5000, credit: 0 },
    ]);
    await createPostedEntry(accountId, [
      { account: accountId, debit: 0, credit: 5000 },
    ]);

    const unreconciled = await repo.getUnreconciled({ accountId });
    expect(unreconciled).toHaveLength(2);
  });
});

// ── Multi-tenant tests ───────────────────────────────────────────────────────

describe('wireReconciliationMethods (multi-tenant)', () => {
  it('scopes reconcile to the organization', async () => {
    const repo = createRepo('business');
    const orgId = new mongoose.Types.ObjectId();
    const account = await createAccount('1000', orgId);
    const accountId = account._id;

    const entry1 = await createPostedEntry(accountId, [
      { account: accountId, debit: 5000, credit: 0 },
    ], orgId);
    const entry2 = await createPostedEntry(accountId, [
      { account: accountId, debit: 0, credit: 5000 },
    ], orgId);

    const result = await repo.reconcile({
      account: accountId,
      journalEntryIds: [entry1._id, entry2._id],
      organizationId: orgId,
    });

    expect(result).toBeDefined();
    expect(result.business.toString()).toBe(orgId.toString());
  });

  it('throws when organizationId is missing in multi-tenant mode', async () => {
    const repo = createRepo('business');
    const fakeId = new mongoose.Types.ObjectId();

    await expect(
      repo.reconcile({ account: fakeId, journalEntryIds: [fakeId] }),
    ).rejects.toThrow('organizationId is required');
  });

  it('getUnreconciled is scoped to organization', async () => {
    const repo = createRepo('business');
    const org1 = new mongoose.Types.ObjectId();
    const org2 = new mongoose.Types.ObjectId();

    const account1 = await createAccount('1000', org1);
    const account2 = await createAccount('1000', org2);

    await createPostedEntry(account1._id, [
      { account: account1._id, debit: 1000, credit: 0 },
    ], org1);
    await createPostedEntry(account2._id, [
      { account: account2._id, debit: 2000, credit: 0 },
    ], org2);

    const unreconciled1 = await repo.getUnreconciled({ accountId: account1._id, organizationId: org1 });
    expect(unreconciled1).toHaveLength(1);

    const unreconciled2 = await repo.getUnreconciled({ accountId: account2._id, organizationId: org2 });
    expect(unreconciled2).toHaveLength(1);
  });

  it('cross-org entries are not found in reconcile', async () => {
    const repo = createRepo('business');
    const org1 = new mongoose.Types.ObjectId();
    const org2 = new mongoose.Types.ObjectId();

    const account = await createAccount('1000', org1);

    // Create entry in org2
    const entry = await createPostedEntry(account._id, [
      { account: account._id, debit: 5000, credit: 0 },
    ], org2);

    // Try to reconcile in org1 — entry should not be found
    await expect(
      repo.reconcile({
        account: account._id,
        journalEntryIds: [entry._id],
        organizationId: org1,
      }),
    ).rejects.toThrow('do not exist');
  });
});
