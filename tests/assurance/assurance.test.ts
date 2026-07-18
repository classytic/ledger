/**
 * Assurance suite — proves the integrity checks catch exactly the corruption
 * classes the schema guards CANNOT see. Every corruption here is injected via
 * direct collection writes (`updateOne`/`insertMany` on the raw collection),
 * i.e. the paths a migration, restore, or buggy bulk script would take.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLedgerAssurance } from '../../src/assurance/run.js';
import type { LedgerAssuranceOptions } from '../../src/assurance/types.js';
import {
  draftEntry,
  postEntry,
  type ScenarioEngine,
  setupScenario,
  teardownScenario,
} from '../helpers/scenario-setup.js';

let s: ScenarioEngine;
let opts: LedgerAssuranceOptions;

beforeAll(async () => {
  s = await setupScenario({}, 'Assur');
  opts = {
    JournalEntryModel: s.JE as never,
    AccountModel: s.Account as never,
  };
});

afterAll(async () => {
  await teardownScenario(s);
});

function byCheck(report: Awaited<ReturnType<typeof runLedgerAssurance>>, check: string) {
  const r = report.results.find((x) => x.check === check);
  if (!r) throw new Error(`check ${check} missing from report`);
  return r;
}

describe('ledger assurance', () => {
  it('clean book passes every check (including tie-outs and drafts)', async () => {
    // Cash sale 100.00: Dr Cash 10000 / Cr Revenue 10000
    await postEntry(s, '2026-01-10', 'SALES', [
      { account: '1001', debit: 10000, credit: 0 },
      { account: '4010', debit: 0, credit: 10000 },
    ]);
    // Credit sale 250.00: Dr AR 25000 / Cr Revenue 25000
    await postEntry(s, '2026-01-15', 'SALES', [
      { account: '1200', debit: 25000, credit: 0 },
      { account: '4010', debit: 0, credit: 25000 },
    ]);

    const report = await runLedgerAssurance(opts, {
      controlAccounts: [
        { accountTypeCode: '1200', expectedMinor: 25000, label: 'A/R vs open invoices' },
      ],
      staleDraftDays: 30,
      now: new Date('2026-02-01'),
    });

    expect(report.ok).toBe(true);
    for (const r of report.results) expect(r, r.check).toMatchObject({ ok: true, affected: 0 });
    expect(byCheck(report, 'trial-balance-zero').driftMinor).toBe(0);
  });

  it('control-accounts reports the exact gap when the subledger disagrees', async () => {
    const report = await runLedgerAssurance(opts, {
      controlAccounts: [
        // Subledger claims 30000 open, GL holds 25000 → gap -5000.
        { accountTypeCode: '1200', expectedMinor: 30000, label: 'A/R vs open invoices' },
      ],
    });
    const r = byCheck(report, 'control-accounts');
    expect(r.ok).toBe(false);
    expect(r.driftMinor).toBe(5000);
    expect(r.sample[0]).toMatchObject({
      accountTypeCode: '1200',
      glBalanceMinor: 25000,
      subledgerMinor: 30000,
      gapMinor: -5000,
    });
    expect(report.ok).toBe(false);
  });

  it('grouped control expectation sums the GL balances of all codes in the group', async () => {
    // Move 40% of the A/R value into Equipment (simulating value split across
    // two accounts the way inventory splits into on-hand + in-transit during
    // a transfer): the GROUP total is unchanged, so a grouped tie-out passes
    // while the single-code tie-out would report a gap.
    await postEntry(s, '2026-01-16', 'GENERAL', [
      { account: '1500', debit: 10000, credit: 0 },
      { account: '1200', debit: 0, credit: 10000 },
    ]);

    const grouped = await runLedgerAssurance(opts, {
      controlAccounts: [
        {
          accountTypeCode: '1200',
          accountTypeCodes: ['1200', '1500'],
          expectedMinor: 25000,
          label: 'A/R + Equipment group',
        },
      ],
    });
    expect(byCheck(grouped, 'control-accounts')).toMatchObject({ ok: true, affected: 0 });

    const single = await runLedgerAssurance(opts, {
      controlAccounts: [{ accountTypeCode: '1200', expectedMinor: 25000 }],
    });
    const r = byCheck(single, 'control-accounts');
    expect(r.ok).toBe(false);
    expect(r.sample[0]).toMatchObject({ glBalanceMinor: 15000, gapMinor: -10000 });

    // Restore: move the value back so later tests see the original book.
    await postEntry(s, '2026-01-17', 'GENERAL', [
      { account: '1200', debit: 10000, credit: 0 },
      { account: '1500', debit: 0, credit: 10000 },
    ]);
  });

  it('stale-drafts warns (and does NOT flip report.ok)', async () => {
    await draftEntry(s, '2025-11-01', 'GENERAL', [
      { account: '6010', debit: 500, credit: 0 },
      { account: '1001', debit: 0, credit: 500 },
    ]);
    const report = await runLedgerAssurance(opts, {
      staleDraftDays: 30,
      now: new Date('2026-02-01'),
    });
    const r = byCheck(report, 'stale-drafts');
    expect(r).toMatchObject({ ok: false, severity: 'warn', affected: 1 });
    expect(report.ok).toBe(true); // warns never fail the sweep
  });

  it('entry-balance + trial-balance-zero catch a bulk-write corruption the schema never saw', async () => {
    const victim = await postEntry(s, '2026-01-20', 'PURCHASES', [
      { account: '6010', debit: 7000, credit: 0 },
      { account: '1001', debit: 0, credit: 7000 },
    ]);
    // A "migration" fat-fingers one line via the raw collection — no save(),
    // no validators, exactly the bypass assurance exists for.
    await s.JE.collection.updateOne(
      { _id: victim._id },
      { $set: { 'journalItems.0.debit': 9000 } },
    );

    const report = await runLedgerAssurance(opts);
    const entryBalance = byCheck(report, 'entry-balance');
    expect(entryBalance.ok).toBe(false);
    expect(entryBalance.affected).toBe(1);
    expect(entryBalance.sample[0]).toMatchObject({ driftMinor: 2000 });

    expect(byCheck(report, 'trial-balance-zero')).toMatchObject({ ok: false, driftMinor: 2000 });
    // Totals drift too: denormalized totalDebit still says 7000.
    expect(byCheck(report, 'totals-drift')).toMatchObject({ ok: false, affected: 1 });
    expect(report.ok).toBe(false);

    // Repair for subsequent tests.
    await s.JE.collection.updateOne(
      { _id: victim._id },
      { $set: { 'journalItems.0.debit': 7000 } },
    );
  });

  it('`until` bounds the sweep — corruption dated later is out of scope', async () => {
    const late = await postEntry(s, '2026-06-15', 'GENERAL', [
      { account: '6020', debit: 1200, credit: 0 },
      { account: '1001', debit: 0, credit: 1200 },
    ]);
    await s.JE.collection.updateOne({ _id: late._id }, { $set: { 'journalItems.0.debit': 1300 } });

    const bounded = await runLedgerAssurance(opts, { until: new Date('2026-03-31') });
    expect(bounded.ok).toBe(true);

    const unbounded = await runLedgerAssurance(opts);
    expect(byCheck(unbounded, 'entry-balance').affected).toBe(1);

    await s.JE.collection.updateOne({ _id: late._id }, { $set: { 'journalItems.0.debit': 1200 } });
  });

  it('orphan-accounts catches a deleted account with posted history', async () => {
    const doomedId = s.acctIds['6030'];
    await s.JE.create({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-01-25'),
      journalItems: [
        { account: doomedId, debit: 400, credit: 0 },
        { account: s.acctIds['1001'], debit: 0, credit: 400 },
      ],
      totalDebit: 400,
      totalCredit: 400,
    });
    await s.Account.collection.deleteOne({ _id: doomedId });

    const report = await runLedgerAssurance(opts);
    const r = byCheck(report, 'orphan-accounts');
    expect(r.ok).toBe(false);
    expect(r.affected).toBe(1);
    expect(String((r.sample[0] as { accountId: unknown }).accountId)).toBe(String(doomedId));
  });

  it('duplicate-idempotency catches doubles after an index drop', async () => {
    // The partial unique index normally forbids this — drop it, the way a
    // careless re-index or restore would, then double-post.
    await s.JE.collection.dropIndexes();
    const base = {
      journalType: 'SALES',
      state: 'posted',
      date: new Date('2026-01-28'),
      journalItems: [
        { account: s.acctIds['1001'], debit: 100, credit: 0 },
        { account: s.acctIds['4010'], debit: 0, credit: 100 },
      ],
      totalDebit: 100,
      totalCredit: 100,
      idempotencyKey: 'dup-key-1',
    };
    await s.JE.collection.insertMany([{ ...base }, { ...base }] as never[]);

    const report = await runLedgerAssurance(opts);
    const r = byCheck(report, 'duplicate-idempotency');
    expect(r.ok).toBe(false);
    expect(r.sample[0]).toMatchObject({ idempotencyKey: 'dup-key-1', n: 2 });
  });

  it('org scoping isolates the sweep to one branch', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const scoped: LedgerAssuranceOptions = { ...opts, orgField: 'organizationId' };
    const mk = (org: mongoose.Types.ObjectId, debit: number) => ({
      journalType: 'GENERAL',
      state: 'posted',
      date: new Date('2026-02-05'),
      organizationId: org,
      journalItems: [
        { account: s.acctIds['1001'], debit, credit: 0 },
        { account: s.acctIds['4010'], debit: 0, credit: 200 },
      ],
      totalDebit: debit,
      totalCredit: 200,
    });
    // Org A balanced; org B corrupt (debit 999 vs credit 200).
    await s.JE.collection.insertMany([mk(orgA, 200), mk(orgB, 999)] as never[]);

    const a = await runLedgerAssurance(scoped, { organizationId: orgA });
    expect(byCheck(a, 'entry-balance').ok).toBe(true);
    expect(byCheck(a, 'trial-balance-zero').driftMinor).toBe(0);

    const b = await runLedgerAssurance(scoped, { organizationId: orgB });
    expect(byCheck(b, 'entry-balance').affected).toBe(1);
    expect(byCheck(b, 'trial-balance-zero').driftMinor).toBe(799);
  });
});
