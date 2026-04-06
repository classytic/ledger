/**
 * Scenario: Registry → Schema → Posting Pipeline
 *
 * A POS system registers custom journal types at startup, then uses
 * them to post entries that flow through to reports. Validates the
 * full extensibility story end-to-end.
 *
 * This is THE test that proves the PR's feature works in production.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  _resetCustomJournalTypes,
  getJournalTypeCodes,
  isValidJournalType,
  registerJournalType,
} from '../../src/constants/journals.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { testPack } from '../helpers/scenario-setup.js';

let mongod: MongoMemoryServer;
let JE: mongoose.Model<any>;
let Account: mongoose.Model<any>;
const acctIds: Record<string, mongoose.Types.ObjectId> = {};

beforeAll(async () => {
  _resetCustomJournalTypes();

  // 1. Register custom types BEFORE schema creation
  registerJournalType('POS_SALES', {
    code: 'POS_SALES',
    name: 'POS Sales Journal',
    description: 'Daily aggregated point-of-sale transactions',
  });

  registerJournalType('ECOM_SALES', {
    code: 'ECOM_SALES',
    name: 'E-Commerce Sales Journal',
    description: 'Per-order online transactions',
  });

  // 2. Boot engine + create schemas (freezes registry)
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of ['RegPost_Acct', 'RegPost_JE', 'RegPost_FP', 'RegPost_B', 'RegPost_R']) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  const config: AccountingEngineConfig = {
    mongoose: mongoose.connection,
    country: testPack,
    currency: 'USD',
    retainedEarningsAccountCode: '3600',
    retainedEarningsDisplayCode: '3660',
    currentYearEarningsCode: '3680',
    modelNames: {
      account: 'RegPost_Acct',
      journalEntry: 'RegPost_JE',
      fiscalPeriod: 'RegPost_FP',
      budget: 'RegPost_B',
      reconciliation: 'RegPost_R',
    },
  };

  const engine = createAccountingEngine(config);

  Account = engine.models.Account;
  JE = engine.models.JournalEntry;

  await Account.createIndexes();
  await JE.createIndexes();

  // 3. Seed accounts
  for (const at of testPack.getPostingAccountTypes()) {
    const doc = await Account.create({ accountTypeCode: at.code });
    acctIds[at.code] = doc._id;
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  _resetCustomJournalTypes();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Registry is correctly configured
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Registry Setup', () => {
  it('custom types are registered', () => {
    expect(isValidJournalType('POS_SALES')).toBe(true);
    expect(isValidJournalType('ECOM_SALES')).toBe(true);
  });

  it('built-in types still work', () => {
    expect(isValidJournalType('SALES')).toBe(true);
    expect(isValidJournalType('GENERAL')).toBe(true);
  });

  it('total codes include both built-in and custom', () => {
    const codes = getJournalTypeCodes();
    expect(codes).toContain('POS_SALES');
    expect(codes).toContain('ECOM_SALES');
    expect(codes).toContain('SALES');
    expect(codes.length).toBe(17); // 15 built-in + 2 custom
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Custom journal types pass Mongoose enum validation
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Schema Validation', () => {
  it('POS_SALES passes enum validation on JournalEntry', async () => {
    const entry = await JE.create({
      journalType: 'POS_SALES',
      state: 'posted',
      date: new Date('2025-01-15'),
      journalItems: [
        { account: acctIds['1001'], debit: 500_000, credit: 0 },
        { account: acctIds['4020'], debit: 0, credit: 500_000 },
      ],
      totalDebit: 500_000,
      totalCredit: 500_000,
    });
    expect(entry.journalType).toBe('POS_SALES');
  });

  it('ECOM_SALES passes enum validation on JournalEntry', async () => {
    const entry = await JE.create({
      journalType: 'ECOM_SALES',
      state: 'posted',
      date: new Date('2025-01-15'),
      journalItems: [
        { account: acctIds['1200'], debit: 250_000, credit: 0 },
        { account: acctIds['4020'], debit: 0, credit: 250_000 },
      ],
      totalDebit: 250_000,
      totalCredit: 250_000,
    });
    expect(entry.journalType).toBe('ECOM_SALES');
  });

  it('built-in SALES still works alongside custom types', async () => {
    const entry = await JE.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2025-01-15'),
      journalItems: [
        { account: acctIds['1001'], debit: 100_000, credit: 0 },
        { account: acctIds['4010'], debit: 0, credit: 100_000 },
      ],
      totalDebit: 100_000,
      totalCredit: 100_000,
    });
    expect(entry.journalType).toBe('SALES');
  });

  it('non-registered type STILL fails validation', async () => {
    const doc = new JE({
      journalType: 'WHOLESALE_SALES',
      state: 'draft',
      journalItems: [
        { account: acctIds['1001'], debit: 100, credit: 0 },
        { account: acctIds['4010'], debit: 0, credit: 100 },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err?.errors?.journalType).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Reference numbers use custom journal type prefix
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Reference Numbers', () => {
  it('POS_SALES entries get POS_SALES/ prefix', async () => {
    const entry = await JE.create({
      journalType: 'POS_SALES',
      state: 'posted',
      date: new Date('2025-02-01'),
      journalItems: [
        { account: acctIds['1001'], debit: 100_000, credit: 0 },
        { account: acctIds['4020'], debit: 0, credit: 100_000 },
      ],
      totalDebit: 100_000,
      totalCredit: 100_000,
    });
    expect(entry.referenceNumber).toMatch(/^POS_SALES\/2025\/02\/\d{4}$/);
  });

  it('ECOM_SALES entries get ECOM_SALES/ prefix', async () => {
    const entry = await JE.create({
      journalType: 'ECOM_SALES',
      state: 'posted',
      date: new Date('2025-02-01'),
      journalItems: [
        { account: acctIds['1200'], debit: 50_000, credit: 0 },
        { account: acctIds['4020'], debit: 0, credit: 50_000 },
      ],
      totalDebit: 50_000,
      totalCredit: 50_000,
    });
    expect(entry.referenceNumber).toMatch(/^ECOM_SALES\/2025\/02\/\d{4}$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Late registration is blocked (post-freeze guard)
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Post-Freeze Guard', () => {
  it('registering after schema creation throws', () => {
    expect(() =>
      registerJournalType('LATE_TYPE', {
        code: 'LATE_TYPE',
        name: 'Late Type',
        description: 'Registered too late',
      }),
    ).toThrow('after schema initialization');
  });
});
