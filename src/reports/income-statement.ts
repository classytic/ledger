/**
 * Income Statement (Profit & Loss) Report
 *
 * Revenue - COGS = Gross Profit
 * Gross Profit - Operating Expenses = Operating Income
 * Operating Income ± Other = Net Income
 */

import type { Model } from 'mongoose';
import { extractMainType } from '../constants/categories.js';
import type { CountryPack } from '../country/index.js';
import type {
  IncomeStatementReport,
  IncomeStatementSection,
  ReportGroup,
} from '../types/report.js';
import { getDateRange } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { buildPeriodColumns, isoDate } from '../utils/period-columns.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface IncomeStatementOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string | undefined;
  /** IANA reporting zone for civil period boundaries (default 'UTC'). */
  timezone?: string | undefined;
}

export async function generateIncomeStatement(
  opts: IncomeStatementOptions,
  params: {
    organizationId?: unknown | undefined;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    comparative?: 'monthly' | 'quarterly' | null | undefined;
    businessName?: string | undefined;
    filters?: Record<string, unknown> | undefined;
  },
): Promise<IncomeStatementReport> {
  const { AccountModel, JournalEntryModel, country, orgField, timezone = 'UTC' } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue, timezone);
  const itemFilters = buildItemFilters(params.filters);
  const periods = buildPeriodColumns(startDate, endDate, params.comparative ?? null, timezone);

  // Fetch accounts
  const q: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) q[orgField] = params.organizationId;
  const allAccounts = (await AccountModel.find(q).lean()) as Array<Record<string, unknown>>;

  // Income statement posting accounts only
  const isAccounts = allAccounts.filter((a) => {
    const at = country.getAccountType(a.accountTypeCode as string);
    return at && !at.isGroup && !at.isTotal && at.category.startsWith('Income Statement');
  });
  const isIds = isAccounts.map((a) => a._id);

  const baseMatch: Record<string, unknown> = { state: 'posted' };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const accountMap = new Map(allAccounts.map((a) => [String(a._id), a]));

  // Resolve the top-level IS group (Revenue, Cost of Sales, Operating Expenses)
  // by walking up the parent chain until hitting a group-label account type.
  const resolveGroupName = (at: { parentCode: string | null; name: string }) => {
    const visited = new Set<string>();
    let current = at.parentCode ? country.getAccountType(at.parentCode) : undefined;
    while (current && !visited.has(current.code)) {
      if (current.isGroup) return current.name;
      visited.add(current.code);
      current = current.parentCode ? country.getAccountType(current.parentCode) : undefined;
    }
    return at.name;
  };

  const cogsCode = country.cogsGroupCode;
  const isCogs = (name: string) =>
    cogsCode ? name === cogsCode : name === 'Cost of Sales' || name === 'Cost of Goods Sold';

  const periodResults = new Map<string, Array<{ _id: unknown; d: number; c: number }>>();
  for (const period of periods) {
    const results = (await JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $gte: period.start, $lte: period.end } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: isIds }, ...itemFilters } },
      {
        $group: {
          _id: '$journalItems.account',
          d: { $sum: '$journalItems.debit' },
          c: { $sum: '$journalItems.credit' },
        },
      },
    ])) as Array<{ _id: unknown; d: number; c: number }>;
    periodResults.set(period.column.key, results);
  }

  const revenueTotals: Record<string, number> = {};
  const expenseTotals: Record<string, number> = {};
  const costOfSalesByPeriod: Record<string, number> = {};
  const grossProfitByPeriod: Record<string, number> = {};
  const operatingIncomeByPeriod: Record<string, number> = {};
  const netIncomeByPeriod: Record<string, number> = {};
  const revenueLines = new Map<
    string,
    { label: string; code: string; group: string; amounts: Record<string, number> }
  >();
  const expenseLines = new Map<
    string,
    { label: string; code: string; group: string; amounts: Record<string, number> }
  >();

  for (const period of periods) {
    const revenuePeriodGroups: Record<string, ReportGroup> = {};
    const expensePeriodGroups: Record<string, ReportGroup> = {};

    for (const r of periodResults.get(period.column.key) ?? []) {
      const acc = accountMap.get(String(r._id));
      if (!acc) continue;

      const at = country.getAccountType(acc.accountTypeCode as string);
      if (!at) continue;

      const mainType = extractMainType(at.category);
      const netAmount = mainType === 'Income' ? r.c - r.d : r.d - r.c;
      if (netAmount === 0) continue;

      const groupName = resolveGroupName(at);
      const targetGroups = mainType === 'Income' ? revenuePeriodGroups : expensePeriodGroups;
      if (!(groupName in targetGroups)) {
        targetGroups[groupName] = { name: groupName, total: 0, accounts: [] };
      }

      targetGroups[groupName].accounts.push({
        id: acc._id,
        name: (acc.name as string) ?? at.name,
        code: (acc.accountNumber as string) ?? at.code,
        balance: netAmount,
      });
      targetGroups[groupName].total += netAmount;

      const lineMap = mainType === 'Income' ? revenueLines : expenseLines;
      const key = String(acc._id);
      const line = lineMap.get(key) ?? {
        label: (acc.name as string) ?? at.name,
        code: (acc.accountNumber as string) ?? at.code,
        group: groupName,
        amounts: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
      };
      line.amounts[period.column.key] = netAmount;
      lineMap.set(key, line);
    }

    const periodRevenue = Object.values(revenuePeriodGroups).reduce((s, g) => s + g.total, 0);
    const periodExpenses = Object.values(expensePeriodGroups).reduce((s, g) => s + g.total, 0);
    const periodCostOfSales = Object.values(expensePeriodGroups)
      .filter((g) => isCogs(g.name))
      .reduce((s, g) => s + g.total, 0);
    const periodGrossProfit = periodRevenue - periodCostOfSales;
    const periodOperatingExpenses = Object.values(expensePeriodGroups)
      .filter((g) => !isCogs(g.name))
      .reduce((s, g) => s + g.total, 0);

    revenueTotals[period.column.key] = periodRevenue;
    expenseTotals[period.column.key] = periodExpenses;
    costOfSalesByPeriod[period.column.key] = periodCostOfSales;
    grossProfitByPeriod[period.column.key] = periodGrossProfit;
    operatingIncomeByPeriod[period.column.key] = periodGrossProfit - periodOperatingExpenses;
    netIncomeByPeriod[period.column.key] = periodRevenue - periodExpenses;
  }

  const sortLines = <T extends { code: string }>(lines: T[]) =>
    lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const revenueSection: IncomeStatementSection = {
    totals: revenueTotals,
    lines: sortLines(
      [...revenueLines.entries()].map(([accountId, line]) => ({
        label: line.label,
        code: line.code,
        amounts: line.amounts,
        source: {
          kind: 'account' as const,
          accountId,
          group: line.group,
          statementType: 'revenue' as const,
        },
      })),
    ),
  };

  const expensesSection: IncomeStatementSection = {
    totals: expenseTotals,
    lines: sortLines(
      [...expenseLines.entries()].map(([accountId, line]) => ({
        label: line.label,
        code: line.code,
        amounts: line.amounts,
        source: {
          kind: 'account' as const,
          accountId,
          group: line.group,
          statementType: 'expense' as const,
        },
      })),
    ),
  };

  const summarySection: IncomeStatementSection = {
    totals: netIncomeByPeriod,
    lines: [
      {
        label: 'Cost of Sales',
        code: '',
        amounts: costOfSalesByPeriod,
        source: { kind: 'aggregate', name: 'costOfSales' },
      },
      {
        label: 'Gross Profit',
        code: '',
        amounts: grossProfitByPeriod,
        source: { kind: 'aggregate', name: 'grossProfit' },
      },
      {
        label: 'Operating Income',
        code: '',
        amounts: operatingIncomeByPeriod,
        source: { kind: 'aggregate', name: 'operatingIncome' },
      },
      {
        label: 'Net Income',
        code: '',
        amounts: netIncomeByPeriod,
        source: { kind: 'aggregate', name: 'netIncome' },
      },
    ],
  };

  const periodDisplay =
    params.dateOption === 'year'
      ? `For the year ended ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })}`
      : `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone })} – ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: timezone })}`;

  // Country-pack display labels — projected onto metadata so the FE can
  // render section headings ("Net Revenue" US, "Revenue" default) without
  // having to keep a copy of the country pack on the consumer side.
  const labels = country.reportLabels ?? {};
  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: isoDate(startDate, timezone),
      periodEnd: isoDate(endDate, timezone),
      displayPeriod: periodDisplay,
      comparative: params.comparative ?? null,
      labels: {
        revenue: labels.revenue,
        expenses: labels.expenses,
      },
    },
    periods: periods.map((p) => p.column),
    revenueSection,
    expensesSection,
    summarySection,
    costOfSalesByPeriod,
    grossProfitByPeriod,
    operatingIncomeByPeriod,
    netIncomeByPeriod,
  };
}
