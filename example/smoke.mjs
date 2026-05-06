#!/usr/bin/env node
/**
 * @classytic/ledger — end-to-end smoke test.
 *
 * What this is:
 * -------------
 * A self-contained CLI that imports the PUBLISHED shape of `@classytic/ledger`
 * (via a `file:..` link in package.json → dist/), spins up a real MongoDB
 * via `mongodb-memory-server`, and drives every major primitive the package
 * advertises: engine bootstrap, account seeding, double-entry validation,
 * posting, reversal, and all three lock-plugin presets.
 *
 * Why it exists:
 * --------------
 * Vitest runs against the raw TypeScript under `src/`. That catches logic
 * bugs but not packaging bugs — missing exports from `exports` map, broken
 * subpath imports, tree-shaking breakage, type-only symbols leaking, etc.
 * This script imports from the built `dist/` exactly the way a consumer on
 * npm would, so a regression in build config blows up loudly before publish.
 *
 * How to run:
 * -----------
 *   npm run smoke        # from packages/ledger
 *
 * The runner at `scripts/smoke.mjs` handles the build+install+invoke dance.
 * This file just exits 0 on success, non-zero with a diff on failure.
 */

import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// Import from the published shape — no ../src/ path shortcuts allowed here.
import {
  createAccountingEngine,
  defineCountryPack,
  AccountingError,
  generatePartnerLedger,
} from '@classytic/ledger';
import {
  fiscalLockPlugin,
  dailyLockPlugin,
  createLockPlugin,
  periodResolver,
  watermarkResolver,
  fxRealizationPlugin,
  creditLimitPlugin,
} from '@classytic/ledger/plugins';

// ─── Pretty console helpers ─────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function step(label, fn) {
  process.stdout.write(`  ${DIM}…${RESET} ${label}`);
  try {
    await fn();
    process.stdout.write(`\r  ${GREEN}✓${RESET} ${label}\n`);
    passed += 1;
  } catch (err) {
    process.stdout.write(`\r  ${RED}✗${RESET} ${label}\n`);
    console.error(`    ${RED}${err instanceof Error ? err.stack : String(err)}${RESET}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ─── Country pack ───────────────────────────────────────────────────────────

const pack = defineCountryPack({
  code: 'SMK',
  name: 'Smoke Test Pack',
  defaultCurrency: 'USD',
  retainedEarningsAccountCode: '3600',
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: 'Cash',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: 'Operating',
    },
    {
      code: '2100',
      name: 'VAT Payable',
      category: 'Balance Sheet-Liability',
      description: 'VAT',
      parentCode: null,
      isTotal: false,
      cashFlowCategory: null,
    },
    {
      code: '4000',
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
  ],
});

// ─── Main ──────────────────────────────────────────────────────────────────

console.log(`${BOLD}@classytic/ledger smoke test${RESET}`);
console.log(`${DIM}Imports dist/ via file: link. Exits non-zero on any failure.${RESET}`);

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri());

try {
  section('1. Engine bootstrap & account seeding');

  const engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
  });

  let cashId;
  let vatId;
  let revenueId;

  await step('bulk-creates 3 accounts from country pack codes', async () => {
    const result = await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1000' },
      { accountTypeCode: '2100' },
      { accountTypeCode: '4000' },
    ]);
    assert.equal(result.summary.created, 3, 'should create 3 accounts');
    cashId = result.created[0]._id;
    vatId = result.created[1]._id;
    revenueId = result.created[2]._id;
  });

  // ── 2. Double-entry happy path ────────────────────────────────────────

  section('2. Double-entry posting (happy path)');

  let postedId;

  await step('creates draft → posts → reads back with state=posted', async () => {
    const draft = await engine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'draft',
      date: new Date('2026-02-10'),
      label: 'Smoke: basic sale',
      journalItems: [
        { account: cashId, debit: 1_150, credit: 0 },
        { account: revenueId, debit: 0, credit: 1_000 },
        { account: vatId, debit: 0, credit: 150 },
      ],
    });

    const posted = await engine.repositories.journalEntries.post(draft._id);
    assert.equal(posted.state, 'posted');
    postedId = draft._id;

    const reread = await engine.repositories.journalEntries.getById(draft._id);
    assert.equal(reread.state, 'posted');
    assert.equal(reread.totalDebit, 1_150);
    assert.equal(reread.totalCredit, 1_150);
  });

  await step('rejects unbalanced draft with a typed AccountingError', async () => {
    try {
      await engine.repositories.journalEntries.create({
        journalType: 'GENERAL',
        state: 'posted',
        date: new Date('2026-02-11'),
        journalItems: [
          { account: cashId, debit: 100, credit: 0 },
          { account: revenueId, debit: 0, credit: 90 },
        ],
      });
      throw new Error('expected double-entry plugin to reject unbalanced entry');
    } catch (err) {
      assert.ok(err instanceof AccountingError, 'should throw AccountingError');
      assert.equal(err.code, 'VALIDATION_ERROR');
    }
  });

  // ── 3. fiscalLockPlugin ───────────────────────────────────────────────

  section('3. fiscalLockPlugin (auto-wired)');

  await step('blocks post() into a closed fiscal period with PERIOD_LOCKED_FISCAL', async () => {
    await engine.models.FiscalPeriod.create({
      name: 'Q4 2025',
      startDate: new Date('2025-10-01'),
      endDate: new Date('2025-12-31'),
      closed: true,
      closedAt: new Date(),
    });

    const draft = await engine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2025-11-15'),
      journalItems: [
        { account: cashId, debit: 500, credit: 0 },
        { account: revenueId, debit: 0, credit: 500 },
      ],
    });

    try {
      await engine.repositories.journalEntries.post(draft._id);
      throw new Error('expected fiscal lock to fire');
    } catch (err) {
      assert.ok(err instanceof AccountingError);
      assert.equal(err.code, 'PERIOD_LOCKED_FISCAL');
      assert.equal(err.status, 409);
      assert.match(err.message, /Q4 2025/);
    }
  });

  // ── 4. reverseMark exemption: reverse through a closed period ─────────

  section('4. reverse() — counter-entry flows through open period');

  await step('original sits in closed period; reversal posts into open period', async () => {
    // Close Feb 2026 AFTER the entry we posted at step 2 (dated Feb 10 2026).
    await engine.models.FiscalPeriod.create({
      name: 'Feb 2026',
      startDate: new Date('2026-02-01'),
      endDate: new Date('2026-02-28'),
      closed: true,
      closedAt: new Date(),
    });

    // 0.10.x: reverse() defaults to draft (ERPNext/Odoo parity) so finance can
    // review before the books move. Pass autoPost: true to assert the
    // through-the-fiscal-lock flow this section is testing.
    const { original, reversal } = await engine.repositories.journalEntries.reverse(
      postedId,
      undefined,
      { reversalDate: new Date('2026-03-15'), autoPost: true },
    );

    assert.ok(original, 'reverse should return original');
    assert.ok(reversal, 'reverse should return reversal');
    assert.equal(original.reversed, true, 'original should be marked reversed');
    assert.equal(reversal.state, 'posted');
    // ReverseResult<TEntry> is generic now — consumer should get typed `_id`.
    assert.ok(reversal._id);
  });

  // ── 6. dailyLockPlugin ───────────────────────────────────────────────

  section('6. dailyLockPlugin (watermark semantics)');

  const dailyEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    modelNames: {
      account: 'DailyAccount',
      journalEntry: 'DailyJE',
      fiscalPeriod: 'DailyFP',
      budget: 'DailyBudget',
      reconciliation: 'DailyRecon',
    },
  });

  const dailyAccounts = await dailyEngine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1000' },
    { accountTypeCode: '4000' },
  ]);
  const dCashId = dailyAccounts.created[0]._id;
  const dRevId = dailyAccounts.created[1]._id;

  let watermark = new Date('2026-02-10T00:00:00Z');
  dailyLockPlugin({
    getLastClosedDate: () => watermark,
    JournalEntryModel: dailyEngine.models.JournalEntry,
  }).apply(dailyEngine.repositories.journalEntries);

  await step('blocks entries on or before the watermark', async () => {
    const draft = await dailyEngine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2026-02-10T00:00:00Z'),
      journalItems: [
        { account: dCashId, debit: 100, credit: 0 },
        { account: dRevId, debit: 0, credit: 100 },
      ],
    });
    try {
      await dailyEngine.repositories.journalEntries.post(draft._id);
      throw new Error('expected daily lock to fire');
    } catch (err) {
      assert.ok(err instanceof AccountingError);
      assert.equal(err.code, 'PERIOD_LOCKED_DAILY');
    }
  });

  await step('allows entries strictly after the watermark', async () => {
    const draft = await dailyEngine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2026-02-11'),
      journalItems: [
        { account: dCashId, debit: 100, credit: 0 },
        { account: dRevId, debit: 0, credit: 100 },
      ],
    });
    const posted = await dailyEngine.repositories.journalEntries.post(draft._id);
    assert.equal(posted.state, 'posted');
  });

  // ── 7. createLockPlugin — bespoke scope composition ──────────────────

  section('7. createLockPlugin + periodResolver + watermarkResolver (compose your own)');

  await step('exports are callable factories (not type-only)', async () => {
    assert.equal(typeof createLockPlugin, 'function');
    assert.equal(typeof periodResolver, 'function');
    assert.equal(typeof watermarkResolver, 'function');
  });

  await step('composes a bespoke bank-recon lock that wires into a fresh engine', async () => {
    const bankEngine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      modelNames: {
        account: 'BankAccount',
        journalEntry: 'BankJE',
        fiscalPeriod: 'BankFP',
        budget: 'BankBudget',
        reconciliation: 'BankRecon',
      },
    });

    const BankReconModel = mongoose.model(
      'SmokeBankRecon',
      new mongoose.Schema({
        statementStart: Date,
        statementEnd: Date,
        finalized: Boolean,
        statementId: String,
      }),
    );

    createLockPlugin({
      scope: 'bank',
      JournalEntryModel: bankEngine.models.JournalEntry,
      resolve: periodResolver({
        scope: 'bank',
        PeriodModel: BankReconModel,
        startField: 'statementStart',
        endField: 'statementEnd',
        closedField: 'finalized',
        labelField: 'statementId',
      }),
    }).apply(bankEngine.repositories.journalEntries);

    await BankReconModel.create({
      statementStart: new Date('2026-02-01'),
      statementEnd: new Date('2026-02-28'),
      finalized: true,
      statementId: 'STMT-0042',
    });

    const bankAccts = await bankEngine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1000' },
      { accountTypeCode: '4000' },
    ]);

    const draft = await bankEngine.repositories.journalEntries.create({
      journalType: 'GENERAL',
      state: 'draft',
      date: new Date('2026-02-14'),
      journalItems: [
        { account: bankAccts.created[0]._id, debit: 100, credit: 0 },
        { account: bankAccts.created[1]._id, debit: 0, credit: 100 },
      ],
    });

    try {
      await bankEngine.repositories.journalEntries.post(draft._id);
      throw new Error('expected bespoke bank lock to fire');
    } catch (err) {
      assert.ok(err instanceof AccountingError);
      assert.equal(err.code, 'PERIOD_LOCKED_BANK');
      assert.match(err.message, /STMT-0042/);
    }
  });

  // ── 8. Journal resource (0.6.0) ─────────────────────────────────────

  section('8. Journal resource (seedDefaults + nextSequenceNumber)');

  const journalEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    modelNames: {
      account: 'JnlAccount',
      journalEntry: 'JnlJE',
      fiscalPeriod: 'JnlFP',
      budget: 'JnlBudget',
      reconciliation: 'JnlRecon',
      journal: 'JnlJournal',
    },
  });

  await step('seedDefaults creates the lean default journals', async () => {
    const result = await journalEngine.repositories.journals.seedDefaults('org-smoke');
    assert.equal(result.created, 5);
    assert.equal(result.skipped, 0);
  });

  await step('seedDefaults is idempotent — second run creates zero', async () => {
    const result = await journalEngine.repositories.journals.seedDefaults('org-smoke');
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 5);
  });

  await step('nextSequenceNumber atomically increments per journal', async () => {
    const journals = await journalEngine.repositories.journals.getAll();
    const sales = journals.data.find((j) => j.code === 'SALES');
    const a = await journalEngine.repositories.journals.nextSequenceNumber(sales._id);
    const b = await journalEngine.repositories.journals.nextSequenceNumber(sales._id);
    assert.match(a, /^INV\/\d{4}\/\d{2}\/0001$/);
    assert.match(b, /^INV\/\d{4}\/\d{2}\/0002$/);
  });

  // ── 9. Open-item matching (0.6.0) ───────────────────────────────────

  section('9. Item-level open-item matching (match / unmatch / getOpenItems)');

  const matchPack = defineCountryPack({
    code: 'MAT',
    name: 'Match Pack',
    defaultCurrency: 'USD',
    retainedEarningsAccountCode: '3600',
    taxCodes: {},
    taxCodesByRegion: {},
    regions: [],
    accountTypes: [
      { code: '1100', name: 'AR', category: 'Balance Sheet-Asset', description: 'AR', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '3600', name: 'RE', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
  });

  const matchEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: matchPack,
    currency: 'USD',
    modelNames: {
      account: 'MatAccount',
      journalEntry: 'MatJE',
      fiscalPeriod: 'MatFP',
      budget: 'MatBudget',
      reconciliation: 'MatRecon',
      journal: 'MatJournal',
    },
  });

  const matchAccounts = await matchEngine.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' },
    { accountTypeCode: '1000' },
    { accountTypeCode: '4000' },
  ]);
  const mArId = matchAccounts.created[0]._id;
  const mCashId = matchAccounts.created[1]._id;
  const mRevId = matchAccounts.created[2]._id;

  await step('one payment settles two invoices via item-level match', async () => {
    const inv1 = await matchEngine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-01-10'),
      journalItems: [
        { account: mArId, debit: 300_00, credit: 0 },
        { account: mRevId, debit: 0, credit: 300_00 },
      ],
    });
    const inv2 = await matchEngine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-01-12'),
      journalItems: [
        { account: mArId, debit: 200_00, credit: 0 },
        { account: mRevId, debit: 0, credit: 200_00 },
      ],
    });
    const pay = await matchEngine.repositories.journalEntries.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-01-20'),
      journalItems: [
        { account: mCashId, debit: 500_00, credit: 0 },
        { account: mArId, debit: 0, credit: 500_00 },
      ],
    });

    const rec = await matchEngine.repositories.reconciliations.match({
      account: mArId,
      items: [
        { entry: inv1._id, itemIndex: 0 },
        { entry: inv2._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });
    assert.equal(rec.isFullReconcile, true);
    assert.equal(rec.difference, 0);
    assert.match(rec.matchingNumber, /^RECN-\d+$/);
  });

  await step('getOpenItems returns unmatched items only', async () => {
    const openInv = await matchEngine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-02-01'),
      journalItems: [
        { account: mArId, debit: 150_00, credit: 0 },
        { account: mRevId, debit: 0, credit: 150_00 },
      ],
    });
    const open = await matchEngine.repositories.reconciliations.getOpenItems({ accountId: mArId });
    assert.equal(open.length, 1);
    assert.equal(String(open[0].entry), String(openInv._id));
    assert.equal(open[0].debit, 150_00);
  });

  // ── 10. FX realization (0.6.0) ──────────────────────────────────────

  section('10. FX realization plugin on multi-currency match');

  const fxEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: matchPack,
    currency: 'USD',
    multiCurrency: { enabled: true, currencies: ['CAD'] },
    modelNames: {
      account: 'FxSmAccount',
      journalEntry: 'FxSmJE',
      fiscalPeriod: 'FxSmFP',
      budget: 'FxSmBudget',
      reconciliation: 'FxSmRecon',
      journal: 'FxSmJournal',
    },
  });

  const fxPack = defineCountryPack({
    code: 'FXP',
    name: 'FX Pack',
    defaultCurrency: 'USD',
    retainedEarningsAccountCode: '3600',
    taxCodes: {},
    taxCodesByRegion: {},
    regions: [],
    accountTypes: [
      ...matchPack.accountTypes,
      { code: '7100', name: 'FX Gain', category: 'Income Statement-Income', description: 'Realized FX gain', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '7200', name: 'FX Loss', category: 'Income Statement-Expense', description: 'Realized FX loss', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
  });
  // Re-create engine with the extended pack so FX accounts exist.
  for (const name of ['FxSmAccount','FxSmJE','FxSmFP','FxSmBudget','FxSmRecon','FxSmJournal']) {
    if (mongoose.models[name]) delete mongoose.models[name];
  }
  const fxEngine2 = createAccountingEngine({
    mongoose: mongoose.connection,
    country: fxPack,
    currency: 'USD',
    multiCurrency: { enabled: true, currencies: ['CAD'] },
    modelNames: {
      account: 'FxSmAccount',
      journalEntry: 'FxSmJE',
      fiscalPeriod: 'FxSmFP',
      budget: 'FxSmBudget',
      reconciliation: 'FxSmRecon',
      journal: 'FxSmJournal',
    },
  });

  const fxAccts = await fxEngine2.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' },
    { accountTypeCode: '1000' },
    { accountTypeCode: '4000' },
    { accountTypeCode: '7100' },
    { accountTypeCode: '7200' },
  ]);
  const fxArId = fxAccts.created[0]._id;
  const fxCashId = fxAccts.created[1]._id;
  const fxRevId = fxAccts.created[2]._id;
  const fxGainId = fxAccts.created[3]._id;
  const fxLossId = fxAccts.created[4]._id;

  fxRealizationPlugin({
    journalEntries: fxEngine2.repositories.journalEntries,
    realizedGainAccount: fxGainId,
    realizedLossAccount: fxLossId,
    baseCurrency: 'USD',
  }).apply(fxEngine2.repositories.reconciliations);

  await step('CAD invoice @0.73 + CAD payment @0.78 → realized gain auto-booked', async () => {
    const inv = await fxEngine2.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-02-10'),
      journalItems: [
        { account: fxArId, debit: 730_00, credit: 0, currency: 'CAD', exchangeRate: 0.73, originalDebit: 1_000_00, originalCredit: 0 },
        { account: fxRevId, debit: 0, credit: 730_00, currency: 'CAD', exchangeRate: 0.73, originalDebit: 0, originalCredit: 1_000_00 },
      ],
    });
    const pay = await fxEngine2.repositories.journalEntries.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-02-25'),
      journalItems: [
        { account: fxCashId, debit: 780_00, credit: 0, currency: 'CAD', exchangeRate: 0.78, originalDebit: 1_000_00, originalCredit: 0 },
        { account: fxArId, debit: 0, credit: 780_00, currency: 'CAD', exchangeRate: 0.78, originalDebit: 0, originalCredit: 1_000_00 },
      ],
    });

    const rec = await fxEngine2.repositories.reconciliations.match({
      account: fxArId,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });

    const ReconModel = fxEngine2.models.Reconciliation;
    const doc = await ReconModel.findOne({ matchingNumber: rec.matchingNumber }).lean();
    assert.ok(doc.fxRealizationEntry, 'FX entry should be booked');

    const fxEntry = await fxEngine2.repositories.journalEntries.getById(doc.fxRealizationEntry);
    assert.equal(fxEntry.totalDebit, 50_00);
    assert.equal(fxEntry.totalCredit, 50_00);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 12. Scenario — Full ERP A/P + A/R cycle (the integration story)
  // ═══════════════════════════════════════════════════════════════════
  //
  // This section is a *scenario* test, not a unit one — it walks through
  // the canonical ERP workflow that the package was designed to support,
  // and asserts at every meaningful checkpoint:
  //
  //   1. Receive goods from supplier on credit (Dr Inventory / Cr A/P)
  //   2. Open A/P shows the bill in the supplier ledger
  //   3. Sell on credit to a customer (Dr A/R / Cr Revenue)
  //   4. creditLimitPlugin enforces the customer's limit
  //   5. Customer pays partially — match against the invoice
  //   6. Partner ledger shows running balance + remaining open item
  //   7. Pay the supplier in two cheques covering the bill
  //   8. Supplier ledger closes to zero
  //   9. Aged-balance report shows zero open AP, the partial AR
  //  10. End-to-end audit chain via referenceNumber + matchingNumber

  section('12. Scenario — Full ERP A/P + A/R cycle (Acme Trading)');

  const erpPack = defineCountryPack({
    code: 'ERP',
    name: 'Acme Trading Pack',
    defaultCurrency: 'USD',
    retainedEarningsAccountCode: '3600',
    taxCodes: {},
    taxCodesByRegion: {},
    regions: [],
    accountTypes: [
      { code: '1100', name: 'Accounts Receivable', category: 'Balance Sheet-Asset', description: 'AR control', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '2100', name: 'Accounts Payable', category: 'Balance Sheet-Liability', description: 'AP control', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '1500', name: 'Inventory', category: 'Balance Sheet-Asset', description: 'Inventory', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
      { code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '5000', name: 'Cost of Goods Sold', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
      { code: '3600', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
    ],
  });

  const acme = createAccountingEngine({
    mongoose: mongoose.connection,
    country: erpPack,
    currency: 'USD',
    schemaOptions: {
      journalEntry: {
        // Tag every journal item with a partnerId so the supplier and
        // customer subsidiary ledgers work without any extra collections.
        // This is THE pattern for A/P + A/R subsidiary ledgers.
        extraItemFields: {
          partnerId: { type: String, default: null, index: true },
        },
        extraIndexes: [
          {
            fields: { 'journalItems.partnerId': 1, 'journalItems.matchingNumber': 1 },
          },
        ],
      },
    },
    modelNames: {
      account: 'AcmeAccount',
      journalEntry: 'AcmeJE',
      fiscalPeriod: 'AcmeFP',
      budget: 'AcmeBudget',
      reconciliation: 'AcmeRecon',
      journal: 'AcmeJournal',
    },
  });

  const acmeAccts = await acme.repositories.accounts.bulkCreate([
    { accountTypeCode: '1100' },
    { accountTypeCode: '2100' },
    { accountTypeCode: '1000' },
    { accountTypeCode: '1500' },
    { accountTypeCode: '4000' },
    { accountTypeCode: '5000' },
  ]);
  const acmeArId = acmeAccts.created[0]._id;
  const acmeApId = acmeAccts.created[1]._id;
  const acmeCashId = acmeAccts.created[2]._id;
  const acmeInvId = acmeAccts.created[3]._id;
  const acmeRevId = acmeAccts.created[4]._id;

  // Wire credit-limit plugin: customer "wholesale-1" has a $5000 limit.
  const creditLimits = { 'wholesale-1': 5_000_00 };
  creditLimitPlugin({
    arControlAccountId: acmeArId,
    JournalEntryModel: acme.models.JournalEntry,
    getCreditLimit: (partnerId) => creditLimits[String(partnerId)] ?? null,
  }).apply(acme.repositories.journalEntries);

  let supplierBillId;
  let customerInvoiceId;

  await step('① Receive goods from supplier-A on credit ($2000) — Dr Inventory / Cr A/P', async () => {
    const bill = await acme.repositories.journalEntries.create({
      journalType: 'PURCHASES',
      state: 'posted',
      date: new Date('2026-02-05'),
      label: 'Bill #PO-2025-001 from supplier-A',
      journalItems: [
        { account: acmeInvId, debit: 2_000_00, credit: 0 },
        {
          account: acmeApId,
          debit: 0,
          credit: 2_000_00,
          partnerId: 'supplier-A',
          maturityDate: new Date('2026-03-07'), // 30-day terms
        },
      ],
    });
    supplierBillId = bill._id;
    assert.equal(bill.totalDebit, 2_000_00);
  });

  await step('② Supplier ledger shows the open bill ($2000 owed to supplier-A)', async () => {
    const open = await acme.repositories.reconciliations.getOpenItems({
      accountId: acmeApId,
      filter: { partnerId: 'supplier-A' },
    });
    assert.equal(open.length, 1);
    assert.equal(open[0].credit, 2_000_00);
    assert.equal(open[0].debit, 0);
  });

  await step('③ Sell to wholesale-1 on credit ($3000, due in 30 days) — passes credit limit', async () => {
    const inv = await acme.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-02-10'),
      label: 'Invoice #INV-2026-001 to wholesale-1',
      journalItems: [
        {
          account: acmeArId,
          debit: 3_000_00,
          credit: 0,
          partnerId: 'wholesale-1',
          maturityDate: new Date('2026-03-12'),
        },
        { account: acmeRevId, debit: 0, credit: 3_000_00 },
      ],
    });
    customerInvoiceId = inv._id;
    assert.equal(inv.state, 'posted');
  });

  await step('④ A second sale to wholesale-1 ($2500) breaches limit ($3000 + $2500 > $5000)', async () => {
    try {
      await acme.repositories.journalEntries.create({
        journalType: 'SALES',
        state: 'posted',
        date: new Date('2026-02-12'),
        label: 'Invoice #INV-2026-002 to wholesale-1',
        journalItems: [
          {
            account: acmeArId,
            debit: 2_500_00,
            credit: 0,
            partnerId: 'wholesale-1',
            maturityDate: new Date('2026-03-14'),
          },
          { account: acmeRevId, debit: 0, credit: 2_500_00 },
        ],
      });
      throw new Error('expected credit limit to fire');
    } catch (err) {
      assert.ok(err instanceof AccountingError);
      assert.equal(err.code, 'CREDIT_LIMIT_EXCEEDED');
      assert.equal(err.status, 402);
    }
  });

  await step('⑤ Customer pays $1000 — match against invoice (partial)', async () => {
    const pay = await acme.repositories.journalEntries.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-02-25'),
      label: 'Payment #PAY-2026-001 from wholesale-1',
      journalItems: [
        { account: acmeCashId, debit: 1_000_00, credit: 0 },
        { account: acmeArId, debit: 0, credit: 1_000_00, partnerId: 'wholesale-1' },
      ],
    });
    const rec = await acme.repositories.reconciliations.match({
      account: acmeArId,
      items: [
        { entry: customerInvoiceId, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });
    assert.equal(rec.isFullReconcile, false); // partial — invoice still has 2000 open
    assert.equal(rec.difference, 2_000_00);
  });

  await step('⑥ generatePartnerLedger shows running balance + remaining $2000 open', async () => {
    const statement = await generatePartnerLedger(
      { AccountModel: acme.models.Account, JournalEntryModel: acme.models.JournalEntry },
      {
        controlAccountId: acmeArId,
        partnerId: 'wholesale-1',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      },
    );
    assert.equal(statement.openingBalance, 0);
    assert.equal(statement.lines.length, 2);
    assert.equal(statement.lines[0].debit, 3_000_00);
    assert.equal(statement.lines[1].credit, 1_000_00);
    assert.equal(statement.closingBalance, 2_000_00);
    // Both lines are now flagged matched (same matchingNumber) — but the
    // partial settlement leaves 2000 open against the customer.
    assert.equal(statement.lines.every((l) => l.isMatched), true);
  });

  await step('⑦ Pay supplier-A in two cheques ($800 + $1200) — match all 3 items', async () => {
    const pay1 = await acme.repositories.journalEntries.create({
      journalType: 'CASH_PAYMENTS',
      state: 'posted',
      date: new Date('2026-02-28'),
      label: 'Payment #PAY-SUP-001 to supplier-A',
      journalItems: [
        { account: acmeApId, debit: 800_00, credit: 0, partnerId: 'supplier-A' },
        { account: acmeCashId, debit: 0, credit: 800_00 },
      ],
    });
    const pay2 = await acme.repositories.journalEntries.create({
      journalType: 'CASH_PAYMENTS',
      state: 'posted',
      date: new Date('2026-03-05'),
      label: 'Payment #PAY-SUP-002 to supplier-A',
      journalItems: [
        { account: acmeApId, debit: 1_200_00, credit: 0, partnerId: 'supplier-A' },
        { account: acmeCashId, debit: 0, credit: 1_200_00 },
      ],
    });

    const rec = await acme.repositories.reconciliations.match({
      account: acmeApId,
      items: [
        { entry: supplierBillId, itemIndex: 1 }, // A/P credit on the bill
        { entry: pay1._id, itemIndex: 0 },        // A/P debit on cheque 1
        { entry: pay2._id, itemIndex: 0 },        // A/P debit on cheque 2
      ],
    });
    assert.equal(rec.isFullReconcile, true);
    assert.equal(rec.difference, 0);
  });

  await step('⑧ Supplier ledger closes to zero — no open items for supplier-A', async () => {
    const open = await acme.repositories.reconciliations.getOpenItems({
      accountId: acmeApId,
      filter: { partnerId: 'supplier-A' },
    });
    assert.equal(open.length, 0);
  });

  // ── ⑨ Post a SECOND supplier-B bill so the per-supplier breakdown
  //     assertion below has something to actually break down. Without
  //     this, generateAgedBalance returns zero rows after step ⑧ closed
  //     out supplier-A, which would make the next assertion vacuous.
  await step('⑨ Receive a second bill from supplier-B ($1500, due Feb 28) — leaves it open', async () => {
    await acme.repositories.journalEntries.create({
      journalType: 'PURCHASES',
      state: 'posted',
      date: new Date('2026-01-28'),
      label: 'Bill #PO-2025-002 from supplier-B',
      journalItems: [
        { account: acmeInvId, debit: 1_500_00, credit: 0 },
        {
          account: acmeApId,
          debit: 0,
          credit: 1_500_00,
          partnerId: 'supplier-B',
          maturityDate: new Date('2026-02-28'),
        },
      ],
    });
  });

  await step('⑩ "What bills are overdue?" — getOpenItems + maturityDate filter', async () => {
    // Question 4 from the reviewer's table. The pure-mongokit way:
    // pull every open A/P item and let the consumer filter on
    // `maturityDate < today`. We assert against an as-of date of
    // 2026-04-01 to make supplier-B's Feb 28 bill clearly overdue.
    const allOpen = await acme.repositories.reconciliations.getOpenItems({
      accountId: acmeApId,
    });
    const asOf = new Date('2026-04-01');
    const overdue = allOpen.filter((it) => it.maturityDate && new Date(it.maturityDate) < asOf);
    assert.equal(overdue.length, 1, 'exactly one bill should be overdue');
    assert.equal(String(overdue[0].item.partnerId), 'supplier-B');
    assert.equal(overdue[0].credit, 1_500_00);
  });

  await step('⑪ Aged-balance report — break down 2111 by supplier (the trial-balance question)', async () => {
    // Question 6 from the reviewer's table. This is the assertion
    // that proves "Trial balance shows $X in 2111, break it down by
    // supplier" actually works with the contactField path. We have:
    //   - supplier-A:  bill 2000 + payments (800+1200) = matched, net 0
    //   - supplier-B:  bill 1500, no payment, still open
    const { generateAgedBalance } = await import('@classytic/ledger');
    const apAging = await generateAgedBalance(
      { AccountModel: acme.models.Account, JournalEntryModel: acme.models.JournalEntry, country: erpPack },
      {
        type: 'payable',
        asOfDate: new Date('2026-04-01'),
        contactField: 'journalItems.partnerId',
      },
    );

    // The report aggregates raw items, so supplier-A's matched bill +
    // matched payments still appear (and net to zero). What MUST be
    // present, regardless: at least one row tagged with `supplier-B`
    // carrying a 1500 balance. That's the per-supplier breakdown.
    const supplierBRow = apAging.rows.find((r) => String(r.contactId) === 'supplier-B');
    assert.ok(supplierBRow, 'supplier-B should appear as a row in the aged-balance breakdown');
    assert.equal(supplierBRow.total, 1_500_00, 'supplier-B total should match the open bill');

    // And supplier-A, if it appears, should net to zero — proving the
    // partition between the two partners is real and not bleeding.
    const supplierARow = apAging.rows.find((r) => String(r.contactId) === 'supplier-A');
    if (supplierARow) {
      assert.equal(supplierARow.total, 0, 'supplier-A net balance should be zero after full settlement');
    }

    // Grand total is just supplier-B's $1500 since supplier-A nets out.
    assert.equal(apAging.grandTotal, 1_500_00);
  });

  await step('⑫ Audit chain — every entry has a referenceNumber', async () => {
    const all = await acme.repositories.journalEntries.getAll();
    const refs = all.data.map((d) => d.referenceNumber);
    assert.ok(refs.every((r) => typeof r === 'string' && r.length > 0));
    // 6 entries: bill-A, bill-B, invoice, cust-payment, sup-pay-1, sup-pay-2
    // (the failed second sale was rejected by credit limit)
    assert.equal(all.data.length, 6);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 13. @classytic/ledger-bd — country pack integration (0.7+)
  // ═══════════════════════════════════════════════════════════════════
  //
  // Imports the REAL `bangladeshPack` from the freshly built
  // `@classytic/ledger-bd` dist via a `file:..` link in
  // example/package.json. If the BD pack ships a chart-of-accounts
  // mismatch or a broken journalTemplates field, this step blows up
  // and the publish gate stops the release.
  //
  // The cycle exercises BFRS A/P (2111) + A/R (1141) + Mushak journals.
  // Tax (Mushak return / VAT compute) lives in @classytic/bd-tax — NOT
  // tested here because it is a separate package.

  section('13. @classytic/ledger-bd integration (real pack via file: link)');

  const { bangladeshPack } = await import('@classytic/ledger-bd');

  await step('bangladeshPack imports cleanly + carries journalTemplates (NO tax fields in 0.7)', async () => {
    assert.equal(bangladeshPack.code, 'BD');
    assert.equal(bangladeshPack.defaultCurrency, 'BDT');
    assert.ok(Array.isArray(bangladeshPack.journalTemplates), 'BD pack should ship journalTemplates');
    assert.ok(bangladeshPack.journalTemplates.length >= 5, 'BD pack should ship at least 5 default journals');
    // Tax interfaces have moved to @classytic/bd-tax — the country pack
    // is now PURE chart-of-accounts. Confirm none of them leak through.
    assert.equal(bangladeshPack.resolveTaxRepartitionAccountCode, undefined);
    assert.equal(bangladeshPack.taxCodes, undefined);
    assert.equal(bangladeshPack.taxReport, undefined);
    assert.equal(bangladeshPack.regions, undefined);
  });

  const bdEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: bangladeshPack,
    currency: 'BDT',
    schemaOptions: {
      journalEntry: {
        extraItemFields: {
          partnerId: { type: String, default: null, index: true },
        },
      },
    },
    modelNames: {
      account: 'BdAccount',
      journalEntry: 'BdJE',
      fiscalPeriod: 'BdFP',
      budget: 'BdBudget',
      reconciliation: 'BdRecon',
      journal: 'BdJournal',
    },
  });

  await step('seed BFRS A/P (2111), A/R (1141), Cash (1111), Inventory (1161), Revenue (4111)', async () => {
    const result = await bdEngine.repositories.accounts.bulkCreate([
      { accountTypeCode: '2111', name: 'Trade Payables' },
      { accountTypeCode: '1141', name: 'Trade Receivables' },
      { accountTypeCode: '1111', name: 'Cash in Hand' },
      { accountTypeCode: '1161', name: 'Raw Materials' },
      { accountTypeCode: '4111', name: 'Sales — Domestic' },
    ]);
    assert.equal(result.summary.created, 5);
  });

  await step('seedDefaults() creates BD Mushak journals (Sales/Purchase/VDS/TDS/Cash/Bank)', async () => {
    const seed = await bdEngine.repositories.journals.seedDefaults('bd-org');
    assert.ok(seed.created >= 5, 'BD pack should seed at least 5 default journals');
    const journals = await bdEngine.repositories.journals.getAll();
    const codes = journals.data.map((j) => j.code).sort();
    assert.ok(codes.includes('SALES'));
    assert.ok(codes.includes('PURCHASE'));
    assert.ok(codes.includes('VDS') || codes.includes('TDS'), 'BD pack should ship VDS/TDS withholding journals');
  });

  await step('post a BD credit purchase + match against payment via 2111', async () => {
    const accts = await bdEngine.repositories.accounts.getAll();
    const ap = accts.data.find((a) => a.accountTypeCode === '2111');
    const cash = accts.data.find((a) => a.accountTypeCode === '1111');
    const inv = accts.data.find((a) => a.accountTypeCode === '1161');

    const bill = await bdEngine.repositories.journalEntries.create({
      journalType: 'PURCHASES',
      state: 'posted',
      date: new Date('2026-02-05'),
      label: 'Mushak bill from Padma Suppliers',
      journalItems: [
        { account: inv._id, debit: 50_000_00 },
        {
          account: ap._id,
          credit: 50_000_00,
          partnerId: 'padma-suppliers',
          maturityDate: new Date('2026-03-07'),
        },
      ],
    });

    const payment = await bdEngine.repositories.journalEntries.create({
      journalType: 'CASH_PAYMENTS',
      state: 'posted',
      date: new Date('2026-02-25'),
      label: 'Cash payment to Padma Suppliers',
      journalItems: [
        { account: ap._id, debit: 50_000_00, partnerId: 'padma-suppliers' },
        { account: cash._id, credit: 50_000_00 },
      ],
    });

    const rec = await bdEngine.repositories.reconciliations.match({
      account: ap._id,
      items: [
        { entry: bill._id, itemIndex: 1 },
        { entry: payment._id, itemIndex: 0 },
      ],
    });
    assert.equal(rec.isFullReconcile, true);

    const open = await bdEngine.repositories.reconciliations.getOpenItems({
      accountId: ap._id,
      filter: { partnerId: 'padma-suppliers' },
    });
    assert.equal(open.length, 0);
  });

  await step('generatePartnerLedger against BFRS 2111 returns the BD supplier statement', async () => {
    const accts = await bdEngine.repositories.accounts.getAll();
    const ap = accts.data.find((a) => a.accountTypeCode === '2111');
    const statement = await generatePartnerLedger(
      { AccountModel: bdEngine.models.Account, JournalEntryModel: bdEngine.models.JournalEntry },
      {
        controlAccountId: ap._id,
        partnerId: 'padma-suppliers',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      },
    );
    assert.equal(statement.lines.length, 2, 'should show the bill + payment');
    assert.equal(statement.closingBalance, 0, 'fully settled');
    assert.equal(statement.metadata.controlAccount.code, '2111');
  });

  // ═══════════════════════════════════════════════════════════════════
  // 14. @classytic/ledger-ca — country pack integration
  // ═══════════════════════════════════════════════════════════════════

  section('14. @classytic/ledger-ca integration (real pack via file: link)');

  const { canadaPack } = await import('@classytic/ledger-ca');

  await step('canadaPack imports cleanly + carries journalTemplates + GIFI codes (NO tax in 0.7)', async () => {
    assert.equal(canadaPack.code, 'CA');
    assert.equal(canadaPack.defaultCurrency, 'CAD');
    assert.ok(Array.isArray(canadaPack.journalTemplates));
    assert.ok(canadaPack.journalTemplates.length >= 5);
    // Tax interfaces have moved to @classytic/ca-tax (forthcoming).
    assert.equal(canadaPack.resolveTaxRepartitionAccountCode, undefined);
    assert.equal(canadaPack.taxCodes, undefined);
    assert.equal(canadaPack.taxReport, undefined);
  });

  const caEngine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: canadaPack,
    currency: 'CAD',
    schemaOptions: {
      journalEntry: {
        extraItemFields: {
          partnerId: { type: String, default: null, index: true },
        },
      },
    },
    modelNames: {
      account: 'CaAccount',
      journalEntry: 'CaJE',
      fiscalPeriod: 'CaFP',
      budget: 'CaBudget',
      reconciliation: 'CaRecon',
      journal: 'CaJournal',
    },
  });

  await step('seed CA GIFI A/P (2620) + A/R (1060) + Cash (1000) + Revenue (8000)', async () => {
    // Use whatever GIFI codes the CA pack ships — pull them by category.
    const arType = canadaPack.accountTypes.find((a) => /receivable/i.test(a.name)) ??
      canadaPack.accountTypes.find((a) => a.code === '1060');
    const apType = canadaPack.accountTypes.find((a) => /payable/i.test(a.name)) ??
      canadaPack.accountTypes.find((a) => a.code === '2620');
    const cashType = canadaPack.accountTypes.find((a) => a.code === '1000') ??
      canadaPack.accountTypes.find((a) => /cash/i.test(a.name));
    const revType = canadaPack.accountTypes.find((a) => a.code === '8000') ??
      canadaPack.accountTypes.find((a) => /sales/i.test(a.name));

    assert.ok(arType, 'CA pack should expose an A/R account type');
    assert.ok(apType, 'CA pack should expose an A/P account type');
    assert.ok(cashType, 'CA pack should expose a Cash account type');
    assert.ok(revType, 'CA pack should expose a Revenue account type');

    const result = await caEngine.repositories.accounts.bulkCreate([
      { accountTypeCode: arType.code },
      { accountTypeCode: apType.code },
      { accountTypeCode: cashType.code },
      { accountTypeCode: revType.code },
    ]);
    assert.equal(result.summary.created, 4);
  });

  await step('seedDefaults() creates CA journals (Sales/Purchase/Bank/Cash/Payroll)', async () => {
    const seed = await caEngine.repositories.journals.seedDefaults('ca-org');
    assert.ok(seed.created >= 5);
    const journals = await caEngine.repositories.journals.getAll();
    const codes = journals.data.map((j) => j.code);
    assert.ok(codes.includes('PAYROLL'), 'CA pack should include the Payroll journal');
  });

  await step('full credit-sale → partial-payment → match → partner statement against GIFI A/R', async () => {
    const accts = await caEngine.repositories.accounts.getAll();
    const ar = accts.data.find((a) => /receivable/i.test(a.name));
    const cash = accts.data.find((a) => /cash/i.test(a.name));
    const rev = accts.data.find((a) => /sales/i.test(a.name));

    const inv = await caEngine.repositories.journalEntries.create({
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-02-10'),
      label: 'Invoice to Maple Foods',
      journalItems: [
        { account: ar._id, debit: 4_500_00, partnerId: 'maple-foods', maturityDate: new Date('2026-03-12') },
        { account: rev._id, credit: 4_500_00 },
      ],
    });

    const pay = await caEngine.repositories.journalEntries.create({
      journalType: 'CASH_RECEIPTS',
      state: 'posted',
      date: new Date('2026-02-28'),
      label: 'Partial payment from Maple Foods',
      journalItems: [
        { account: cash._id, debit: 2_000_00 },
        { account: ar._id, credit: 2_000_00, partnerId: 'maple-foods' },
      ],
    });

    const rec = await caEngine.repositories.reconciliations.match({
      account: ar._id,
      items: [
        { entry: inv._id, itemIndex: 0 },
        { entry: pay._id, itemIndex: 1 },
      ],
    });
    assert.equal(rec.isFullReconcile, false, 'partial settlement, not fully matched');
    assert.equal(rec.difference, 2_500_00);

    const statement = await generatePartnerLedger(
      { AccountModel: caEngine.models.Account, JournalEntryModel: caEngine.models.JournalEntry },
      {
        controlAccountId: ar._id,
        partnerId: 'maple-foods',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      },
    );
    assert.equal(statement.closingBalance, 2_500_00, 'CA partner ledger reflects the partial settlement');
    assert.equal(statement.lines.length, 2);
  });

  // ── Report ───────────────────────────────────────────────────────────

  section('Report');
  console.log(`  ${GREEN}${passed} passed${RESET}, ${failed ? RED : DIM}${failed} failed${RESET}`);

  if (failed > 0) {
    console.log(`\n${RED}${BOLD}SMOKE TEST FAILED${RESET}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${GREEN}${BOLD}SMOKE TEST PASSED${RESET} ${DIM}— @classytic/ledger is publish-ready${RESET}`);
  }
} finally {
  await mongoose.disconnect();
  await mongod.stop();
}
