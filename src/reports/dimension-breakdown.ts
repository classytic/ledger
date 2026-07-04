/**
 * Dimension Breakdown Report
 *
 * Breaks down account balances by a dimension value (e.g. department, project,
 * cost center). Groups journal items by the specified dimension field and then
 * by account, computing net balances in integer cents.
 */

import type { Model, PipelineStage } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import { getDateRange } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DimensionBreakdownOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string | undefined;
  /** IANA reporting zone for civil period boundaries (default 'UTC'). */
  timezone?: string | undefined;
}

export interface DimensionBreakdownParams {
  organizationId?: unknown | undefined;
  dateOption: 'month' | 'quarter' | 'year' | 'custom';
  dateValue: unknown;
  /** Field on journalItems to group by, e.g. 'departmentId' */
  dimension: string;
  /** Filter accounts by category, e.g. 'Income Statement-Expense' */
  accountCategory?: string | undefined;
  /** Additional item-level filters */
  filters?: Record<string, unknown> | undefined;
}

export interface DimensionBreakdownRow {
  dimensionValue: unknown;
  accounts: Array<{ id: unknown; name: string; code: string; balance: number }>;
  total: number;
}

export interface DimensionBreakdownReport {
  metadata: {
    generatedAt: string;
    dimension: string;
    periodStart: string;
    periodEnd: string;
  };
  rows: DimensionBreakdownRow[];
  grandTotal: number;
}

// ─── Generator ──────────────────────────────────────────────────────────────

export async function generateDimensionBreakdown(
  opts: DimensionBreakdownOptions,
  params: DimensionBreakdownParams,
): Promise<DimensionBreakdownReport> {
  const { AccountModel, JournalEntryModel, country, orgField, timezone = 'UTC' } = opts;
  requireOrgScope(orgField, params.organizationId);

  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue, timezone);
  const itemFilters = buildItemFilters(params.filters);

  // ── Fetch accounts ──────────────────────────────────────────────────────

  const accountQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;

  const allAccounts = (await AccountModel.find(accountQuery).lean()) as Array<
    Record<string, unknown>
  >;

  // Filter to posting accounts, optionally by category
  const eligibleAccounts = allAccounts.filter((a) => {
    const at = country.getAccountType(a.accountTypeCode as string);
    if (!at || at.isGroup || at.isTotal) return false;
    if (params.accountCategory && at.category !== params.accountCategory) return false;
    return true;
  });

  const accountIds = eligibleAccounts.map((a) => a._id);
  if (accountIds.length === 0) {
    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        dimension: params.dimension,
        periodStart: startDate.toISOString().split('T')[0],
        periodEnd: endDate.toISOString().split('T')[0],
      },
      rows: [],
      grandTotal: 0,
    };
  }

  const accountMap = new Map(allAccounts.map((a) => [String(a._id), a]));

  // ── Aggregation pipeline ────────────────────────────────────────────────

  const dimensionPath = `journalItems.${params.dimension}`;

  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const pipeline: PipelineStage[] = [
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    {
      $match: {
        'journalItems.account': { $in: accountIds },
        ...itemFilters,
      },
    },
    {
      $group: {
        _id: {
          dimension: `$${dimensionPath}`,
          account: '$journalItems.account',
        },
        d: { $sum: '$journalItems.debit' },
        c: { $sum: '$journalItems.credit' },
      },
    },
  ];

  const results = (await JournalEntryModel.aggregate(pipeline)) as Array<{
    _id: { dimension: unknown; account: unknown };
    d: number;
    c: number;
  }>;

  // ── Build rows ──────────────────────────────────────────────────────────

  // Group results by dimension value
  const dimensionMap = new Map<string, Map<string, { d: number; c: number }>>();

  for (const r of results) {
    const dimKey = r._id.dimension == null ? '__null__' : String(r._id.dimension);
    const accKey = String(r._id.account);

    if (!dimensionMap.has(dimKey)) {
      dimensionMap.set(dimKey, new Map());
    }
    dimensionMap.get(dimKey)?.set(accKey, { d: r.d, c: r.c });
  }

  // Convert to rows
  const rows: DimensionBreakdownRow[] = [];

  // Sort dimension keys: null last, others alphabetically
  const sortedDimKeys = [...dimensionMap.keys()].sort((a, b) => {
    if (a === '__null__') return 1;
    if (b === '__null__') return -1;
    return a.localeCompare(b);
  });

  for (const dimKey of sortedDimKeys) {
    const accountBalances = dimensionMap.get(dimKey)!;
    const dimensionValue =
      dimKey === '__null__'
        ? null
        : (results.find((r) => String(r._id.dimension) === dimKey)?._id.dimension ?? null);

    const accounts: Array<{ id: unknown; name: string; code: string; balance: number }> = [];
    let total = 0;

    for (const [accId, bal] of accountBalances) {
      const acc = accountMap.get(accId);
      if (!acc) continue;

      const at = country.getAccountType(acc.accountTypeCode as string);
      // For expense/asset/debit-normal accounts: balance = debit - credit
      // For income/liability/credit-normal accounts: balance = credit - debit
      const balance =
        at &&
        (at.category === 'Income Statement-Income' ||
          at.category === 'Balance Sheet-Liability' ||
          at.category === 'Balance Sheet-Equity')
          ? bal.c - bal.d
          : bal.d - bal.c;

      accounts.push({
        id: acc._id,
        name: (acc.name as string) ?? at?.name ?? '',
        code: (acc.accountNumber as string) ?? at?.code ?? '',
        balance,
      });
      total += balance;
    }

    // Sort accounts by code within each row
    accounts.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    rows.push({ dimensionValue, accounts, total });
  }

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      dimension: params.dimension,
      periodStart: startDate.toISOString().split('T')[0],
      periodEnd: endDate.toISOString().split('T')[0],
    },
    rows,
    grandTotal,
  };
}
