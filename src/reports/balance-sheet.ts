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
import type {
  BalanceSheetLineSource,
  BalanceSheetReport,
  BalanceSheetSection,
  ReportCategory,
  ReportGroup,
} from '../types/report.js';
import {
  buildAccountTypeMap,
  computeEndingBalance,
  isVirtualTaxAccount,
} from '../utils/account-helpers.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { buildPeriodColumns, isoDate } from '../utils/period-columns.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface BalanceSheetOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string | undefined;
  fiscalYearStartMonth?: number | undefined;
  /** IANA reporting zone for civil period boundaries (default 'UTC'). */
  timezone?: string | undefined;
  /**
   * The retained earnings account code (e.g. '3600' CA, '3310' BD).
   * This account is excluded from normal equity grouping and its balance
   * is folded into the computed Retained Earnings section.
   */
  retainedEarningsAccountCode?: string | undefined;
  /** Display code for the "Previous Years Retained Earnings" line */
  retainedEarningsDisplayCode?: string | undefined;
  /** Display code for current year net income (default: '3680') */
  currentYearEarningsCode?: string | undefined;
}

interface BalanceSheetSnapshot {
  assets: ReportCategory;
  liabilities: ReportCategory;
  equity: ReportCategory;
  summary: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    liabilitiesAndEquity: number;
    difference: number;
    isBalanced: boolean;
  };
}

export async function generateBalanceSheet(
  opts: BalanceSheetOptions,
  params: {
    organizationId?: unknown | undefined;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    comparative?: 'monthly' | 'quarterly' | null | undefined;
    businessName?: string | undefined;
    filters?: Record<string, unknown> | undefined;
  },
): Promise<BalanceSheetReport> {
  const {
    AccountModel,
    JournalEntryModel,
    country,
    orgField,
    fiscalYearStartMonth = 1,
    timezone = 'UTC',
    retainedEarningsAccountCode = country.retainedEarningsAccountCode,
    retainedEarningsDisplayCode = country.retainedEarningsDisplayCode ??
      retainedEarningsAccountCode,
    currentYearEarningsCode = country.currentYearEarningsCode ?? '3680',
  } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue, timezone);
  const periods = buildPeriodColumns(startDate, endDate, params.comparative ?? null, timezone);
  const fiscalYearStart = getFiscalYearStart(endDate, fiscalYearStartMonth, timezone);
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
        name: `Current Year Net Income (${isoDate(endDate, timezone).slice(0, 4)})`,
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

  const currentSnapshot: BalanceSheetSnapshot = {
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

  const summaryByPeriod: BalanceSheetReport['summaryByPeriod'] = {
    totalAssets: {},
    totalLiabilities: {},
    totalEquity: {},
    liabilitiesAndEquity: {},
    difference: {},
    isBalanced: {},
  };
  const snapshotSections = new Map<
    string,
    Pick<BalanceSheetReport, 'assetsSection' | 'liabilitiesSection' | 'equitySection'>
  >();

  for (const period of periods) {
    if (period.column.key === 'total') {
      summaryByPeriod.totalAssets[period.column.key] = currentSnapshot.summary.totalAssets;
      summaryByPeriod.totalLiabilities[period.column.key] =
        currentSnapshot.summary.totalLiabilities;
      summaryByPeriod.totalEquity[period.column.key] = currentSnapshot.summary.totalEquity;
      summaryByPeriod.liabilitiesAndEquity[period.column.key] =
        currentSnapshot.summary.liabilitiesAndEquity;
      summaryByPeriod.difference[period.column.key] = currentSnapshot.summary.difference;
      summaryByPeriod.isBalanced[period.column.key] = currentSnapshot.summary.isBalanced;

      snapshotSections.set(period.column.key, {
        assetsSection: buildBalanceSheetSectionFromCategory('assets', period.column.key, assets),
        liabilitiesSection: buildBalanceSheetSectionFromCategory(
          'liabilities',
          period.column.key,
          liabilities,
        ),
        equitySection: buildBalanceSheetSectionFromCategory('equity', period.column.key, equity),
      });
      continue;
    }

    const snapshot = await generateBalanceSheet(opts, {
      ...params,
      dateOption: 'custom',
      dateValue: { startDate: period.start, endDate: period.end },
      comparative: null,
    });

    summaryByPeriod.totalAssets[period.column.key] =
      snapshot.summaryByPeriod.totalAssets.total ?? 0;
    summaryByPeriod.totalLiabilities[period.column.key] =
      snapshot.summaryByPeriod.totalLiabilities.total ?? 0;
    summaryByPeriod.totalEquity[period.column.key] =
      snapshot.summaryByPeriod.totalEquity.total ?? 0;
    summaryByPeriod.liabilitiesAndEquity[period.column.key] =
      snapshot.summaryByPeriod.liabilitiesAndEquity.total ?? 0;
    summaryByPeriod.difference[period.column.key] = snapshot.summaryByPeriod.difference.total ?? 0;
    summaryByPeriod.isBalanced[period.column.key] =
      snapshot.summaryByPeriod.isBalanced.total ?? false;

    snapshotSections.set(period.column.key, {
      assetsSection: snapshot.assetsSection,
      liabilitiesSection: snapshot.liabilitiesSection,
      equitySection: snapshot.equitySection,
    });
  }

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      asOfDate: isoDate(endDate, timezone),
      displayDate: `As of ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })}`,
      comparative: params.comparative ?? null,
      // Country-pack display labels — same projection as the IS report.
      labels: {
        assets: labels.assets,
        liabilities: labels.liabilities,
        equity: labels.equity,
      },
    },
    periods: periods.map((p) => p.column),
    summaryByPeriod,
    assetsSection: mergeBalanceSheetSections('assetsSection', periods, snapshotSections),
    liabilitiesSection: mergeBalanceSheetSections('liabilitiesSection', periods, snapshotSections),
    equitySection: mergeBalanceSheetSections('equitySection', periods, snapshotSections),
  };
}

function buildBalanceSheetSectionFromCategory(
  section: 'assets' | 'liabilities' | 'equity',
  periodKey: string,
  category: ReportCategory,
): BalanceSheetSection {
  const totals: Record<string, number> = { [periodKey]: category.total };
  const lines: BalanceSheetSection['lines'] = [];

  for (const group of category.groups) {
    for (const account of group.accounts) {
      const accountId = String(account.id);
      lines.push({
        label: account.name,
        code: account.code,
        amounts: { [periodKey]: account.balance },
        source: account.isCalculated
          ? { kind: 'calculated', accountId, group: group.name, section: 'equity' }
          : { kind: 'account', accountId, group: group.name, section },
      });
    }
  }

  return {
    totals,
    lines: lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
  };
}

function mergeBalanceSheetSections(
  key: 'assetsSection' | 'liabilitiesSection' | 'equitySection',
  periods: ReturnType<typeof buildPeriodColumns>,
  snapshots: Map<
    string,
    Pick<BalanceSheetReport, 'assetsSection' | 'liabilitiesSection' | 'equitySection'>
  >,
): BalanceSheetSection {
  const totals: Record<string, number> = Object.fromEntries(periods.map((p) => [p.column.key, 0]));
  const lines = new Map<
    string,
    {
      label: string;
      code: string;
      amounts: Record<string, number>;
      source: BalanceSheetLineSource;
    }
  >();

  for (const period of periods) {
    const snapshot = snapshots.get(period.column.key);
    if (!snapshot) continue;
    const section = snapshot[key];
    totals[period.column.key] = section.totals.total ?? section.totals[period.column.key] ?? 0;

    for (const sourceLine of section.lines) {
      const lineKey =
        'accountId' in sourceLine.source
          ? String(sourceLine.source.accountId)
          : `${sourceLine.code}:${sourceLine.label}`;
      const line = lines.get(lineKey) ?? {
        label: sourceLine.label,
        code: sourceLine.code,
        amounts: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
        source: sourceLine.source,
      };
      line.amounts[period.column.key] =
        sourceLine.amounts.total ?? sourceLine.amounts[period.column.key] ?? 0;
      lines.set(lineKey, line);
    }
  }

  return {
    totals,
    lines: [...lines.values()].sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    ),
  };
}
