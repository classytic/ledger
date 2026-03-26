/**
 * Income Statement (Profit & Loss) Report
 *
 * Revenue - COGS = Gross Profit
 * Gross Profit - Operating Expenses = Operating Income
 * Operating Income ± Other = Net Income
 */

import type { Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { IncomeStatementReport, ReportCategory, ReportGroup } from '../types/report.js';
import { getDateRange } from '../utils/date-range.js';
import { extractMainType } from '../constants/categories.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { buildItemFilters } from '../utils/filter-builder.js';

export interface IncomeStatementOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
}

export async function generateIncomeStatement(
  opts: IncomeStatementOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    businessName?: string;
    filters?: Record<string, unknown>;
  },
): Promise<IncomeStatementReport> {
  const { AccountModel, JournalEntryModel, country, orgField } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);
  const itemFilters = buildItemFilters(params.filters);

  // Fetch accounts
  const q: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) q[orgField] = params.organizationId;
  const allAccounts = await AccountModel.find(q).lean() as Array<Record<string, unknown>>;

  // Income statement posting accounts only
  const isAccounts = allAccounts.filter(a => {
    const at = country.getAccountType(a.accountTypeCode as string);
    return at && !at.isGroup && !at.isTotal && at.category.startsWith('Income Statement');
  });
  const isIds = isAccounts.map(a => a._id);

  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const results = await JournalEntryModel.aggregate([
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: isIds }, ...itemFilters } },
    { $group: { _id: '$journalItems.account', d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
  ]) as Array<{ _id: unknown; d: number; c: number }>;

  const accountMap = new Map(allAccounts.map(a => [String(a._id), a]));

  // Organize into revenue and expenses
  const revenueGroups: Record<string, ReportGroup> = {};
  const expenseGroups: Record<string, ReportGroup> = {};

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

  for (const r of results) {
    const acc = accountMap.get(String(r._id));
    if (!acc) continue;

    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at) continue;

    const mainType = extractMainType(at.category);
    const netAmount = mainType === 'Income' ? r.c - r.d : r.d - r.c;
    if (netAmount === 0) continue;

    const groupName = resolveGroupName(at);

    const groups = mainType === 'Income' ? revenueGroups : expenseGroups;

    if (!(groupName in groups)) {
      groups[groupName] = { name: groupName, total: 0, accounts: [] };
    }

    groups[groupName].accounts.push({
      id: acc._id,
      name: (acc.name as string) ?? at.name,
      code: (acc.accountNumber as string) ?? at.code,
      balance: netAmount,
    });
    groups[groupName].total += netAmount;
  }

  const labels = country.reportLabels ?? {};
  const revenue: ReportCategory = {
    name: labels.revenue ?? 'Revenue',
    total: Object.values(revenueGroups).reduce((s, g) => s + g.total, 0),
    groups: Object.values(revenueGroups),
  };

  const expenses: ReportCategory = {
    name: labels.expenses ?? 'Expenses',
    total: Object.values(expenseGroups).reduce((s, g) => s + g.total, 0),
    groups: Object.values(expenseGroups),
  };

  // Calculate COGS — use pack-declared group code, fall back to common names
  const cogsCode = country.cogsGroupCode;
  const isCogs = (name: string) =>
    cogsCode
      ? name === cogsCode
      : name === 'Cost of Sales' || name === 'Cost of Goods Sold';

  const cogsGroup = expenses.groups.find(g => isCogs(g.name));
  const costOfSales = cogsGroup?.total ?? 0;
  const grossProfit = revenue.total - costOfSales;
  const operatingExpenses = expenses.groups
    .filter(g => !isCogs(g.name))
    .reduce((s, g) => s + g.total, 0);
  const operatingIncome = grossProfit - operatingExpenses;
  const netIncome = revenue.total - expenses.total;

  const periodDisplay =
    params.dateOption === 'year'
      ? `For the year ended ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
      : `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: startDate.toISOString().split('T')[0],
      periodEnd: endDate.toISOString().split('T')[0],
      displayPeriod: periodDisplay,
    },
    revenue,
    costOfSales,
    grossProfit,
    expenses,
    operatingIncome,
    netIncome,
  };
}
