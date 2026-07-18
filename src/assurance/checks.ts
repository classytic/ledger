/**
 * Individual assurance checks. Each is a read-only aggregation returning an
 * `AssuranceCheckResult`. They re-derive every invariant from raw
 * `journalItems` — never trusting denormalized totals (those get their own
 * drift check instead).
 */

import type { PipelineStage } from 'mongoose';
import type {
  AssuranceCheckResult,
  ControlAccountExpectation,
  LedgerAssuranceOptions,
  LedgerAssuranceParams,
} from './types.js';

const DEFAULT_SAMPLE_LIMIT = 20;

/** Match stage shared by every posted-entry check. */
function postedMatch(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Record<string, unknown> {
  const match: Record<string, unknown> = { state: 'posted' };
  if (opts.orgField && params.organizationId !== undefined) {
    match[opts.orgField] = params.organizationId;
  }
  if (params.until) match.date = { $lte: params.until };
  return match;
}

/** Σ over an item field as an aggregation expression. */
const itemSum = (field: 'debit' | 'credit') => ({
  $sum: {
    $map: {
      input: { $ifNull: ['$journalItems', []] },
      as: 'it',
      in: { $ifNull: [`$$it.${field}`, 0] },
    },
  },
});

interface FacetOutput {
  sample: unknown[];
  total: Array<{ n: number }>;
}

function facetResult(raw: FacetOutput[] | undefined): { affected: number; sample: unknown[] } {
  const f = raw?.[0];
  return { affected: f?.total?.[0]?.n ?? 0, sample: f?.sample ?? [] };
}

/**
 * entry-balance — every posted entry's items must satisfy Σdebit = Σcredit.
 * The schema enforces this on `save()`; this catches writes that bypassed it
 * (updateOne/bulkWrite/migrations/restores).
 */
export async function checkEntryBalance(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Promise<AssuranceCheckResult> {
  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const pipeline: PipelineStage[] = [
    { $match: postedMatch(opts, params) },
    {
      $project: {
        referenceNumber: 1,
        date: 1,
        journalType: 1,
        idempotencyKey: 1,
        driftMinor: { $subtract: [itemSum('debit'), itemSum('credit')] },
      },
    },
    { $match: { driftMinor: { $ne: 0 } } },
    { $facet: { sample: [{ $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const { affected, sample } = facetResult(
    (await opts.JournalEntryModel.aggregate(pipeline)) as FacetOutput[],
  );
  return {
    check: 'entry-balance',
    severity: 'error',
    ok: affected === 0,
    affected,
    sample,
    summary:
      affected === 0
        ? 'Every posted entry balances (Σdebit = Σcredit per entry)'
        : `${affected} posted entr${affected === 1 ? 'y' : 'ies'} do not balance`,
  };
}

/**
 * totals-drift — the denormalized `totalDebit`/`totalCredit` on each posted
 * entry must equal the recomputed item sums. Catches cache rot from partial
 * updates that patched lines without resyncing totals.
 */
export async function checkTotalsDrift(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Promise<AssuranceCheckResult> {
  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const pipeline: PipelineStage[] = [
    { $match: postedMatch(opts, params) },
    {
      $project: {
        referenceNumber: 1,
        date: 1,
        totalDebit: 1,
        totalCredit: 1,
        itemDebit: itemSum('debit'),
        itemCredit: itemSum('credit'),
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $ne: [{ $ifNull: ['$totalDebit', 0] }, '$itemDebit'] },
            { $ne: [{ $ifNull: ['$totalCredit', 0] }, '$itemCredit'] },
          ],
        },
      },
    },
    { $facet: { sample: [{ $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const { affected, sample } = facetResult(
    (await opts.JournalEntryModel.aggregate(pipeline)) as FacetOutput[],
  );
  return {
    check: 'totals-drift',
    severity: 'error',
    ok: affected === 0,
    affected,
    sample,
    summary:
      affected === 0
        ? 'Denormalized entry totals match recomputed item sums'
        : `${affected} posted entr${affected === 1 ? 'y' : 'ies'} have stale totalDebit/totalCredit`,
  };
}

/**
 * trial-balance-zero — the conservation law: Σdebit − Σcredit over ALL
 * posted items in scope must be exactly 0.
 */
export async function checkTrialBalanceZero(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Promise<AssuranceCheckResult> {
  const pipeline: PipelineStage[] = [
    { $match: postedMatch(opts, params) },
    {
      $group: {
        _id: null,
        debit: { $sum: itemSum('debit') },
        credit: { $sum: itemSum('credit') },
      },
    },
  ];
  const rows = (await opts.JournalEntryModel.aggregate(pipeline)) as Array<{
    debit: number;
    credit: number;
  }>;
  const debit = rows[0]?.debit ?? 0;
  const credit = rows[0]?.credit ?? 0;
  const driftMinor = debit - credit;
  return {
    check: 'trial-balance-zero',
    severity: 'error',
    ok: driftMinor === 0,
    affected: driftMinor === 0 ? 0 : 1,
    driftMinor,
    sample: driftMinor === 0 ? [] : [{ debit, credit }],
    summary:
      driftMinor === 0
        ? 'Book conserves: Σdebit = Σcredit over all posted items'
        : `Book out of balance by ${driftMinor} minor units (Σdebit ${debit} vs Σcredit ${credit})`,
  };
}

/**
 * orphan-accounts — every posted item must reference an existing account
 * document. Catches deleted/merged accounts leaving dangling lines.
 */
export async function checkOrphanAccounts(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Promise<AssuranceCheckResult> {
  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const pipeline: PipelineStage[] = [
    { $match: postedMatch(opts, params) },
    { $unwind: '$journalItems' },
    { $group: { _id: '$journalItems.account', entries: { $addToSet: '$_id' } } },
    {
      $lookup: {
        from: opts.AccountModel.collection.name,
        localField: '_id',
        foreignField: '_id',
        as: 'account',
      },
    },
    { $match: { account: { $size: 0 } } },
    {
      $project: {
        accountId: '$_id',
        _id: 0,
        entryCount: { $size: '$entries' },
        entries: { $slice: ['$entries', 5] },
      },
    },
    { $facet: { sample: [{ $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const { affected, sample } = facetResult(
    (await opts.JournalEntryModel.aggregate(pipeline)) as FacetOutput[],
  );
  return {
    check: 'orphan-accounts',
    severity: 'error',
    ok: affected === 0,
    affected,
    sample,
    summary:
      affected === 0
        ? 'Every posted item references an existing account'
        : `${affected} account id(s) referenced by posted items no longer exist`,
  };
}

/**
 * duplicate-idempotency — no two non-draft entries may share an
 * idempotencyKey. The partial unique index enforces this; the check guards
 * against index drops/rebuilds and pre-index data.
 */
export async function checkDuplicateIdempotency(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
): Promise<AssuranceCheckResult> {
  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const match = postedMatch(opts, params);
  match.idempotencyKey = { $type: 'string' };
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $group: { _id: '$idempotencyKey', n: { $sum: 1 }, entries: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
    { $project: { idempotencyKey: '$_id', _id: 0, n: 1, entries: { $slice: ['$entries', 5] } } },
    { $facet: { sample: [{ $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const { affected, sample } = facetResult(
    (await opts.JournalEntryModel.aggregate(pipeline)) as FacetOutput[],
  );
  return {
    check: 'duplicate-idempotency',
    severity: 'error',
    ok: affected === 0,
    affected,
    sample,
    summary:
      affected === 0
        ? 'No duplicate idempotency keys among posted entries'
        : `${affected} idempotency key(s) shared by multiple posted entries`,
  };
}

/**
 * control-accounts — GL balance of each declared control account must equal
 * the host-supplied subledger total (open A/R items, open A/P items, …).
 * Balance convention: debit − credit (asset controls positive, liability
 * controls negative).
 */
export async function checkControlAccounts(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
  expectations: ControlAccountExpectation[],
): Promise<AssuranceCheckResult> {
  const groupOf = (e: ControlAccountExpectation): string[] => e.accountTypeCodes ?? [e.accountTypeCode];
  const codes = [...new Set(expectations.flatMap(groupOf))];
  const accountQuery: Record<string, unknown> = { accountTypeCode: { $in: codes } };
  if (opts.orgField && params.organizationId !== undefined) {
    // Mirror the reports' account scoping — charts may be org-scoped.
    accountQuery[opts.orgField] = params.organizationId;
  }
  const accounts = (await opts.AccountModel.find(accountQuery, {
    _id: 1,
    accountTypeCode: 1,
  }).lean()) as unknown as Array<{ _id: unknown; accountTypeCode: string }>;

  const codeByAccountId = new Map<string, string>();
  const idsByCode = new Map<string, unknown[]>();
  for (const a of accounts) {
    codeByAccountId.set(String(a._id), a.accountTypeCode);
    const ids = idsByCode.get(a.accountTypeCode) ?? [];
    ids.push(a._id);
    idsByCode.set(a.accountTypeCode, ids);
  }

  const allIds = accounts.map((a) => a._id);
  const balanceByCode = new Map<string, number>();
  if (allIds.length > 0) {
    const pipeline: PipelineStage[] = [
      { $match: postedMatch(opts, params) },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: allIds } } },
      {
        $group: {
          _id: '$journalItems.account',
          debit: { $sum: { $ifNull: ['$journalItems.debit', 0] } },
          credit: { $sum: { $ifNull: ['$journalItems.credit', 0] } },
        },
      },
    ];
    const rows = (await opts.JournalEntryModel.aggregate(pipeline)) as Array<{
      _id: unknown;
      debit: number;
      credit: number;
    }>;
    for (const r of rows) {
      const code = codeByAccountId.get(String(r._id));
      if (!code) continue;
      balanceByCode.set(code, (balanceByCode.get(code) ?? 0) + r.debit - r.credit);
    }
  }

  const violations: unknown[] = [];
  let driftMinor = 0;
  for (const e of expectations) {
    const group = groupOf(e);
    const actual = group.reduce((sum, code) => sum + (balanceByCode.get(code) ?? 0), 0);
    const gap = actual - e.expectedMinor;
    if (gap !== 0) {
      driftMinor += Math.abs(gap);
      violations.push({
        accountTypeCode: e.accountTypeCode,
        ...(e.accountTypeCodes ? { accountTypeCodes: e.accountTypeCodes } : {}),
        label: e.label,
        glBalanceMinor: actual,
        subledgerMinor: e.expectedMinor,
        gapMinor: gap,
        accountsMatched: group.reduce((n, code) => n + (idsByCode.get(code)?.length ?? 0), 0),
      });
    }
  }

  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  return {
    check: 'control-accounts',
    severity: 'error',
    ok: violations.length === 0,
    affected: violations.length,
    driftMinor: violations.length === 0 ? 0 : driftMinor,
    sample: violations.slice(0, limit),
    summary:
      violations.length === 0
        ? `All ${expectations.length} control account(s) tie out to their subledgers`
        : `${violations.length} control account(s) diverge from their subledgers (Σ|gap| ${driftMinor} minor units)`,
  };
}

/**
 * stale-drafts — drafts older than `staleDraftDays` (severity 'warn').
 * Old drafts are usually abandoned half-postings that will confuse a close.
 */
export async function checkStaleDrafts(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams,
  staleDraftDays: number,
  now: Date,
): Promise<AssuranceCheckResult> {
  const limit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const cutoff = new Date(now.getTime() - staleDraftDays * 24 * 60 * 60 * 1000);
  const match: Record<string, unknown> = { state: 'draft', date: { $lte: cutoff } };
  if (opts.orgField && params.organizationId !== undefined) {
    match[opts.orgField] = params.organizationId;
  }
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $project: { referenceNumber: 1, date: 1, journalType: 1, label: 1 } },
    { $facet: { sample: [{ $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const { affected, sample } = facetResult(
    (await opts.JournalEntryModel.aggregate(pipeline)) as FacetOutput[],
  );
  return {
    check: 'stale-drafts',
    severity: 'warn',
    ok: affected === 0,
    affected,
    sample,
    summary:
      affected === 0
        ? `No drafts older than ${staleDraftDays} days`
        : `${affected} draft(s) older than ${staleDraftDays} days`,
  };
}
