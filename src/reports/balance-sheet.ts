/**
 * Balance Sheet Report
 *
 * Assets = Liabilities + Equity
 * Net income injected into retained earnings for the current fiscal year.
 */

import type { Model } from 'mongoose';
import { extractMainType } from '../constants/categories.js';
import type { CountryPack } from '../country/index.js';
import type { CategoryKey } from '../types/core.js';
import type { BalanceSheetReport, ReportCategory, ReportGroup } from '../types/report.js';
import {
  buildAccountTypeMap,
  computeEndingBalance,
  isVirtualTaxAccount,
} from '../utils/account-helpers.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface BalanceSheetOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  fiscalYearStartMonth?: number;
  /**
   * The retained earnings account code (e.g. '3600' CA, '3310' BD).
   * This account is excluded from normal equity grouping and its balance
   * is folded into the computed Retained Earnings section.
   */
  retainedEarningsAccountCode?: string;
  /** Display code for the "Previous Years Retained Earnings" line */
  retainedEarningsDisplayCode?: string;
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
    filters?: Record<string, unknown>;
  },
): Promise<BalanceSheetReport> {
  const {
    AccountModel,
    JournalEntryModel,
    country,
    orgField,
    fiscalYearStartMonth = 1,
    retainedEarningsAccountCode = country.retainedEarningsAccountCode,
    retainedEarningsDisplayCode = country.retainedEarningsDisplayCode ??
      retainedEarningsAccountCode,
    currentYearEarningsCode = country.currentYearEarningsCode ?? '3680',
  } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { endDate } = getDateRange(params.dateOption, params.dateValue);
  const fiscalYearStart = getFiscalYearStart(endDate, fiscalYearStartMonth);
  const itemFilters = buildItemFilters(params.filters);

  // Fetch accounts
  const q: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) q[orgField] = params.organizationId;
  const allAccounts = (await AccountModel.find(q).lean()) as Array<Record<string, unknown>>;

  // Balance sheet account IDs
  const bsIds = allAccounts
    .filter((a) => {
      const at = country.getAccountType(a.accountTypeCode as string);
      return at && !at.isGroup && at.category.startsWith('Balance Sheet');
    })
    .map((a) => a._id);

  // Retained earnings account IDs — accounts matching the RE account code.
  // These are excluded from normal equity grouping; their balance is folded
  // into the computed "Retained Earnings" section (like Odoo's equity_unaffected).
  const reAccountIds = retainedEarningsAccountCode
    ? allAccounts
        .filter((a) => (a.accountTypeCode as string) === retainedEarningsAccountCode)
        .map((a) => a._id)
    : [];
  const reAccountIdSet = new Set(reAccountIds.map(String));

  // Income statement account IDs (for net income calculation)
  const isIds = allAccounts
    .filter((a) => {
      const at = country.getAccountType(a.accountTypeCode as string);
      return at && !at.isGroup && !at.isTotal && at.category.startsWith('Income Statement');
    })
    .map((a) => a._id);

  const baseMatch: Record<string, unknown> = { state: 'posted' };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  // Run pipelines in parallel
  const [bsResults, netIncomeResults, priorRetainedResults, reAccountResults] = await Promise.all([
    // Balance sheet balances (all time up to endDate)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $lte: endDate } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: bsIds }, ...itemFilters } },
      {
        $group: {
          _id: '$journalItems.account',
          d: { $sum: '$journalItems.debit' },
          c: { $sum: '$journalItems.credit' },
        },
      },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,

    // Net income (fiscal year start → endDate)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $gte: fiscalYearStart, $lte: endDate } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: isIds }, ...itemFilters } },
      {
        $group: {
          _id: null,
          d: { $sum: '$journalItems.debit' },
          c: { $sum: '$journalItems.credit' },
        },
      },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,

    // Prior retained earnings from unclosed P&L (all income statement before fiscal year)
    JournalEntryModel.aggregate([
      { $match: { ...baseMatch, date: { $lt: fiscalYearStart } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: isIds }, ...itemFilters } },
      {
        $group: {
          _id: null,
          d: { $sum: '$journalItems.debit' },
          c: { $sum: '$journalItems.credit' },
        },
      },
    ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,

    // Retained earnings account balance (all time up to endDate).
    // Captures: migration entries, year-end closings, dividends, adjustments.
    // Combined with prior P&L to form "Opening Retained Earnings".
    ...(reAccountIds.length > 0
      ? [
          JournalEntryModel.aggregate([
            { $match: { ...baseMatch, date: { $lte: endDate } } },
            { $unwind: '$journalItems' },
            { $match: { 'journalItems.account': { $in: reAccountIds }, ...itemFilters } },
            {
              $group: {
                _id: null,
                d: { $sum: '$journalItems.debit' },
                c: { $sum: '$journalItems.credit' },
              },
            },
          ]) as Promise<Array<{ _id: unknown; d: number; c: number }>>,
        ]
      : [Promise.resolve([]) as Promise<Array<{ _id: unknown; d: number; c: number }>>]),
  ]);

  const netIncome = netIncomeResults.length > 0 ? netIncomeResults[0].c - netIncomeResults[0].d : 0;
  const priorUnclosedPL =
    priorRetainedResults.length > 0 ? priorRetainedResults[0].c - priorRetainedResults[0].d : 0;
  // RE account balance = direct postings to the RE account (migration, closings, dividends)
  // Equity normal balance: credit-positive
  const reAccountBalance =
    reAccountResults.length > 0 ? reAccountResults[0].c - reAccountResults[0].d : 0;
  // Opening retained earnings = RE account balance + unclosed prior-year P&L
  const priorRetained = reAccountBalance + priorUnclosedPL;

  // Build categories
  const accountMap = new Map(allAccounts.map((a) => [String(a._id), a]));
  const accountTypeMap = buildAccountTypeMap(country.accountTypes);
  const balanceMap = new Map<string, number>();

  const labels = country.reportLabels ?? {};
  const assets: ReportCategory = { name: labels.assets ?? 'Assets', total: 0, groups: [] };
  const liabilities: ReportCategory = {
    name: labels.liabilities ?? 'Liabilities',
    total: 0,
    groups: [],
  };
  const equity: ReportCategory = { name: labels.equity ?? 'Equity', total: 0, groups: [] };

  const groupsMap: Record<string, Record<string, ReportGroup>> = {
    Asset: {},
    Liability: {},
    Equity: {},
  };

  for (const r of bsResults) {
    const acc = accountMap.get(String(r._id));
    if (!acc) continue;

    // Skip retained earnings accounts — their balance is folded into the
    // computed "Retained Earnings" section instead of normal equity grouping.
    if (reAccountIdSet.has(String(r._id))) continue;

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

    // Skip virtual tax sub-accounts from display but include in calculation
    if (!isVirtualTaxAccount(at, accountTypeMap)) {
      group.accounts.push({
        id: acc._id,
        name: (acc.name as string) ?? at.name,
        code: (acc.accountNumber as string) ?? at.code,
        balance,
        isTotal: at.isTotal,
        isVirtualTotal: at.isVirtualTotal,
      });
    }

    if (!at.isTotal) {
      group.total += balance;
    }
  }

  // Add retained earnings to equity.
  // Opening RE = RE account balance (migration, closings, dividends) + unclosed prior-year P&L.
  // This is correct whether or not year-end closing entries have been posted:
  //   - With closings: prior P&L = 0 (zeroed out), RE account has the closed balance
  //   - Without closings: prior P&L accumulates, RE account has only direct postings
  const reGroup: ReportGroup = {
    name: 'Retained Earnings',
    total: priorRetained + netIncome,
    accounts: [
      {
        id: 'prior-retained',
        name: 'Previous Years Retained Earnings',
        code: retainedEarningsDisplayCode ?? retainedEarningsAccountCode ?? '',
        balance: priorRetained,
      },
      {
        id: 'current-year',
        name: `Current Year Net Income (${endDate.getFullYear()})`,
        code: currentYearEarningsCode,
        balance: netIncome,
        isCalculated: true,
      },
    ],
  };

  if (!(reGroup.name in groupsMap.Equity)) {
    groupsMap.Equity[reGroup.name] = reGroup;
  } else {
    groupsMap.Equity[reGroup.name].accounts.push(...reGroup.accounts);
    groupsMap.Equity[reGroup.name].total += reGroup.total;
  }

  // Sort accounts within groups by account code (deterministic ordering, like Odoo)
  const sortAccountsInGroups = (groups: Record<string, ReportGroup>) => {
    for (const g of Object.values(groups)) {
      g.accounts.sort((a, b) =>
        (a.code ?? '').localeCompare(b.code ?? '', undefined, { numeric: true }),
      );
    }
  };
  sortAccountsInGroups(groupsMap.Asset);
  sortAccountsInGroups(groupsMap.Liability);
  sortAccountsInGroups(groupsMap.Equity);

  // Sort groups by the lowest account code in each group
  const sortGroupsByCode = (groups: ReportGroup[]) =>
    groups.sort((a, b) => {
      const codeA = a.accounts[0]?.code ?? '';
      const codeB = b.accounts[0]?.code ?? '';
      return codeA.localeCompare(codeB, undefined, { numeric: true });
    });

  // Convert groups maps to arrays, filtering out zero-balance accounts and empty groups
  const pruneGroups = (groups: Record<string, ReportGroup>) =>
    Object.values(groups)
      .map((g) => ({
        ...g,
        accounts: g.accounts.filter((a) => a.balance !== 0 || a.isTotal || a.isCalculated),
      }))
      .filter((g) => g.accounts.length > 0 || g.total !== 0);

  assets.groups = sortGroupsByCode(pruneGroups(groupsMap.Asset));
  liabilities.groups = sortGroupsByCode(pruneGroups(groupsMap.Liability));
  equity.groups = sortGroupsByCode(Object.values(groupsMap.Equity)); // Keep equity as-is (retained earnings always shown)

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
