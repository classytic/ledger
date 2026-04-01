import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAccountSchema } from '../../src/schemas/account.schema.js';
import { createJournalEntrySchema } from '../../src/schemas/journal-entry.schema.js';
import { defineCountryPack } from '../../src/country/index.js';
import type { AccountingEngineConfig } from '../../src/types/engine.js';
import { generateDimensionBreakdown } from '../../src/reports/dimension-breakdown.js';
import { buildDimensionFields } from '../../src/utils/dimensions.js';

// ── Test country pack ────────────────────────────────────────────────────────

const testPack = defineCountryPack({
  code: 'DIM', name: 'Dimension Test', defaultCurrency: 'TST',
  retainedEarningsAccountCode: '3660',
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'operating' },
    { code: '4000', name: 'Sales Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '5000', name: 'Cost of Sales', category: 'Income Statement-Expense', description: 'COGS', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '6000', name: 'Rent Expense', category: 'Income Statement-Expense', description: 'Rent', parentCode: null, isTotal: false, cashFlowCategory: null },
    { code: '3660', name: 'Retained Earnings', category: 'Balance Sheet-Equity', description: 'RE', parentCode: null, isTotal: false, cashFlowCategory: null },
  ],
  taxCodes: {}, taxCodesByRegion: {}, regions: [],
});

// ── Setup ────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let AccountModel: mongoose.Model<any>;
let JEModel: mongoose.Model<any>;

let cashId: mongoose.Types.ObjectId;
let revenueId: mongoose.Types.ObjectId;
let cogsId: mongoose.Types.ObjectId;
let rentId: mongoose.Types.ObjectId;

const deptA = new mongoose.Types.ObjectId();
const deptB = new mongoose.Types.ObjectId();
const orgId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const dimensionFields = buildDimensionFields([
    { field: 'departmentId', label: 'Department', ref: 'Department' },
  ]);

  const config: AccountingEngineConfig = {
    country: testPack,
    currency: 'TST',
  };

  const acctSchema = createAccountSchema(config);
  if (mongoose.models['DimAccount']) delete mongoose.models['DimAccount'];
  AccountModel = mongoose.model('DimAccount', acctSchema);

  const jeSchema = createJournalEntrySchema(
    config,
    'DimAccount',
    { extraItemFields: dimensionFields },
  );
  if (mongoose.models['DimJE']) delete mongoose.models['DimJE'];
  JEModel = mongoose.model('DimJE', jeSchema);

  await AccountModel.createIndexes();
  await JEModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await JEModel.deleteMany({});

  const cash = await AccountModel.create({ accountTypeCode: '1000' });
  const rev = await AccountModel.create({ accountTypeCode: '4000' });
  const cogs = await AccountModel.create({ accountTypeCode: '5000' });
  const rent = await AccountModel.create({ accountTypeCode: '6000' });

  cashId = cash._id;
  revenueId = rev._id;
  cogsId = cogs._id;
  rentId = rent._id;
});

/** Helper: create a posted journal entry with dimension fields */
async function postEntry(
  date: string,
  items: Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number; departmentId?: mongoose.Types.ObjectId | null }>,
) {
  return JEModel.create({
    journalType: 'GENERAL',
    state: 'posted',
    date: new Date(date),
    journalItems: items,
    totalDebit: items.reduce((s, i) => s + i.debit, 0),
    totalCredit: items.reduce((s, i) => s + i.credit, 0),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateDimensionBreakdown', () => {
  it('groups expenses by dimension value correctly', async () => {
    // Dept A: rent 50000, COGS 30000
    // Dept B: rent 20000
    await postEntry('2025-03-15', [
      { account: rentId, debit: 50000, credit: 0, departmentId: deptA },
      { account: cashId, debit: 0, credit: 50000 },
    ]);
    await postEntry('2025-03-16', [
      { account: cogsId, debit: 30000, credit: 0, departmentId: deptA },
      { account: cashId, debit: 0, credit: 30000 },
    ]);
    await postEntry('2025-03-17', [
      { account: rentId, debit: 20000, credit: 0, departmentId: deptB },
      { account: cashId, debit: 0, credit: 20000 },
    ]);

    const report = await generateDimensionBreakdown(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31') },
        dimension: 'departmentId',
        accountCategory: 'Income Statement-Expense',
      },
    );

    expect(report.rows).toHaveLength(2);
    expect(report.grandTotal).toBe(100000); // 50000 + 30000 + 20000

    // Find Dept A row
    const rowA = report.rows.find(r => String(r.dimensionValue) === String(deptA))!;
    expect(rowA).toBeDefined();
    expect(rowA.total).toBe(80000); // 50000 + 30000
    expect(rowA.accounts).toHaveLength(2);
    // Sorted by code: 5000 < 6000
    expect(rowA.accounts[0].code).toBe('5000');
    expect(rowA.accounts[0].balance).toBe(30000);
    expect(rowA.accounts[1].code).toBe('6000');
    expect(rowA.accounts[1].balance).toBe(50000);

    // Find Dept B row
    const rowB = report.rows.find(r => String(r.dimensionValue) === String(deptB))!;
    expect(rowB).toBeDefined();
    expect(rowB.total).toBe(20000);
    expect(rowB.accounts).toHaveLength(1);
  });

  it('returns empty rows when no data', async () => {
    const report = await generateDimensionBreakdown(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-06-01'), endDate: new Date('2025-06-30') },
        dimension: 'departmentId',
      },
    );

    expect(report.rows).toHaveLength(0);
    expect(report.grandTotal).toBe(0);
    expect(report.metadata.dimension).toBe('departmentId');
  });

  it('filters by account category', async () => {
    // Post revenue and expense to same department
    await postEntry('2025-03-15', [
      { account: revenueId, debit: 0, credit: 100000, departmentId: deptA },
      { account: cashId, debit: 100000, credit: 0 },
    ]);
    await postEntry('2025-03-16', [
      { account: rentId, debit: 40000, credit: 0, departmentId: deptA },
      { account: cashId, debit: 0, credit: 40000 },
    ]);

    // Only expenses
    const expenseReport = await generateDimensionBreakdown(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31') },
        dimension: 'departmentId',
        accountCategory: 'Income Statement-Expense',
      },
    );

    expect(expenseReport.grandTotal).toBe(40000);
    expect(expenseReport.rows).toHaveLength(1);

    // Only income
    const incomeReport = await generateDimensionBreakdown(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31') },
        dimension: 'departmentId',
        accountCategory: 'Income Statement-Income',
      },
    );

    expect(incomeReport.grandTotal).toBe(100000);
    expect(incomeReport.rows).toHaveLength(1);
  });

  it('handles null dimension values (ungrouped)', async () => {
    // Entry with no departmentId on the expense item
    await postEntry('2025-03-15', [
      { account: rentId, debit: 25000, credit: 0, departmentId: null },
      { account: cashId, debit: 0, credit: 25000 },
    ]);
    // Entry with departmentId
    await postEntry('2025-03-16', [
      { account: rentId, debit: 15000, credit: 0, departmentId: deptA },
      { account: cashId, debit: 0, credit: 15000 },
    ]);

    const report = await generateDimensionBreakdown(
      { AccountModel, JournalEntryModel: JEModel, country: testPack },
      {
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31') },
        dimension: 'departmentId',
        accountCategory: 'Income Statement-Expense',
      },
    );

    expect(report.rows).toHaveLength(2);
    expect(report.grandTotal).toBe(40000);

    // Null row should be last (sorted after non-null)
    const nullRow = report.rows[report.rows.length - 1];
    expect(nullRow.dimensionValue).toBeNull();
    expect(nullRow.total).toBe(25000);

    const deptRow = report.rows[0];
    expect(deptRow.dimensionValue).not.toBeNull();
    expect(deptRow.total).toBe(15000);
  });

  it('multi-tenant scoping', async () => {
    // Create a multi-tenant config
    const mtConfig: AccountingEngineConfig = {
      country: testPack,
      currency: 'TST',
      multiTenant: { orgField: 'business', orgRef: 'Business' },
    };

    const dimensionFields = buildDimensionFields([
      { field: 'departmentId', label: 'Department', ref: 'Department' },
    ]);

    const mtAcctSchema = createAccountSchema(mtConfig);
    if (mongoose.models['MtDimAccount']) delete mongoose.models['MtDimAccount'];
    const MtAccountModel = mongoose.model('MtDimAccount', mtAcctSchema);

    const mtJeSchema = createJournalEntrySchema(
      mtConfig,
      'MtDimAccount',
      { extraItemFields: dimensionFields },
    );
    if (mongoose.models['MtDimJE']) delete mongoose.models['MtDimJE'];
    const MtJEModel = mongoose.model('MtDimJE', mtJeSchema);

    await MtAccountModel.createIndexes();
    await MtJEModel.createIndexes();

    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    // Create accounts for each org
    const accA = await MtAccountModel.create({ accountTypeCode: '6000', business: orgA });
    const accB = await MtAccountModel.create({ accountTypeCode: '6000', business: orgB });
    const cashA = await MtAccountModel.create({ accountTypeCode: '1000', business: orgA });
    const cashB = await MtAccountModel.create({ accountTypeCode: '1000', business: orgB });

    // Post entries for each org
    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-15'),
      business: orgA,
      journalItems: [
        { account: accA._id, debit: 60000, credit: 0, departmentId: deptA },
        { account: cashA._id, debit: 0, credit: 60000 },
      ],
      totalDebit: 60000,
      totalCredit: 60000,
    });

    await MtJEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-03-15'),
      business: orgB,
      journalItems: [
        { account: accB._id, debit: 90000, credit: 0, departmentId: deptA },
        { account: cashB._id, debit: 0, credit: 90000 },
      ],
      totalDebit: 90000,
      totalCredit: 90000,
    });

    // Query org A only
    const report = await generateDimensionBreakdown(
      { AccountModel: MtAccountModel, JournalEntryModel: MtJEModel, country: testPack, orgField: 'business' },
      {
        organizationId: orgA,
        dateOption: 'custom',
        dateValue: { startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31') },
        dimension: 'departmentId',
        accountCategory: 'Income Statement-Expense',
      },
    );

    expect(report.grandTotal).toBe(60000);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].total).toBe(60000);

    // Cleanup
    await MtAccountModel.deleteMany({});
    await MtJEModel.deleteMany({});
  });
});
