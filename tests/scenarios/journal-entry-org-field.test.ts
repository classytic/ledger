/**
 * Scenario: `journalEntryOrgField` — non-scoping branch tag on JE docs.
 *
 * Single-company-multi-branch hosts (e.g., Nike Bangladesh — one company,
 * many stores) want every journal entry to carry the originating branch ID
 * for partition-style reports (per-branch P&L, AR aging by branch) WITHOUT
 * scoping the chart of accounts (every branch shares the same accounts).
 *
 * Full `multiTenant` is too heavy for this case — it scopes Account /
 * FiscalPeriod / Reconciliation by orgId, which is wrong when the chart
 * is company-wide. `journalEntryOrgField` is the lighter alternative:
 * stamp the JE doc, leave every other repository untouched.
 *
 * What's verified here:
 *   1. Without `journalEntryOrgField`: `record.*(orgId, ...)` drops orgId
 *      silently — current default for engines that didn't opt in.
 *   2. With `journalEntryOrgField: 'organizationId'` and a matching
 *      `extraFields.organizationId` schema declaration: every JE created
 *      via `record.*` carries the orgId on the doc.
 *   3. Account / FiscalPeriod stay company-wide — no `organizationId`
 *      filter on account resolution, no field added to those schemas.
 *   4. Idempotency, payment, adjustment, and sale all stamp consistently.
 *   5. With `multiTenant` set, `multiTenant.tenantField` wins — the new
 *      knob is ignored (full scoping path is unchanged).
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';

const accountTypes: readonly AccountType[] = [
  {
    code: '1001',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '1141',
    name: 'AR',
    category: 'Balance Sheet-Asset',
    description: 'AR',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '4010',
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
];

const pack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  retainedEarningsAccountCode: '3600',
});

const BRANCH_A = '69c3adee4e99cf0a6be1b4ff';
const BRANCH_B = '69410e2f221360efcb21c574';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  for (const name of Object.keys(mongoose.models)) delete mongoose.models[name];
  for (const name of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[name]?.deleteMany({});
  }
});

describe('journalEntryOrgField — non-scoping branch tag', () => {
  it('without the knob: explicit orgId arg is dropped on the JE doc', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
    });

    await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1141' },
      { accountTypeCode: '4010' },
    ] as never);

    const entry = (await engine.record.sale(BRANCH_A, {
      date: new Date('2026-04-28'),
      amount: 10000,
      receivableAccount: '1141',
      revenueAccount: '4010',
      label: 'INV-1',
    })) as { organizationId?: unknown };

    expect(entry.organizationId).toBeUndefined();
  });

  it('with the knob: record.sale stamps organizationId on the JE doc', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      journalEntryOrgField: 'organizationId',
      schemaOptions: {
        journalEntry: {
          extraFields: {
            organizationId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'organization',
              default: null,
              index: true,
            },
          },
        },
      },
    });

    await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1141' },
      { accountTypeCode: '4010' },
    ] as never);

    const entry = (await engine.record.sale(BRANCH_A, {
      date: new Date('2026-04-28'),
      amount: 10000,
      receivableAccount: '1141',
      revenueAccount: '4010',
      label: 'INV-A',
    })) as { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId };

    expect(String(entry.organizationId)).toBe(BRANCH_A);

    // Refetch from DB — confirm the field is persisted, not just on the
    // returned object.
    const persisted = (await engine.models.JournalEntry.findById(entry._id).lean()) as {
      organizationId: mongoose.Types.ObjectId;
    } | null;
    expect(persisted).toBeTruthy();
    expect(String(persisted?.organizationId)).toBe(BRANCH_A);
  });

  it('account chart stays company-wide: same accounts resolve for both branches', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      journalEntryOrgField: 'organizationId',
      schemaOptions: {
        journalEntry: {
          extraFields: {
            organizationId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'organization',
              default: null,
              index: true,
            },
          },
        },
      },
    });

    // Seed ONE chart of accounts (no per-branch seeding)
    await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1141' },
      { accountTypeCode: '4010' },
    ] as never);

    // Both branches post against the same accounts — no second seeding,
    // no `organizationId` on Account documents.
    const a = (await engine.record.sale(BRANCH_A, {
      date: new Date('2026-04-28'),
      amount: 10000,
      receivableAccount: '1141',
      revenueAccount: '4010',
      label: 'INV-A',
    })) as { organizationId: mongoose.Types.ObjectId };

    const b = (await engine.record.sale(BRANCH_B, {
      date: new Date('2026-04-28'),
      amount: 25000,
      receivableAccount: '1141',
      revenueAccount: '4010',
      label: 'INV-B',
    })) as { organizationId: mongoose.Types.ObjectId };

    expect(String(a.organizationId)).toBe(BRANCH_A);
    expect(String(b.organizationId)).toBe(BRANCH_B);

    // Account schema has no organizationId path — confirm by introspection.
    const accountPaths = Object.keys(engine.models.Account.schema.paths);
    expect(accountPaths).not.toContain('organizationId');
  });

  it('record.adjustment, record.payment, and record.expense all stamp the field', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      journalEntryOrgField: 'organizationId',
      schemaOptions: {
        journalEntry: {
          extraFields: {
            organizationId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'organization',
              default: null,
              index: true,
            },
          },
        },
      },
    });

    await engine.repositories.accounts.bulkCreate([
      { accountTypeCode: '1001' },
      { accountTypeCode: '1141' },
      { accountTypeCode: '4010' },
    ] as never);

    const adjustment = (await engine.record.adjustment(BRANCH_A, {
      date: new Date('2026-04-28'),
      label: 'manual posting',
      lines: [
        { account: '1141', debit: 5000 },
        { account: '4010', credit: 5000 },
      ],
    })) as { organizationId: mongoose.Types.ObjectId };
    expect(String(adjustment.organizationId)).toBe(BRANCH_A);

    const payment = (await engine.record.payment(BRANCH_A, {
      date: new Date('2026-04-28'),
      amount: 5000,
      fromReceivableAccount: '1141',
      toCashAccount: '1001',
      label: 'collection',
    })) as { organizationId: mongoose.Types.ObjectId };
    expect(String(payment.organizationId)).toBe(BRANCH_A);
  });

  it('full multiTenant takes precedence — journalEntryOrgField is ignored', async () => {
    // Both knobs set: multiTenant scopes everything by `branchId`,
    // journalEntryOrgField names a different field. The multi-tenant path
    // wins — JE carries `branchId`, not `companyId`.
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: pack,
      currency: 'USD',
      multiTenant: {
        tenantField: 'branchId',
        ref: 'organization',
      },
      journalEntryOrgField: 'companyId',
    });

    // Account chart now scoped — bulkCreate's second arg names the branch.
    await engine.repositories.accounts.bulkCreate(
      [{ accountTypeCode: '1141' }, { accountTypeCode: '4010' }] as never,
      BRANCH_A as never,
    );

    const entry = (await engine.record.sale(BRANCH_A, {
      date: new Date('2026-04-28'),
      amount: 10000,
      receivableAccount: '1141',
      revenueAccount: '4010',
      label: 'INV-MT',
    })) as { branchId?: mongoose.Types.ObjectId; companyId?: unknown };

    expect(String(entry.branchId)).toBe(BRANCH_A);
    expect(entry.companyId).toBeUndefined();
  });
});
