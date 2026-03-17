/**
 * Balance Sheet Report
 *
 * Assets = Liabilities + Equity
 * Net income injected into retained earnings for the current fiscal year.
 */

import type { Model, PipelineStage } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { BalanceSheetReport, ReportCategory, ReportGroup, ReportAccount } from '../types/report.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { computeEndingBalance, calculateTotal, isVirtualTaxAccount } from '../utils/account-helpers.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { extractMainType } from '../constants/categories.js';
import type { CategoryKey } from '../types/core.js';

export interface BalanceSheetOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  fiscalYearStartMonth?: number;
  /** Display code for prior retained earnings (default: '3660') */
  retainedEarningsCode?: string;
  /** Display code for current year net income (default: '3680') */
  currentYearEarningsCode?: string;
}

export async function generateBalanceSheet(
  opts: BalanceSheetOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    businessName?: string;
  },
): Promise<BalanceSheetReport> {
  const {
    AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth = 1,
    retainedEarningsCode = '3660', currentYearEarningsCode = '3680',
  } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { endDate } = getDateRange(params.dateOption, params.dateValue);
  const fiscalYearStart = getFiscalYearStart(endDate, fiscalYearStartMonth);

  // Fetch accounts
  const q: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) q[orgField] = params.organizationId;
  const allAccounts = await AccountModel.find(q).lean() as Array<Record<string, unknown>>;

  // Balance sheet account IDs
  const bsIds = allAccounts
    .filter(a => {
      const at = country.getAccountType(a.accountTypeCode as string);
      return at && !at.isGroup && at.category.startsWith('Balance Sheet');
    })
    .map(a => a._id);

  // Income statement account IDs (for net income calculation)
  const isIds = allAccounts
    .filter(a => {
      const at = country.getAccountType(a.accountTypeCode as string);
      return at && !at.isGroup && !at.isTotal && at.category.startsWith('Income Statement');
    })
    .map(a => a._id);

  const baseMatch: Record<string, unknown> = { state: 'posted' };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  // Run pipelines in parallel
  const [bsResults, netIncomeResults, priorRetainedResults] = await Promise.all([
    // Balance sheet balances (all time up to endDate)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $lte: endDate } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: bsIds } } },
      { $group: { _id: '$journalItems.account', d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,

    // Net income (fiscal year start → endDate)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $gte: fiscalYearStart, $lte: endDate } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: isIds } } },
      { $group: { _id: null, d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,

    // Prior retained earnings (all income statement before fiscal year)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $lt: fiscalYearStart } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: isIds } } },
      { $group: { _id: null, d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,
  ]);

  const netIncome = netIncomeResults.length > 0 ? netIncomeResults[0].c - netIncomeResults[0].d : 0;
  const priorRetained = priorRetainedResults.length > 0 ? priorRetainedResults[0].c - priorRetainedResults[0].d : 0;

  // Build categories
  const accountMap = new Map(allAccounts.map(a => [String(a._id), a]));
  const balanceMap = new Map<string, number>();

  const assets: ReportCategory = { name: 'Assets', total: 0, groups: [] };
  const liabilities: ReportCategory = { name: 'Liabilities', total: 0, groups: [] };
  const equity: ReportCategory = { name: 'Equity', total: 0, groups: [] };

  const groupsMap: Record<string, Record<string, ReportGroup>> = {
    Asset: {}, Liability: {}, Equity: {},
  };

  for (const r of bsResults) {
    const acc = accountMap.get(String(r._id));
    if (!acc) continue;

    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at) continue;

    const mainType = extractMainType(at.category) ?? 'Asset';
    const balance = computeEndingBalance(at.category as CategoryKey, r.d, r.c);
    balanceMap.set(at.code, balance);

    const parentAt = at.parentCode ? country.getAccountType(at.parentCode) : undefined;
    const groupName = parentAt?.name ?? at.name;

    if (!(groupName in groupsMap[mainType])) {
      groupsMap[mainType][groupName] = { name: groupName, total: 0, accounts: [] };
    }

    const group = groupsMap[mainType][groupName];

    // Skip virtual tax accounts from display but include in calculation
    if (!isVirtualTaxAccount(at.code)) {
      group.accounts.push({
        id: acc._id,
        name: at.name,
        code: at.code,
        balance,
        isTotal: at.isTotal,
        isVirtualTotal: at.isVirtualTotal,
      });
    }

    if (!at.isTotal) {
      group.total += balance;
    }
  }

  // Add retained earnings to equity
  const reGroup: ReportGroup = {
    name: 'Retained Earnings',
    total: priorRetained + netIncome,
    accounts: [
      { id: 'prior-retained', name: 'Previous Years Retained Earnings', code: retainedEarningsCode, balance: priorRetained },
      { id: 'current-year', name: `Current Year Net Income (${endDate.getFullYear()})`, code: currentYearEarningsCode, balance: netIncome, isCalculated: true },
    ],
  };

  if (!(reGroup.name in groupsMap.Equity)) {
    groupsMap.Equity[reGroup.name] = reGroup;
  } else {
    groupsMap.Equity[reGroup.name].accounts.push(...reGroup.accounts);
    groupsMap.Equity[reGroup.name].total += reGroup.total;
  }

  // Convert groups maps to arrays
  assets.groups = Object.values(groupsMap.Asset);
  liabilities.groups = Object.values(groupsMap.Liability);
  equity.groups = Object.values(groupsMap.Equity);

  // Sum totals
  assets.total = assets.groups.reduce((s, g) => s + g.total, 0);
  liabilities.total = liabilities.groups.reduce((s, g) => s + g.total, 0);
  equity.total = equity.groups.reduce((s, g) => s + g.total, 0);

  const liabilitiesAndEquity = liabilities.total + equity.total;

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      asOfDate: endDate.toISOString().split('T')[0],
      displayDate: `As of ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    },
    assets,
    liabilities,
    equity,
    summary: {
      totalAssets: assets.total,
      totalLiabilities: liabilities.total,
      totalEquity: equity.total,
      liabilitiesAndEquity,
      difference: assets.total - liabilitiesAndEquity,
      isBalanced: assets.total === liabilitiesAndEquity,
    },
  };
}
