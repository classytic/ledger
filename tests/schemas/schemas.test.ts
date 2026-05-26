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
  multiTenant: { tenantField: 'business', ref: 'Business' },
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

  it('accepts any accountTypeCode at schema level (country-pack validation is at repository layer)', async () => {
    const schema = createAccountSchema(stConfig);
    // Clear any previous model registrations for this test
    if (mongoose.models.TestAccount) delete mongoose.models.TestAccount;
    const Model = mongoose.model('TestAccount', schema);

    // Schema accepts any string — country pack validation happens in the repository,
    // not in Mongoose schema validators (see account.schema.ts comment).
    const valid = new Model({ accountTypeCode: '1000' });
    await expect(valid.validate()).resolves.toBeUndefined();

    const unknown = new Model({ accountTypeCode: 'NONEXISTENT' });
    await expect(unknown.validate()).resolves.toBeUndefined();
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

  // ── 0.13.0 — entry-level sourceRef ──────────────────────────────────────
  //
  // Hosts stamp the back-reference after import via
  //   updateMany({ _importRunId }, { $set: { sourceRef: { … } } })
  // and then drill from "source document → journal entries" via
  //   find({ 'sourceRef.sourceId': id }).
  //
  // The four-field shape mirrors `SourceRef` in bridges/source.bridge.ts —
  // `sourceModel`/`sourceId` are canonical, `label`/`kind` are denormalized
  // so the UI can render the source name + sub-type without a follow-up
  // SourceBridge.resolve() call.
  it('exposes an entry-level sourceRef with null defaults', () => {
    const schema = createJournalEntrySchema(stConfig, 'StAccount');
    expect(schema.path('sourceRef')).toBeDefined();
    expect(schema.path('sourceRef.sourceModel')).toBeDefined();
    expect(schema.path('sourceRef.sourceId')).toBeDefined();
    expect(schema.path('sourceRef.label')).toBeDefined();
    expect(schema.path('sourceRef.kind')).toBeDefined();
  });

  it('round-trips entry-level sourceRef on create + findOne', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.SrcRefAccount) delete mongoose.models.SrcRefAccount;
    const AccountModel = mongoose.model('SrcRefAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'SrcRefAccount');
    if (mongoose.models.SrcRefJE) delete mongoose.models.SrcRefJE;
    const JEModel = mongoose.model('SrcRefJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const created = await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
      sourceRef: {
        sourceModel: 'SourceDocument',
        sourceId: '6a0d155f78ec4fb62f2c9baf',
        label: 'SM0195-70135 — SMART Agency',
        kind: 'xero-invoice',
      },
    });

    const found = (await JEModel.findById(created._id).lean()) as {
      sourceRef: {
        sourceModel: string | null;
        sourceId: string | null;
        label: string | null;
        kind: string | null;
      };
    } | null;

    expect(found?.sourceRef.sourceModel).toBe('SourceDocument');
    expect(found?.sourceRef.sourceId).toBe('6a0d155f78ec4fb62f2c9baf');
    expect(found?.sourceRef.label).toBe('SM0195-70135 — SMART Agency');
    expect(found?.sourceRef.kind).toBe('xero-invoice');
  });

  it('returns null defaults on unstamped JEs (subdoc never undefined)', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.UnstampedAccount) delete mongoose.models.UnstampedAccount;
    const AccountModel = mongoose.model('UnstampedAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'UnstampedAccount');
    if (mongoose.models.UnstampedJE) delete mongoose.models.UnstampedJE;
    const JEModel = mongoose.model('UnstampedJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const created = await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    const found = (await JEModel.findById(created._id).lean()) as {
      sourceRef: { sourceModel: null; sourceId: null; label: null; kind: null };
    } | null;

    expect(found?.sourceRef).toEqual({
      sourceModel: null,
      sourceId: null,
      label: null,
      kind: null,
    });
  });

  it('supports the host backfill pattern: updateMany({ _importRunId }, { $set: { sourceRef } })', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.BackfillAccount) delete mongoose.models.BackfillAccount;
    const AccountModel = mongoose.model('BackfillAccount', accountSchema);

    // Host extends with `_importRunId` via extraFields, matching how
    // `vendor-sync.workflow.ts` finds JEs to stamp after import.
    const jeSchema = createJournalEntrySchema(stConfig, 'BackfillAccount', {
      extraFields: { _importRunId: { type: String, default: null } },
    });
    if (mongoose.models.BackfillJE) delete mongoose.models.BackfillJE;
    const JEModel = mongoose.model('BackfillJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });
    const runId = 'src-doc-abc-123';

    // Simulate ingestion writing two JEs tagged with the same _importRunId.
    await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc1._id, debit: 5000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 5000,
      totalCredit: 5000,
      _importRunId: runId,
    });
    await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-16'),
      journalItems: [
        { account: acc1._id, debit: 7500, credit: 0 },
        { account: acc2._id, debit: 0, credit: 7500 },
      ],
      totalDebit: 7500,
      totalCredit: 7500,
      _importRunId: runId,
    });

    const stamp = await JEModel.updateMany(
      { _importRunId: runId },
      {
        $set: {
          sourceRef: {
            sourceModel: 'SourceDocument',
            sourceId: 'src-doc-abc-123',
            label: 'Xero invoice — Acme Corp',
            kind: 'xero-invoice',
          },
        },
      },
    );
    expect(stamp.modifiedCount).toBe(2);

    const drilledDown = (await JEModel.find({
      'sourceRef.sourceId': 'src-doc-abc-123',
    }).lean()) as Array<{ sourceRef: { kind: string | null } }>;
    expect(drilledDown).toHaveLength(2);
    expect(drilledDown[0]?.sourceRef.kind).toBe('xero-invoice');
  });

  // Pre-0.13 docs were written with the old 2-field shape (per-line only,
  // no entry-level slot). Reading them post-bump must be safe under both
  // `.lean()` (raw Mongo doc, no hydration) and full Mongoose hydration:
  //   - `.lean()` returns whatever Mongo holds — legacy 2-field per-line,
  //     no entry-level. Consumers must use optional chaining throughout.
  //   - Without `.lean()`, Mongoose hydrates: subdoc defaults fill missing
  //     `label`/`kind` on legacy per-line refs; entry-level still reads
  //     as undefined when the field was never written.
  //   - Drill-down `find({ 'sourceRef.sourceId': id })` is unaffected
  //     either way — only matches stamped docs.
  it('reads pre-0.13 docs safely under both lean() and Mongoose hydration', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.LegacyLineAccount) delete mongoose.models.LegacyLineAccount;
    const AccountModel = mongoose.model('LegacyLineAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'LegacyLineAccount');
    if (mongoose.models.LegacyLineJE) delete mongoose.models.LegacyLineJE;
    const JEModel = mongoose.model('LegacyLineJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    // Bypass Mongoose — write the raw pre-0.13 wire shape (2-field
    // sourceRef on the line, no entry-level sourceRef at all).
    await JEModel.collection.insertOne({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2025-12-01'),
      journalItems: [
        {
          account: acc1._id,
          debit: 10000,
          credit: 0,
          sourceRef: { sourceModel: 'Invoice', sourceId: 'inv-1' },
        },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // (a) `.lean()` path — raw Mongo doc, no hydration. Legacy stays legacy.
    const lean = (await JEModel.findOne().lean()) as {
      sourceRef?: unknown;
      journalItems: Array<{ sourceRef?: Record<string, unknown> }>;
    } | null;
    expect(lean?.sourceRef).toBeUndefined();
    expect(lean?.journalItems[0]?.sourceRef).toEqual({
      sourceModel: 'Invoice',
      sourceId: 'inv-1',
    });

    // (b) Hydrated path — Mongoose fills subdoc defaults everywhere.
    // Per-line gains null `label`/`kind`; entry-level — even though the
    // field was never written — gets the `default: () => ({})` subdoc
    // populated with all four nulls. Consumers reading via Mongoose
    // (not `.lean()`) get a uniform shape across pre-/post-0.13 docs.
    const hydrated = await JEModel.findOne();
    expect(hydrated?.get('journalItems.0.sourceRef')).toMatchObject({
      sourceModel: 'Invoice',
      sourceId: 'inv-1',
      label: null,
      kind: null,
    });
    expect(hydrated?.toObject().sourceRef).toEqual({
      sourceModel: null,
      sourceId: null,
      label: null,
      kind: null,
    });

    // (c) Drill-down query — only matches stamped docs.
    const stampedOnly = await JEModel.find({ 'sourceRef.sourceId': 'inv-1' }).lean();
    expect(stampedOnly).toHaveLength(0);
  });

  // Edge: $set via findOneAndUpdate (alternate stamp path some hosts use
  // instead of updateMany). Mongoose strict mode must NOT drop the
  // sourceRef subdoc — it's a first-class field, not extraFields.
  it('stamps sourceRef via findOneAndUpdate without strict-mode drop', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.FoauAccount) delete mongoose.models.FoauAccount;
    const AccountModel = mongoose.model('FoauAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'FoauAccount');
    if (mongoose.models.FoauJE) delete mongoose.models.FoauJE;
    const JEModel = mongoose.model('FoauJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const created = await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc1._id, debit: 5000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 5000 },
      ],
      totalDebit: 5000,
      totalCredit: 5000,
    });

    const stamp = (await JEModel.findOneAndUpdate(
      { _id: created._id },
      {
        $set: {
          sourceRef: {
            sourceModel: 'SourceDocument',
            sourceId: 'foau-1',
            label: 'foau label',
            kind: 'xero-bill',
          },
        },
      },
      { returnDocument: 'after' },
    )) as { sourceRef: { sourceId: string; label: string } } | null;

    expect(stamp?.sourceRef.sourceId).toBe('foau-1');
    expect(stamp?.sourceRef.label).toBe('foau label');
  });

  // Edge: multi-tenant + backfill — matches the real fajr vendor-sync
  // pattern (org-scoped updateMany filtered by both tenant + import-run).
  it('stamps sourceRef in multi-tenant mode without cross-tenant leak', async () => {
    const accountSchema = createAccountSchema(mtConfig);
    if (mongoose.models.MtSrcAccount) delete mongoose.models.MtSrcAccount;
    const AccountModel = mongoose.model('MtSrcAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(mtConfig, 'MtSrcAccount', {
      extraFields: { _importRunId: { type: String, default: null } },
    });
    if (mongoose.models.MtSrcJE) delete mongoose.models.MtSrcJE;
    const JEModel = mongoose.model('MtSrcJE', jeSchema);

    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const accA1 = await AccountModel.create({ business: orgA, accountTypeCode: '1000' });
    const accA2 = await AccountModel.create({ business: orgA, accountTypeCode: '8000' });
    const accB1 = await AccountModel.create({ business: orgB, accountTypeCode: '1000' });
    const accB2 = await AccountModel.create({ business: orgB, accountTypeCode: '8000' });

    const runId = 'shared-run-id';
    await JEModel.create({
      business: orgA,
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: accA1._id, debit: 1000, credit: 0 },
        { account: accA2._id, debit: 0, credit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
      _importRunId: runId,
    });
    await JEModel.create({
      business: orgB,
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: accB1._id, debit: 2000, credit: 0 },
        { account: accB2._id, debit: 0, credit: 2000 },
      ],
      totalDebit: 2000,
      totalCredit: 2000,
      _importRunId: runId,
    });

    // Stamp only orgA's JEs.
    const stamp = await JEModel.updateMany(
      { business: orgA, _importRunId: runId },
      { $set: { sourceRef: { sourceModel: 'SourceDocument', sourceId: 'doc-A', label: null, kind: null } } },
    );
    expect(stamp.modifiedCount).toBe(1);

    const orgAStamped = await JEModel.find({ business: orgA, 'sourceRef.sourceId': 'doc-A' }).lean();
    const orgBStamped = await JEModel.find({ business: orgB, 'sourceRef.sourceId': 'doc-A' }).lean();
    expect(orgAStamped).toHaveLength(1);
    expect(orgBStamped).toHaveLength(0);
  });

  // ERP multi-tenant scenario: ENTRY_SOURCE_INDEX must auto-prepend the
  // tenant field in multi-tenant mode so drill-down queries scoped to one
  // org don't scan stamped JEs across every tenant in the cluster. This
  // is the load-bearing scaling property for ERP — 1000 tenants × 100K JEs
  // each, a tenant-scoped query that scans only one tenant's index slice
  // vs. all stamped JEs across all tenants is the difference between
  // 10ms and 10s.
  it('multi-tenant: ENTRY_SOURCE_INDEX gets the tenant field auto-prepended', async () => {
    const { ENTRY_SOURCE_INDEX } = await import('../../src/schemas/journal-entry.schema.js');
    const accountSchema = createAccountSchema(mtConfig);
    if (mongoose.models.MtIdxAccount) delete mongoose.models.MtIdxAccount;
    mongoose.model('MtIdxAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(mtConfig, 'MtIdxAccount', {
      extraIndexes: [ENTRY_SOURCE_INDEX],
    });
    if (mongoose.models.MtIdxJE) delete mongoose.models.MtIdxJE;
    const JEModel = mongoose.model('MtIdxJE', jeSchema);
    await JEModel.createIndexes();

    const indexes = (await JEModel.collection.indexes()) as Array<{
      name?: string;
      key?: Record<string, number>;
      partialFilterExpression?: Record<string, unknown>;
    }>;
    const idx = indexes.find((i) => i.name === 'sourceRef_idx');
    expect(idx).toBeDefined();
    // Tenant field MUST be the first key — compound-index prefix rule.
    // `business` is mtConfig's tenantField.
    expect(Object.keys(idx?.key ?? {})).toEqual([
      'business',
      'sourceRef.sourceModel',
      'sourceRef.sourceId',
    ]);
    expect(idx?.partialFilterExpression).toEqual({
      'sourceRef.sourceModel': { $type: 'string' },
    });
  });

  // ERP multi-tenant scenario: a host-supplied extraIndex that ALREADY
  // includes the tenant prefix (the fajr pattern — see fajr-be-arc's
  // config/accounting.ts extraIndexes block) must NOT be double-prefixed.
  // `injectTenantField`'s idempotent prefix check is what guarantees this.
  it('multi-tenant: pre-prefixed host extraIndex is not double-prefixed', async () => {
    const accountSchema = createAccountSchema(mtConfig);
    if (mongoose.models.PrePfxAccount) delete mongoose.models.PrePfxAccount;
    mongoose.model('PrePfxAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(mtConfig, 'PrePfxAccount', {
      extraFields: { _externalId: { type: String, default: undefined } },
      extraIndexes: [
        {
          fields: { business: 1, _externalId: 1 },
          options: {
            unique: true,
            partialFilterExpression: { _externalId: { $type: 'string' } },
            name: 'pre_prefixed_idx',
          },
        },
      ],
    });
    if (mongoose.models.PrePfxJE) delete mongoose.models.PrePfxJE;
    const JEModel = mongoose.model('PrePfxJE', jeSchema);
    await JEModel.createIndexes();

    const indexes = (await JEModel.collection.indexes()) as Array<{
      name?: string;
      key?: Record<string, number>;
    }>;
    const idx = indexes.find((i) => i.name === 'pre_prefixed_idx');
    expect(idx).toBeDefined();
    // Still `business` first, NOT `business, business, _externalId`.
    expect(Object.keys(idx?.key ?? {})).toEqual(['business', '_externalId']);
  });

  // Edge: ENTRY_SOURCE_INDEX, when added via extraIndexes, must actually
  // build on the collection (sparse + partial filter) and be usable by
  // the drill-down query — not just present in the schema metadata.
  it('builds ENTRY_SOURCE_INDEX with sparse + partial filter when opted-in', async () => {
    const { ENTRY_SOURCE_INDEX } = await import('../../src/schemas/journal-entry.schema.js');
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.IdxAccount) delete mongoose.models.IdxAccount;
    mongoose.model('IdxAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'IdxAccount', {
      extraIndexes: [ENTRY_SOURCE_INDEX],
    });
    if (mongoose.models.IdxJE) delete mongoose.models.IdxJE;
    const JEModel = mongoose.model('IdxJE', jeSchema);
    await JEModel.createIndexes();

    const indexes = (await JEModel.collection.indexes()) as Array<{
      name?: string;
      key?: Record<string, number>;
      sparse?: boolean;
      partialFilterExpression?: Record<string, unknown>;
    }>;
    const idx = indexes.find((i) => i.name === 'sourceRef_idx');
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ 'sourceRef.sourceModel': 1, 'sourceRef.sourceId': 1 });
    // No `sparse` — partialFilterExpression alone gives the same storage
    // savings and is mutually exclusive with sparse at the MongoDB layer.
    expect(idx?.sparse).toBeUndefined();
    expect(idx?.partialFilterExpression).toEqual({
      'sourceRef.sourceModel': { $type: 'string' },
    });

    // VERIFY the index is actually usable by the idiomatic polymorphic-ref
    // drill-down query. MongoDB requires the query to imply the partial
    // filter expression — so the query MUST include sourceModel (any
    // equality on a string value implies `{ $type: 'string' }`).
    const acc = await mongoose.models.IdxAccount.create({ accountTypeCode: '1000' });
    const acc2 = await mongoose.models.IdxAccount.create({ accountTypeCode: '8000' });
    await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc._id, debit: 1000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
      sourceRef: {
        sourceModel: 'SourceDocument',
        sourceId: 'idx-test',
        label: null,
        kind: null,
      },
    });

    // Helper: walk the winning plan tree to find any indexName or COLLSCAN.
    const walkPlan = (
      node: unknown,
    ): { indexName?: string; collScan: boolean } => {
      const n = node as Record<string, unknown> | null | undefined;
      if (!n || typeof n !== 'object') return { collScan: false };
      const indexName = (n.indexName as string | undefined) ?? undefined;
      const collScan = n.stage === 'COLLSCAN';
      if (indexName || collScan) return { indexName, collScan };
      const inner = walkPlan(n.inputStage);
      if (inner.indexName || inner.collScan) return inner;
      for (const stage of (n.inputStages as unknown[]) ?? []) {
        const sub = walkPlan(stage);
        if (sub.indexName || sub.collScan) return sub;
      }
      return { collScan: false };
    };

    // The partial filter limits which docs the index CONTAINS (only
    // stamped docs where sourceModel is a string) — it does NOT
    // restrict which queries can use it. Both the 2-field idiomatic
    // drill-down and the sourceId-only variant return correct results
    // when forced via `.hint()`. Tiny test collection makes the planner
    // prefer COLLSCAN; production collections pick the index naturally.
    const hintedFull = await JEModel.find({
      'sourceRef.sourceModel': 'SourceDocument',
      'sourceRef.sourceId': 'idx-test',
    })
      .hint('sourceRef_idx')
      .lean();
    expect(hintedFull).toHaveLength(1);

    const hintedIdOnly = await JEModel.find({ 'sourceRef.sourceId': 'idx-test' })
      .hint('sourceRef_idx')
      .lean();
    expect(hintedIdOnly).toHaveLength(1);

    // Unstamped doc — excluded from the partial index, so a hinted
    // search for its (null) sourceId returns nothing even though the
    // doc exists. Proves the partial filter excludes correctly.
    await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-16'),
      journalItems: [
        { account: acc._id, debit: 500, credit: 0 },
        { account: acc2._id, debit: 0, credit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
      // No sourceRef stamped — defaults to all-null subdoc.
    });
    const hintedNull = await JEModel.find({ 'sourceRef.sourceId': null })
      .hint('sourceRef_idx')
      .lean();
    expect(hintedNull).toHaveLength(0); // partial filter excludes unstamped
  });

  // Edge: per-line sourceRef must NOT be wiped by a PATCH that only
  // touches scalar fields on the same item (the historical bug that
  // motivated the typed sub-Schema instead of an inline object).
  it('preserves per-line sourceRef across a scalar PATCH on the same item', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.PatchAccount) delete mongoose.models.PatchAccount;
    const AccountModel = mongoose.model('PatchAccount', accountSchema);

    const jeSchema = createJournalEntrySchema(stConfig, 'PatchAccount');
    if (mongoose.models.PatchJE) delete mongoose.models.PatchJE;
    const JEModel = mongoose.model('PatchJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const created = await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        {
          account: acc1._id,
          debit: 10000,
          credit: 0,
          sourceRef: { sourceModel: 'Invoice', sourceId: 'inv-77', label: 'INV-77', kind: 'qbo-invoice' },
        },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    });

    // PATCH only the line label — sourceRef must survive.
    await JEModel.updateOne(
      { _id: created._id, 'journalItems.0': { $exists: true } },
      { $set: { 'journalItems.0.label': 'updated label' } },
    );

    const after = (await JEModel.findById(created._id).lean()) as {
      journalItems: Array<{ label?: string; sourceRef?: Record<string, unknown> }>;
    } | null;
    expect(after?.journalItems[0]?.label).toBe('updated label');
    expect(after?.journalItems[0]?.sourceRef).toEqual({
      sourceModel: 'Invoice',
      sourceId: 'inv-77',
      label: 'INV-77',
      kind: 'qbo-invoice',
    });
  });

  // ── 0.12 → 0.13 migration safety ────────────────────────────────────────
  //
  // Pre-0.13 hosts that declared their own `sourceRef` via `extraFields`
  // (the only way to get an entry-level back-reference before this version)
  // must keep working after upgrading. The schema spreads `...extraFields`
  // AFTER the built-in slot, so a host-defined sourceRef wins — same wire
  // shape, no migration required, and consumers can delete their
  // `extraFields.sourceRef` block at their leisure rather than as a
  // breaking step coupled to the version bump.
  it('back-compat: host extraFields.sourceRef overrides the built-in slot', async () => {
    const accountSchema = createAccountSchema(stConfig);
    if (mongoose.models.LegacyAccount) delete mongoose.models.LegacyAccount;
    const AccountModel = mongoose.model('LegacyAccount', accountSchema);

    // Host declares its own 4-field sourceRef (this is exactly what
    // fajr-be-arc's accounting.ts had before bumping to 0.13).
    const jeSchema = createJournalEntrySchema(stConfig, 'LegacyAccount', {
      extraFields: {
        sourceRef: {
          sourceModel: { type: String, default: null },
          sourceId: { type: String, default: null },
          label: { type: String, default: null },
          kind: { type: String, default: null },
        },
      },
    });
    if (mongoose.models.LegacyJE) delete mongoose.models.LegacyJE;
    const JEModel = mongoose.model('LegacyJE', jeSchema);

    const acc1 = await AccountModel.create({ accountTypeCode: '1000' });
    const acc2 = await AccountModel.create({ accountTypeCode: '8000' });

    const created = await JEModel.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-15'),
      journalItems: [
        { account: acc1._id, debit: 10000, credit: 0 },
        { account: acc2._id, debit: 0, credit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
      sourceRef: {
        sourceModel: 'SourceDocument',
        sourceId: 'host-doc-id',
        label: 'Host-stamped',
        kind: 'qbo-bill',
      },
    });

    const found = (await JEModel.findById(created._id).lean()) as {
      sourceRef: { sourceModel: string; sourceId: string; label: string; kind: string };
    } | null;
    expect(found?.sourceRef.sourceModel).toBe('SourceDocument');
    expect(found?.sourceRef.sourceId).toBe('host-doc-id');
    expect(found?.sourceRef.label).toBe('Host-stamped');
    expect(found?.sourceRef.kind).toBe('qbo-bill');
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
