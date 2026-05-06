/**
 * Opening Balance — end-to-end integration test with real MongoDB.
 *
 * Full pipeline: CSV trial balance → buildOpeningBalanceEntry → record.openingBalance()
 * → verify JE in DB → verify trial balance report matches the input.
 *
 * This proves the entire chain works against a real accounting engine:
 *   1. Parse a trial balance (simulating a fin-io CSV parse result)
 *   2. Post it via the semantic API
 *   3. Verify the journal entry was created correctly
 *   4. Verify the trial balance report reflects the opening balances
 *   5. Idempotency: re-posting the same cutover date fails (duplicate)
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccountingEngine } from '../../src/engine';
import { defineCountryPack } from '../../src/country/index';
import { buildOpeningBalanceEntry } from '../../src/sync/builders/opening-balance';
import type { Cents } from '../../src/types/core';
import { legacyTrialBalance } from '../helpers/legacy-report-view.js';

// Inline Canadian-like country pack (self-contained — no ledger-ca dependency)
const testPack = defineCountryPack({
  code: 'CA',
  name: 'Canada (test)',
  defaultCurrency: 'CAD',
  retainedEarningsAccountCode: '3600',
  currentYearEarningsCode: '3680',
  accountTypes: [
    { code: '1000', name: 'Cash and Deposits', category: 'Balance Sheet-Asset' },
    { code: '1060', name: 'Accounts Receivable', category: 'Balance Sheet-Asset' },
    { code: '1120', name: 'Inventories', category: 'Balance Sheet-Asset' },
    { code: '1600', name: 'Land', category: 'Balance Sheet-Asset' },
    { code: '1680', name: 'Buildings', category: 'Balance Sheet-Asset' },
    { code: '2620', name: 'Accounts Payable', category: 'Balance Sheet-Liability' },
    { code: '2680', name: 'Long-term Debt', category: 'Balance Sheet-Liability' },
    { code: '3400', name: 'Share Capital', category: 'Balance Sheet-Equity' },
    { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity' },
    { code: '3680', name: 'Current Year Earnings', category: 'Balance Sheet-Equity' },
    { code: '8000', name: 'Sales Revenue', category: 'Income Statement-Income' },
    { code: '8690', name: 'Other Expenses', category: 'Income Statement-Expense' },
  ],
});

let mongod: MongoMemoryServer;
let conn: mongoose.Connection;
let engine: ReturnType<typeof createAccountingEngine>;

const TEST_ORG = new mongoose.Types.ObjectId();
const CUTOVER_DATE = new Date('2025-01-01');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  conn = await mongoose.createConnection(uri).asPromise();

  engine = createAccountingEngine({
    mongoose: conn,
    country: testPack,
    currency: 'CAD',
    multiTenant: { tenantField: 'organizationId', ref: 'organization' },
    fiscalYearStartMonth: 1,
    schemaOptions: {
      journalEntry: {
        extraFields: {
          _externalId: { type: String, default: null },
          _importSource: { type: String, default: null },
        },
        extraIndexes: [
          {
            fields: { organizationId: 1, _externalId: 1 },
            options: {
              unique: true,
              partialFilterExpression: { _externalId: { $type: 'string' } },
            },
          },
        ],
      },
    },
  });

  // Seed the standard chart of accounts
  await engine.repositories.accounts.seedAccounts(TEST_ORG);

  // Ensure indexes are created (including _externalId unique partial index)
  await engine.models.JournalEntry.syncIndexes();
}, 30_000);

afterAll(async () => {
  await conn.close();
  await mongod.stop();
}, 15_000);

// Simulated trial balance — what a CSV parse would produce (in cents)
const TB_BALANCES = [
  { account: '1000', balance: 5000000 },   // Cash $50,000
  { account: '1060', balance: 1250000 },   // AR $12,500
  { account: '1120', balance: 800000 },    // Inventory $8,000
  { account: '1600', balance: 2500000 },   // Land $25,000
  { account: '1680', balance: 15000000 },  // Buildings $150,000
  { account: '2620', balance: -1875000 },  // AP ($18,750)
  { account: '2680', balance: -8000000 },  // LT Debt ($80,000)
  { account: '3400', balance: -10000000 }, // Share Capital ($100,000)
  // Retained earnings is excluded — it's the equity contra, auto-computed
] as const;

// Expected total: debits = 24,550,000, credits = 19,875,000
// Difference = 4,675,000 → goes to retained earnings (3600)

describe('Opening Balance E2E — record.openingBalance()', () => {
  it('posts an opening balance JE from trial balance data', async () => {
    const entry = await engine.record.openingBalance(TEST_ORG, {
      cutoverDate: CUTOVER_DATE,
      balances: TB_BALANCES.map(b => ({ account: b.account, balance: b.balance as Cents })),
      // equityAccount defaults to canadaPack.retainedEarningsAccountCode = '3600'
    });

    expect(entry).toBeDefined();
    const je = entry as Record<string, unknown>;
    expect(je.state).toBe('posted');
    expect(je._externalId).toBe('opening-balance:2025-01-01');
    expect(je._importSource).toBe('opening-balance');
  });

  it('created a journal entry with correct line count', async () => {
    const JournalEntry = engine.models.JournalEntry;
    const entries = await JournalEntry.find({
      organizationId: TEST_ORG,
      _externalId: 'opening-balance:2025-01-01',
    }).lean();

    expect(entries).toHaveLength(1);
    const je = entries[0] as Record<string, unknown>;
    const items = je.journalItems as Array<{ debit: number; credit: number }>;

    // 8 balance accounts + 1 equity contra = 9 lines
    expect(items.length).toBe(9);

    // Verify double-entry integrity
    const totalDebit = items.reduce((s, i) => s + i.debit, 0);
    const totalCredit = items.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('trial balance report reflects the opening balances', async () => {
    const tb = await engine.reports.trialBalance({
      organizationId: TEST_ORG,
      dateOption: 'year',
      dateValue: 2025,
    }) as { rows: Array<{ account: { accountTypeCode: string }; ending: { debit: number; credit: number } }> };

    expect(tb).toBeDefined();
    expect(legacyTrialBalance(tb).rows.length).toBeGreaterThanOrEqual(8);

    // Check specific accounts
    const cash = legacyTrialBalance(tb).rows.find(r => r.account?.accountTypeCode === '1000');
    expect(cash).toBeDefined();
    expect(cash!.ending.debit).toBe(5000000); // $50,000

    const ap = legacyTrialBalance(tb).rows.find(r => r.account?.accountTypeCode === '2620');
    expect(ap).toBeDefined();
    expect(ap!.ending.credit).toBe(1875000); // $18,750

    const land = legacyTrialBalance(tb).rows.find(r => r.account?.accountTypeCode === '1600');
    expect(land).toBeDefined();
    expect(land!.ending.debit).toBe(2500000); // $25,000
  });

  it('idempotency: re-posting the same cutover date is rejected', async () => {
    // The _externalId unique index prevents a second opening balance for the
    // same cutover date (E11000 duplicate key error).
    // mongokit's error:create hook re-throws async — suppress the leaked rejection.
    const suppress = (err: unknown) => {
      if (err instanceof Error && /E11000|duplicate/i.test(err.message)) return;
      throw err;
    };
    process.on('unhandledRejection', suppress);

    let threw = false;
    try {
      await engine.record.openingBalance(TEST_ORG, {
        cutoverDate: CUTOVER_DATE,
        balances: [{ account: '1000', balance: 100 as Cents }],
      });
    } catch (err: unknown) {
      threw = true;
      const msg = (err as Error).message;
      // 0.9.0: the race-safe create wrapper classifies dup-keys by index
      // name instead of bubbling the raw MongoServerError — accept the
      // typed message in addition to the legacy patterns.
      expect(msg).toMatch(/duplicate|E11000|unique index/i);
    }
    expect(threw).toBe(true);

    // Allow event loop to flush, then remove the listener
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', suppress);
  });

  it('different cutover date succeeds (different _externalId)', async () => {
    const entry = await engine.record.openingBalance(TEST_ORG, {
      cutoverDate: new Date('2024-01-01'),
      balances: [
        { account: '1000', balance: 1000000 as Cents },  // $10,000
      ],
    });

    expect(entry).toBeDefined();
    const je = entry as Record<string, unknown>;
    expect(je._externalId).toBe('opening-balance:2024-01-01');
  });
});

describe('buildOpeningBalanceEntry — pure function integration', () => {
  it('produces the same result used by record.openingBalance()', () => {
    const result = buildOpeningBalanceEntry({
      cutoverDate: CUTOVER_DATE,
      balances: TB_BALANCES.map(b => ({
        accountCode: b.account,
        balance: b.balance,
      })),
      equityAccountCode: '3600',
    });

    // 8 accounts + 1 equity contra
    expect(result.entry.journalItems).toHaveLength(9);
    expect(result.residual).toBe(4675000); // difference absorbed by equity
    expect(result.lineCount).toBe(8); // excludes equity contra

    // Verify the entry balances
    const totalDebit = result.entry.journalItems.reduce((s, i) => s + i.debit, 0);
    const totalCredit = result.entry.journalItems.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });
});
