/**
 * Partner Ledger Report (0.6.0)
 *
 * Generates a supplier or customer statement against a control account,
 * narrowed by a partner dimension (`partnerId` by default). Includes:
 *
 *   - Opening balance (sum of all matched + unmatched activity before
 *     `startDate`)
 *   - One row per posted journal item touching the (controlAccount,
 *     partnerId) pair within the period
 *   - Running balance computed via $setWindowFields
 *   - Per-row matchingNumber + maturityDate + daysPastDue
 *   - Closing balance, open-items total, matched total
 *   - Optional aged buckets for the open items at end-of-period
 *
 * The report is a single aggregation pipeline against the JournalEntry
 * collection — no extra collections, no consumer-side joins. Designed
 * for the canonical question:
 *
 *   "Show me everything we owe Supplier X between Jan 1 and Mar 31,
 *    with running balance and which bills are still open."
 *
 * Companion to `generateAgedBalance` (which gives you the *bucket*
 * summary across all partners) and `reconciliationRepository.match()`
 * (which is how items get marked paid in the first place).
 */

import type { Model } from 'mongoose';
import { requireOrgScope } from '../utils/tenant-guard.js';
import type { AgedBucketConfig } from './aged-balance.js';
import { DEFAULT_BUCKETS } from './aged-balance.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PartnerLedgerOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  orgField?: string;
}

export interface PartnerLedgerParams {
  organizationId?: unknown;
  /**
   * The control account being ledgered — typically `2111 A/P`
   * (supplier statement) or `1141 A/R` (customer statement).
   */
  controlAccountId: unknown;
  /**
   * Field name on each journal item that holds the partner reference.
   * Default: `'partnerId'`. Whatever you declared in
   * `schemaOptions.journalEntry.extraItemFields`.
   */
  partnerField?: string;
  /**
   * The specific partner whose statement we're generating. Required —
   * to get all partners use `generateAgedBalance` instead.
   */
  partnerId: unknown;
  startDate: Date;
  endDate: Date;
  /**
   * If true, include items already matched (settled) inside the period.
   * Default: true — statements show settled activity in the period.
   */
  includeMatched?: boolean;
  /** Custom aged buckets for the open-items summary. */
  buckets?: AgedBucketConfig[];
}

export interface PartnerLedgerLine {
  date: Date;
  entry: unknown;
  itemIndex: number;
  referenceNumber?: string;
  label?: string;
  debit: number;
  credit: number;
  /** Running balance (debit - credit, signed) including this row. */
  balance: number;
  matchingNumber: string | null;
  maturityDate?: Date | null;
  /** Days past `maturityDate` as of `endDate`; null if no maturity set. */
  daysPastDue: number | null;
  isMatched: boolean;
}

export interface PartnerLedgerReport {
  metadata: {
    generatedAt: string;
    partnerId: unknown;
    controlAccount: { id: unknown; name?: string; code?: string };
    period: { startDate: string; endDate: string };
  };
  openingBalance: number;
  closingBalance: number;
  openItemsTotal: number;
  matchedTotal: number;
  lines: PartnerLedgerLine[];
  agedBuckets: Record<string, number>;
}

// ─── Generator ──────────────────────────────────────────────────────────────

export async function generatePartnerLedger(
  opts: PartnerLedgerOptions,
  params: PartnerLedgerParams,
): Promise<PartnerLedgerReport> {
  const { AccountModel, JournalEntryModel, orgField } = opts;
  const {
    controlAccountId,
    partnerField = 'partnerId',
    partnerId,
    startDate,
    endDate,
    includeMatched = true,
    buckets = DEFAULT_BUCKETS,
  } = params;

  requireOrgScope(orgField, params.organizationId);

  // ── Resolve account metadata for the header ─────────────────────────────
  const accountDoc = (await AccountModel.findById(controlAccountId).lean()) as Record<
    string,
    unknown
  > | null;

  // ── Opening balance: sum all activity strictly before startDate ────────
  const openingMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $lt: startDate },
  };
  if (orgField && params.organizationId) openingMatch[orgField] = params.organizationId;

  const openingPipeline: Array<Record<string, unknown>> = [
    { $match: openingMatch },
    { $unwind: '$journalItems' },
    {
      $match: {
        'journalItems.account': controlAccountId,
        [`journalItems.${partnerField}`]: partnerId,
      },
    },
    {
      $group: {
        _id: null,
        debit: { $sum: { $ifNull: ['$journalItems.debit', 0] } },
        credit: { $sum: { $ifNull: ['$journalItems.credit', 0] } },
      },
    },
  ];
  const openingResult = (await JournalEntryModel.aggregate(
    openingPipeline as unknown as Parameters<typeof JournalEntryModel.aggregate>[0],
  )) as Array<{ debit?: number; credit?: number }>;
  const openingBalance = (openingResult[0]?.debit ?? 0) - (openingResult[0]?.credit ?? 0);

  // ── Period activity with running balance ───────────────────────────────
  const periodMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && params.organizationId) periodMatch[orgField] = params.organizationId;

  const itemMatch: Record<string, unknown> = {
    'journalItems.account': controlAccountId,
    [`journalItems.${partnerField}`]: partnerId,
  };
  if (!includeMatched) {
    itemMatch.$or = [
      { 'journalItems.matchingNumber': null },
      { 'journalItems.matchingNumber': { $exists: false } },
    ];
  }

  const linePipeline: Array<Record<string, unknown>> = [
    { $match: periodMatch },
    {
      $addFields: {
        journalItems: {
          $map: {
            input: { $range: [0, { $size: '$journalItems' }] },
            as: 'idx',
            in: {
              $mergeObjects: [
                { $arrayElemAt: ['$journalItems', '$$idx'] },
                { _itemIndex: '$$idx' },
              ],
            },
          },
        },
      },
    },
    { $unwind: '$journalItems' },
    { $match: itemMatch },
    {
      $project: {
        _id: 0,
        entry: '$_id',
        itemIndex: '$journalItems._itemIndex',
        date: { $ifNull: ['$journalItems.date', '$date'] },
        referenceNumber: 1,
        label: '$journalItems.label',
        debit: { $ifNull: ['$journalItems.debit', 0] },
        credit: { $ifNull: ['$journalItems.credit', 0] },
        signedDelta: {
          $subtract: [
            { $ifNull: ['$journalItems.debit', 0] },
            { $ifNull: ['$journalItems.credit', 0] },
          ],
        },
        matchingNumber: '$journalItems.matchingNumber',
        maturityDate: '$journalItems.maturityDate',
      },
    },
    { $sort: { date: 1, entry: 1, itemIndex: 1 } },
    {
      $setWindowFields: {
        sortBy: { date: 1, entry: 1, itemIndex: 1 },
        output: {
          runningDelta: {
            $sum: '$signedDelta',
            window: { documents: ['unbounded', 'current'] },
          },
        },
      },
    },
  ];

  const rawLines = (await JournalEntryModel.aggregate(
    linePipeline as unknown as Parameters<typeof JournalEntryModel.aggregate>[0],
  )) as Array<{
    date: Date;
    entry: unknown;
    itemIndex: number;
    referenceNumber?: string;
    label?: string;
    debit: number;
    credit: number;
    runningDelta: number;
    matchingNumber: string | null;
    maturityDate?: Date | null;
  }>;

  const endMs = endDate.getTime();
  const lines: PartnerLedgerLine[] = rawLines.map((r) => {
    const matchingNumber = r.matchingNumber ?? null;
    const maturityDate = r.maturityDate ?? null;
    const daysPastDue = maturityDate
      ? Math.max(0, Math.floor((endMs - new Date(maturityDate).getTime()) / 86_400_000))
      : null;
    return {
      date: r.date,
      entry: r.entry,
      itemIndex: r.itemIndex,
      referenceNumber: r.referenceNumber,
      label: r.label,
      debit: r.debit,
      credit: r.credit,
      balance: openingBalance + r.runningDelta,
      matchingNumber,
      maturityDate,
      daysPastDue,
      isMatched: matchingNumber != null,
    };
  });

  const closingBalance = lines.length > 0 ? lines[lines.length - 1].balance : openingBalance;

  let openItemsTotal = 0;
  let matchedTotal = 0;
  for (const l of lines) {
    const delta = l.debit - l.credit;
    if (l.isMatched) matchedTotal += delta;
    else openItemsTotal += delta;
  }

  // ── Aged buckets over the OPEN items as of endDate ─────────────────────
  const agedBuckets: Record<string, number> = Object.fromEntries(buckets.map((b) => [b.label, 0]));
  for (const l of lines) {
    if (l.isMatched) continue;
    const days = l.daysPastDue ?? 0;
    const bucket = buckets.find((b) => days >= b.minDays && days < b.maxDays);
    if (bucket) agedBuckets[bucket.label] += l.debit - l.credit;
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      partnerId,
      controlAccount: {
        id: controlAccountId,
        name: accountDoc?.name as string | undefined,
        code: accountDoc?.accountNumber as string | undefined,
      },
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
    },
    openingBalance,
    closingBalance,
    openItemsTotal,
    matchedTotal,
    lines,
    agedBuckets,
  };
}
