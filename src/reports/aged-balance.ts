/**
 * Aged Receivable / Payable Report
 *
 * Shows customer/vendor balances bucketed by due-date aging.
 * Useful for cash-flow management and collections prioritization.
 *
 * All monetary values are integer cents.
 */

import type { Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { PeriodColumn } from '../types/report.js';
import { buildAgeBucketColumns } from '../utils/period-columns.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgedBucketConfig {
  label: string;
  minDays: number; // inclusive
  maxDays: number; // exclusive, use Infinity for the last bucket
}

export const DEFAULT_BUCKETS: AgedBucketConfig[] = [
  { label: 'Current', minDays: 0, maxDays: 31 },
  { label: '31-60', minDays: 31, maxDays: 61 },
  { label: '61-90', minDays: 61, maxDays: 91 },
  { label: '90+', minDays: 91, maxDays: Infinity },
];

export interface AgedBalanceOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string | undefined;
}

export interface AgedBalanceParams {
  organizationId?: unknown | undefined;
  asOfDate?: Date | undefined; // defaults to now
  type: 'receivable' | 'payable';
  accountIds?: unknown[] | undefined; // specific AR/AP accounts
  dueDateField?: string | undefined; // field path for due date (default: 'journalItems.dueDate')
  contactField?: string | undefined; // field path for contact grouping (e.g. 'journalItems.contactId')
  buckets?: AgedBucketConfig[] | undefined; // custom buckets, defaults to DEFAULT_BUCKETS
}

export interface AgedBalanceRow {
  accountId: unknown;
  accountName: string;
  accountCode: string;
  contactId?: unknown | undefined;
  total: number; // integer cents
  amounts: Record<string, number>; // bucket label -> cents, aligned with PeriodColumn.key
}

export interface AgedBalanceReport {
  metadata: { generatedAt: string; asOfDate: string; type: string };
  periods: PeriodColumn[];
  rows: AgedBalanceRow[];
  totals: Record<string, number>; // bucket label -> total cents
  grandTotal: number;
}

// ─── Generator ────────────────────────────────────────────────────────────────

export async function generateAgedBalance(
  opts: AgedBalanceOptions,
  params: AgedBalanceParams,
): Promise<AgedBalanceReport> {
  const { AccountModel, JournalEntryModel, country, orgField } = opts;
  requireOrgScope(orgField, params.organizationId);

  const asOfDate = params.asOfDate ?? new Date();
  const buckets = params.buckets ?? DEFAULT_BUCKETS;
  const periods = buildAgeBucketColumns(buckets, asOfDate);
  const bucketLabels = buckets.map((b) => b.label);
  const dueDateField = params.dueDateField ?? 'journalItems.dueDate';
  const contactField = params.contactField;

  // ── 1. Determine target accounts ────────────────────────────────────────

  const accountQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;

  let targetAccountIds: unknown[];

  if (params.accountIds && params.accountIds.length > 0) {
    targetAccountIds = params.accountIds;
  } else {
    const allAccounts = (await AccountModel.find(accountQuery).lean()) as Array<
      Record<string, unknown>
    >;
    const categoryPrefix =
      params.type === 'receivable' ? 'Balance Sheet-Asset' : 'Balance Sheet-Liability';

    targetAccountIds = allAccounts
      .filter((a) => {
        const at = country.getAccountType(a.accountTypeCode as string);
        return at && !at.isGroup && at.category.startsWith(categoryPrefix);
      })
      .map((a) => a._id);
  }

  if (targetAccountIds.length === 0) {
    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        asOfDate: asOfDate.toISOString().split('T')[0],
        type: params.type,
      },
      periods,
      rows: [],
      totals: Object.fromEntries(bucketLabels.map((l) => [l, 0])),
      grandTotal: 0,
    };
  }

  // ── 2. Fetch all accounts for lookup ────────────────────────────────────

  const allAccounts = (await AccountModel.find(accountQuery).lean()) as Array<
    Record<string, unknown>
  >;
  const accountLookup = new Map(allAccounts.map((a) => [String(a._id), a]));

  // ── 3. Aggregate journal items with due dates ───────────────────────────

  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $lte: asOfDate },
  };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  // Compute days past due in the pipeline using $ifNull to handle missing due dates
  // Missing due dates are treated as the entry date (current bucket).
  const _asOfMs = asOfDate.getTime();

  // Build the $group _id based on whether contact grouping is requested
  const groupId: Record<string, unknown> = { account: '$journalItems.account' };
  if (contactField) {
    // Extract the field name after 'journalItems.' for the unwound document
    groupId.contact = `$${contactField}`;
  }

  // Build bucket conditional expressions for $switch
  const bucketBranches = buckets.map((b) => {
    const condition: Record<string, unknown> =
      b.maxDays === Infinity
        ? { $gte: ['$daysPastDue', b.minDays] }
        : { $and: [{ $gte: ['$daysPastDue', b.minDays] }, { $lt: ['$daysPastDue', b.maxDays] }] };

    // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branch syntax
    return { case: condition, then: b.label };
  });

  const pipeline = [
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: targetAccountIds } } },
    // Compute days past due; use $ifNull so missing dueDate defaults to asOfDate (0 days past due)
    {
      $addFields: {
        daysPastDue: {
          $floor: {
            $divide: [
              {
                $subtract: [asOfDate, { $ifNull: [`$${dueDateField}`, asOfDate] }],
              },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
    },
    // Clamp negative days to 0 (future due dates are "Current")
    {
      $addFields: {
        daysPastDue: { $max: ['$daysPastDue', 0] },
      },
    },
    // Assign bucket label
    {
      $addFields: {
        bucketLabel: {
          $switch: {
            branches: bucketBranches,
            default: bucketLabels[bucketLabels.length - 1], // fallback to last bucket
          },
        },
      },
    },
    // Compute net balance (debit - credit for assets/receivables, credit - debit for liabilities/payables)
    {
      $addFields: {
        netAmount:
          params.type === 'receivable'
            ? { $subtract: ['$journalItems.debit', '$journalItems.credit'] }
            : { $subtract: ['$journalItems.credit', '$journalItems.debit'] },
      },
    },
    // Group by account (+ optional contact) + bucket
    {
      $group: {
        _id: { ...groupId, bucket: '$bucketLabel' },
        amount: { $sum: '$netAmount' },
      },
    },
  ];

  const results = (await JournalEntryModel.aggregate(pipeline)) as Array<{
    _id: { account: unknown; contact?: unknown; bucket: string };
    amount: number;
  }>;

  // ── 4. Build rows ──────────────────────────────────────────────────────

  // Group results by account (+ contact)
  const rowKey = (accountId: unknown, contactId?: unknown) =>
    contactField ? `${String(accountId)}::${String(contactId ?? '')}` : String(accountId);

  const rowMap = new Map<string, AgedBalanceRow>();

  for (const r of results) {
    const key = rowKey(r._id.account, r._id.contact);
    if (!rowMap.has(key)) {
      const acc = accountLookup.get(String(r._id.account));
      rowMap.set(key, {
        accountId: r._id.account,
        accountName: (acc?.name as string) ?? '',
        accountCode: (acc?.accountNumber as string) ?? '',
        ...(contactField ? { contactId: r._id.contact } : {}),
        total: 0,
        amounts: Object.fromEntries(bucketLabels.map((l) => [l, 0])),
      });
    }

    const row = rowMap.get(key);
    if (!row) continue;
    if (row.amounts[r._id.bucket] !== undefined) {
      row.amounts[r._id.bucket] += r.amount;
    }
    row.total += r.amount;
  }

  // ── 5. Sort by account code ─────────────────────────────────────────────

  const rows = Array.from(rowMap.values()).sort((a, b) =>
    a.accountCode.localeCompare(b.accountCode, undefined, { numeric: true }),
  );

  // ── 6. Compute totals ──────────────────────────────────────────────────

  const totals: Record<string, number> = Object.fromEntries(bucketLabels.map((l) => [l, 0]));
  let grandTotal = 0;

  for (const row of rows) {
    for (const label of bucketLabels) {
      totals[label] += row.amounts[label];
    }
    grandTotal += row.total;
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      asOfDate: asOfDate.toISOString().split('T')[0],
      type: params.type,
    },
    periods,
    rows,
    totals,
    grandTotal,
  };
}
