/**
 * Account Repository Tests
 *
 * Tests seedAccounts, bulkCreate, and posting-account validation
 * from wireAccountMethods().
 */

import { Repository } from '@classytic/mongokit';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { wireAccountMethods } from '../../src/repositories/account.repository.js';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';

const testPack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'TST',
  retainedEarningsAccountCode: '3000',
  cogsGroupCode: 'COGS',
  accountTypes: [
    // Groups (not postable)
    {
      code: 'Assets',
      name: 'Assets',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: null,
      isGroup: true,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: 'Revenue',
      name: 'Revenue',
      category: 'Income Statement-Income',
      description: '',
      parentCode: null,
      isGroup: true,
      isTotal: false,
      cashFlowCategory: null,
    },
    // Totals (not postable)
    {
      code: '1999',
      name: 'Total Assets',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Assets',
      isTotal: true,
      cashFlowCategory: null,
      totalAccountTypes: [{ account: '1000', operation: '+' }],
    },
    // Posting accounts
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Assets',
      isTotal: false,
      cashFlowCategory: null,
      // The country pack flags 1000 as cash so bulkCreate inherits it
      // onto every Account seeded from this code. See the "inherits
      // isCashAccount from country pack" test below.
      isCashAccount: true,
    },
    {
      code: '1100',
      name: 'AR',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Assets',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '2000',
      name: 'AP',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '3000',
      name: 'Equity',
      category: 'Balance Sheet-Equity',
      description: '',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '4000',
      name: 'Sales',
      category: 'Income Statement-Income',
      description: '',
      parentCode: 'Revenue',
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '5000',
      name: 'Rent',
      category: 'Income Statement-Expense',
      description: '',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    // Tax virtual total + sub-account
    {
      code: '2500',
      name: 'Tax Payable',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: null,
      isTotal: true,
      isVirtualTotal: true,
      cashFlowCategory: null,
      totalAccountTypes: [{ account: '2501', operation: '+' }],
    },
    {
      code: '2501',
      name: 'Sales Tax',
      category: 'Balance Sheet-Liability',
      description: '',
      parentCode: '2500',
      isTotal: false,
      cashFlowCategory: null,
    },
    // Uncategorized
    {
      code: 'Uncategorized Assets',
      name: 'Uncategorized Assets',
      category: 'Balance Sheet-Asset',
      description: '',
      parentCode: 'Assets',
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
  multiTenant: { tenantField: 'business', ref: 'Business' },
};

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let orgId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  if (mongoose.models.AcctRepoAccount) delete mongoose.models.AcctRepoAccount;
  AccountModel = mongoose.model('AcctRepoAccount', createAccountSchema(mtConfig));
  await AccountModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  orgId = new mongoose.Types.ObjectId();
});

function createRepo() {
  const repo = new Repository(AccountModel, []);
  wireAccountMethods(repo, testPack, 'business');
  return repo;
}

// ── seedAccounts ─────────────────────────────────────────────────────────────

describe('seedAccounts', () => {
  it('creates all posting accounts for an org', async () => {
    const repo = createRepo();
    const result = await repo.seedAccounts(orgId);

    // Posting types: 1000, 1100, 2000, 3000, 4000, 5000, 2501, Uncategorized Assets = 8
    expect(result.created).toBe(8);
    expect(result.skipped).toBe(0);

    const docs = await AccountModel.find({ business: orgId }).lean();
    expect(docs).toHaveLength(8);
  });

  it('does not create groups or totals', async () => {
    const repo = createRepo();
    await repo.seedAccounts(orgId);

    const docs = (await AccountModel.find({ business: orgId }).lean()) as any[];
    const codes = docs.map((d: any) => d.accountTypeCode);

    // Groups
    expect(codes).not.toContain('Assets');
    expect(codes).not.toContain('Revenue');
    // Totals
    expect(codes).not.toContain('1999');
    expect(codes).not.toContain('2500');
  });

  it('includes tax sub-accounts and uncategorized', async () => {
    const repo = createRepo();
    await repo.seedAccounts(orgId);

    const docs = (await AccountModel.find({ business: orgId }).lean()) as any[];
    const codes = docs.map((d: any) => d.accountTypeCode);

    expect(codes).toContain('2501'); // tax sub-account
    expect(codes).toContain('Uncategorized Assets');
  });

  it('skips already existing accounts on re-seed', async () => {
    const repo = createRepo();
    const first = await repo.seedAccounts(orgId);
    expect(first.created).toBe(8);

    const second = await repo.seedAccounts(orgId);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(8);

    // Total in DB should still be 8
    const count = await AccountModel.countDocuments({ business: orgId });
    expect(count).toBe(8);
  });

  it('seeds partial — only missing accounts', async () => {
    // Pre-create one account
    await AccountModel.create({
      accountTypeCode: '1000',
      accountNumber: '1000',
      name: 'Cash',
      business: orgId,
    });

    const repo = createRepo();
    const result = await repo.seedAccounts(orgId);
    expect(result.created).toBe(7); // 8 - 1 existing
    expect(result.skipped).toBe(1);
  });

  it('isolates seed per org', async () => {
    const org2 = new mongoose.Types.ObjectId();
    const repo = createRepo();

    await repo.seedAccounts(orgId);
    await repo.seedAccounts(org2);

    const org1Count = await AccountModel.countDocuments({ business: orgId });
    const org2Count = await AccountModel.countDocuments({ business: org2 });
    expect(org1Count).toBe(8);
    expect(org2Count).toBe(8);
  });
});

// ── bulkCreate ───────────────────────────────────────────────────────────────

describe('bulkCreate', () => {
  it('creates multiple accounts', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate(
      [{ accountTypeCode: '1000' }, { accountTypeCode: '2000' }, { accountTypeCode: '4000' }],
      orgId,
    );

    expect(result.summary.created).toBe(3);
    expect(result.summary.skipped).toBe(0);
    expect(result.summary.errors).toBe(0);
  });

  it('skips already existing accounts', async () => {
    await AccountModel.create({
      accountTypeCode: '1000',
      accountNumber: '1000',
      name: 'Cash',
      business: orgId,
    });

    const repo = createRepo();
    const result = await repo.bulkCreate(
      [{ accountTypeCode: '1000' }, { accountTypeCode: '2000' }],
      orgId,
    );

    expect(result.summary.created).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect(result.skipped[0].reason).toBe('Already exists');
  });

  it('rejects missing accountTypeCode', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate(
      [{ accountTypeCode: '' }, { accountTypeCode: '1000' }],
      orgId,
    );

    expect(result.summary.errors).toBe(1);
    expect(result.summary.created).toBe(1);
    expect(result.errors[0].reason).toContain('required');
  });

  it('rejects invalid account type code', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate([{ accountTypeCode: 'FAKE_CODE' }], orgId);

    expect(result.summary.errors).toBe(1);
    expect(result.errors[0].reason).toContain('Invalid');
  });

  it('rejects group account types', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate([{ accountTypeCode: 'Assets' }], orgId);

    expect(result.summary.errors).toBe(1);
    expect(result.errors[0].reason).toContain('group');
  });

  it('rejects total account types', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate([{ accountTypeCode: '1999' }], orgId);

    expect(result.summary.errors).toBe(1);
    expect(result.errors[0].reason).toContain('total');
  });

  it('uses accountTypeCode as default name and number', async () => {
    const repo = createRepo();
    await repo.bulkCreate([{ accountTypeCode: '1000' }], orgId);

    const doc = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1000',
    }).lean()) as any;
    expect(doc.accountNumber).toBe('1000');
    expect(doc.name).toBe('Cash'); // from country pack
  });

  it('allows custom name and number', async () => {
    const repo = createRepo();
    await repo.bulkCreate(
      [{ accountTypeCode: '1000', accountNumber: 'CASH-01', name: 'Main Cash Account' }],
      orgId,
    );

    const doc = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1000',
    }).lean()) as any;
    expect(doc.accountNumber).toBe('CASH-01');
    expect(doc.name).toBe('Main Cash Account');
  });

  it('handles empty input', async () => {
    const repo = createRepo();
    const result = await repo.bulkCreate([], orgId);

    expect(result.summary.total).toBe(0);
    expect(result.summary.created).toBe(0);
  });

  // ── isCashAccount inheritance from country pack ─────────────────
  // The country pack is the single owner of "what is cash in this
  // jurisdiction's chart". Account docs need to carry the flag so
  // downstream consumers (Bank Reconciliation, Cash Flow Statement,
  // the JE-detail "Bank & Cash movement" panel) can trust it without
  // re-deriving "is this a cash code?" everywhere.

  it('inherits isCashAccount from the country pack AccountType when caller omits it', async () => {
    const repo = createRepo();
    await repo.bulkCreate([{ accountTypeCode: '1000' }], orgId);

    const cash = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1000',
    }).lean()) as any;
    expect(cash.isCashAccount).toBe(true);
  });

  it('leaves isCashAccount=false when the country pack does not flag the code', async () => {
    const repo = createRepo();
    // 1100 is AR in the test pack — no isCashAccount flag.
    await repo.bulkCreate([{ accountTypeCode: '1100' }], orgId);

    const ar = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1100',
    }).lean()) as any;
    expect(ar.isCashAccount).toBe(false);
  });

  it('honors caller override (explicit false beats country-pack true)', async () => {
    const repo = createRepo();
    await repo.bulkCreate(
      [{ accountTypeCode: '1000', isCashAccount: false }],
      orgId,
    );

    const doc = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1000',
    }).lean()) as any;
    expect(doc.isCashAccount).toBe(false);
  });

  it('honors caller override (explicit true on a non-cash code)', async () => {
    const repo = createRepo();
    await repo.bulkCreate(
      [{ accountTypeCode: '1100', isCashAccount: true }],
      orgId,
    );

    const doc = (await AccountModel.findOne({
      business: orgId,
      accountTypeCode: '1100',
    }).lean()) as any;
    expect(doc.isCashAccount).toBe(true);
  });

  it('handles mix of valid, invalid, and existing', async () => {
    await AccountModel.create({
      accountTypeCode: '1000',
      accountNumber: '1000',
      name: 'Cash',
      business: orgId,
    });

    const repo = createRepo();
    const result = await repo.bulkCreate(
      [
        { accountTypeCode: '1000' }, // skip: exists
        { accountTypeCode: '2000' }, // create
        { accountTypeCode: 'FAKE' }, // error: invalid
        { accountTypeCode: 'Assets' }, // error: group
        { accountTypeCode: '4000' }, // create
      ],
      orgId,
    );

    expect(result.summary.total).toBe(5);
    expect(result.summary.created).toBe(2);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.errors).toBe(2);
  });
});

// ── bulkCreate concurrency safety ────────────────────────────────────────────
//
// Regression coverage for two real-world races:
//
//   1. Two concurrent callers each pass the pre-flight `existingNumbers`
//      filter, both attempt to insert the same accountNumber, and the loser
//      gets E11000. The loser MUST recover gracefully — either with the raw
//      MongoBulkWriteError (older drivers) or with mongokit's wrapped
//      `{ status: 409, duplicate: {...} }` HttpError. Both shapes have to
//      land in the same dup-key recovery branch.
//
//   2. mongokit's parseDuplicateKeyError strips `insertedDocs` from the
//      original error. Without a re-query fallback, the recovery branch
//      can't resolve `_id`s. The fallback re-query covers that case.

describe('bulkCreate — concurrency', () => {
  it('5 concurrent bulkCreate calls for the same accountNumber yield exactly 1 doc and never throw', async () => {
    const repo = createRepo();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.bulkCreate([{ accountTypeCode: '1000' }], orgId)),
    );

    // Every call returned a result envelope (no exception escaped).
    for (const r of results) {
      expect(r.summary.total).toBe(1);
      expect(r.summary.errors).toBe(0);
      expect(r.summary.created + r.summary.skipped).toBe(1);
    }

    // Across all 5 calls, exactly one wrote the doc.
    const totalCreated = results.reduce((sum, r) => sum + r.summary.created, 0);
    expect(totalCreated).toBe(1);

    // And the DB has exactly one matching doc.
    const docs = await AccountModel.find({ business: orgId, accountTypeCode: '1000' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('recovers from a mongokit-wrapped 409 (no insertedDocs / no writeErrors / no code 11000)', async () => {
    // A concurrent peer wins the race and inserts the doc between our
    // existsFilter check and our createMany call. Simulated by inserting
    // directly, then patching createMany to throw the exact error shape
    // mongokit's parseDuplicateKeyError produces.

    // Pre-existing doc inserted "by another caller" AFTER our existsFilter
    // would have run — so our existing-numbers check sees nothing.
    const concurrentPeerId = new mongoose.Types.ObjectId();
    const repo = createRepo();
    const originalCreateMany = repo.createMany.bind(repo);

    repo.createMany = async (docs: Record<string, unknown>[]) => {
      // Insert the doc as if a concurrent caller did, then throw the
      // mongokit-wrapped error shape (NO insertedDocs, NO writeErrors, NO code 11000).
      await AccountModel.create({
        _id: concurrentPeerId,
        accountTypeCode: docs[0].accountTypeCode,
        accountNumber: docs[0].accountNumber,
        name: docs[0].name,
        business: orgId,
      });
      const wrapped = new Error('Duplicate value for accountNumber') as Error & {
        status: number;
        duplicate: { fields: string[] };
      };
      wrapped.status = 409;
      wrapped.duplicate = { fields: ['business', 'accountNumber'] };
      throw wrapped;
    };

    const result = await repo.bulkCreate([{ accountTypeCode: '1000' }], orgId);

    // Restore for cleanliness
    repo.createMany = originalCreateMany;

    expect(result.summary.errors).toBe(0);
    expect(result.summary.created).toBe(0);
    expect(result.summary.skipped).toBe(1);
    expect(result.skipped[0].reason).toBe('Already exists (concurrent insert)');
    // The fallback re-query MUST resolve the _id of the doc the peer inserted.
    expect(String(result.skipped[0]._id)).toBe(String(concurrentPeerId));

    // And the DB has exactly one matching doc.
    const docs = await AccountModel.find({ business: orgId, accountTypeCode: '1000' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('rethrows non-duplicate-key errors (does not swallow validation/connection failures)', async () => {
    const repo = createRepo();
    const validationError = new Error('Validation failed') as Error & { name: string };
    validationError.name = 'ValidationError';
    repo.createMany = async () => {
      throw validationError;
    };

    await expect(repo.bulkCreate([{ accountTypeCode: '1000' }], orgId)).rejects.toThrow(
      'Validation failed',
    );
  });
});

// ── before:create validation ─────────────────────────────────────────────────

describe('before:create validation', () => {
  it('blocks creation of group account types', async () => {
    const repo = createRepo();
    await expect(
      repo.create({ accountTypeCode: 'Assets', accountNumber: 'GRP', name: 'Group', business: orgId }),
    ).rejects.toThrow('structural group');
  });

  it('blocks creation of total account types', async () => {
    const repo = createRepo();
    await expect(
      repo.create({ accountTypeCode: '1999', accountNumber: 'TOT', name: 'Total', business: orgId }),
    ).rejects.toThrow('structural group or calculated total');
  });

  it('allows creation of posting account types', async () => {
    const repo = createRepo();
    await expect(
      repo.create({ accountTypeCode: '1000', accountNumber: 'POST-1', name: 'Cash', business: orgId }),
    ).resolves.toBeDefined();
  });

  it('allows creation of accounts with valid posting type code', async () => {
    const repo = createRepo();
    await expect(
      repo.create({ accountTypeCode: '1000', accountNumber: 'VALID-1', name: 'Valid Account', business: orgId }),
    ).resolves.toBeDefined();
  });
});
