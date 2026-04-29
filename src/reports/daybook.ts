/**
 * Daybook Report (Detailed General Journal / Journal Listing)
 *
 * Flat chronological view of every journal item posted within a date range.
 * Designed for the auditor's question:
 *
 *   "Show me every transaction in March, line by line, in the order they
 *    were posted, with running debit/credit totals."
 *
 * Companion to the per-account General Ledger and per-partner Partner
 * Ledger — same data, different axis. Useful for month-end reconciliation
 * when the trial balance is off and a CFO/auditor needs to scan the full
 * day-by-day movement to spot the wrong entry.
 *
 * Single aggregation pipeline against the JournalEntry collection.
 * Optional filters by accountId / journalType / partnerId narrow the cut.
 */

import type { Model } from 'mongoose';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface DaybookOptions {
  JournalEntryModel: Model<unknown>;
  orgField?: string;
}

export interface DaybookParams {
  organizationId?: unknown;
  startDate: Date;
  endDate: Date;
  /** Default `'posted'`. Pass `'draft'` or `'all'` to widen. */
  state?: 'posted' | 'draft' | 'all';
  /** Filter to one specific account (renders that account's daybook slice). */
  accountId?: unknown;
  /** Filter to one journal type (e.g. `'SALES'`, `'PURCHASES'`). */
  journalType?: string;
  /** Filter to one partner (item-level field). */
  partnerId?: unknown;
  /** Field name on each item that holds the partner reference. Default `partnerId`. */
  partnerField?: string;
  /** Hard cap on rows. Default 5000 — prevents accidental full-table dumps. */
  limit?: number;
}

export interface DaybookLine {
  date: Date;
  entryId: unknown;
  itemIndex: number;
  referenceNumber?: string;
  journalType?: string;
  entryLabel?: string;
  itemLabel?: string;
  state?: string;
  accountId: unknown;
  /** Item-level debit in minor units (paisa). */
  debit: number;
  /** Item-level credit in minor units (paisa). */
  credit: number;
  partnerId?: unknown;
  matchingNumber?: string | null;
}

export interface DaybookReport {
  metadata: {
    generatedAt: string;
    period: { startDate: string; endDate: string };
    state: string;
    filters: {
      accountId?: unknown;
      journalType?: string;
      partnerId?: unknown;
    };
    truncated: boolean;
    rowCount: number;
  };
  lines: DaybookLine[];
  /** Sum of debits across the returned slice (minor units). */
  totalDebit: number;
  /** Sum of credits across the returned slice (minor units). */
  totalCredit: number;
  /** Net = totalDebit − totalCredit. Posted-only slices should net to 0. */
  netDelta: number;
}

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50_000;

export async function generateDaybook(
  opts: DaybookOptions,
  params: DaybookParams,
): Promise<DaybookReport> {
  const { JournalEntryModel, orgField } = opts;
  const {
    startDate,
    endDate,
    state = 'posted',
    accountId,
    journalType,
    partnerId,
    partnerField = 'partnerId',
  } = params;

  requireOrgScope(orgField, params.organizationId);

  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const baseMatch: Record<string, unknown> = {
    date: { $gte: startDate, $lte: endDate },
  };
  if (state !== 'all') baseMatch.state = state;
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;
  if (journalType) baseMatch.journalType = journalType;

  const itemMatch: Record<string, unknown> = {};
  if (accountId) itemMatch['journalItems.account'] = accountId;
  if (partnerId !== undefined && partnerId !== null) {
    itemMatch[`journalItems.${partnerField}`] = partnerId;
  }

  const pipeline: Array<Record<string, unknown>> = [
    { $match: baseMatch },
    {
      // Preserve the original item index so callers can deep-link back into
      // the parent JE's `journalItems[i]`.
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
    ...(Object.keys(itemMatch).length > 0 ? [{ $match: itemMatch }] : []),
    {
      $project: {
        _id: 0,
        entryId: '$_id',
        itemIndex: '$journalItems._itemIndex',
        date: { $ifNull: ['$journalItems.date', '$date'] },
        referenceNumber: '$referenceNumber',
        journalType: '$journalType',
        entryLabel: '$label',
        itemLabel: '$journalItems.label',
        state: '$state',
        accountId: '$journalItems.account',
        debit: { $ifNull: ['$journalItems.debit', 0] },
        credit: { $ifNull: ['$journalItems.credit', 0] },
        partnerId: `$journalItems.${partnerField}`,
        matchingNumber: '$journalItems.matchingNumber',
      },
    },
    { $sort: { date: 1, entryId: 1, itemIndex: 1 } },
    // +1 sentinel — we ask for one more than the limit so we can flag
    // truncation without a separate count query. The extra row is dropped
    // from the response.
    { $limit: limit + 1 },
  ];

  const rows = (await JournalEntryModel.aggregate(
    pipeline as unknown as Parameters<typeof JournalEntryModel.aggregate>[0],
  )) as DaybookLine[];

  const truncated = rows.length > limit;
  const lines = truncated ? rows.slice(0, limit) : rows;

  let totalDebit = 0;
  let totalCredit = 0;
  for (const r of lines) {
    totalDebit += r.debit ?? 0;
    totalCredit += r.credit ?? 0;
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
      state,
      filters: {
        ...(accountId ? { accountId } : {}),
        ...(journalType ? { journalType } : {}),
        ...(partnerId !== undefined && partnerId !== null ? { partnerId } : {}),
      },
      truncated,
      rowCount: lines.length,
    },
    lines,
    totalDebit,
    totalCredit,
    netDelta: totalDebit - totalCredit,
  };
}
