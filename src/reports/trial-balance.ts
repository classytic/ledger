/**
 * Trial Balance Report
 *
 * Three-column trial balance: Initial + Current Period + Ending Balance.
 * Pure aggregation pipeline — no cached balances.
 */

import type { Model, PipelineStage } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type {
  TrialBalanceColumnRow,
  TrialBalanceReport,
  TrialBalanceRow,
} from '../types/report.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { buildPeriodColumns, isoDate } from '../utils/period-columns.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface TrialBalanceOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  fiscalYearStartMonth?: number;
  /**
   * Equity account that absorbs prior fiscal years' net income (GIFI '3660' on
   * CA). Defaults to the country pack value. When set, the trial balance rolls
   * pre-current-fiscal-year P&L into this account's OPENING balance so the
   * opening (and therefore ending) columns tie out — Income-Statement accounts
   * reset each fiscal year, and that prior P&L is "closed" into retained
   * earnings in real bookkeeping. Without it the opening column is short by the
   * prior years' net income.
   */
  retainedEarningsAccountCode?: string;
}

export async function generateTrialBalance(
  opts: TrialBalanceOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    accountId?: string;
    comparative?: 'monthly' | 'quarterly' | null;
    businessName?: string;
    filters?: Record<string, unknown>;
  },
): Promise<TrialBalanceReport> {
  const {
    AccountModel,
    JournalEntryModel,
    country,
    orgField,
    fiscalYearStartMonth = 1,
    retainedEarningsAccountCode = country.retainedEarningsAccountCode,
  } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);
  const periods = buildPeriodColumns(startDate, endDate, params.comparative ?? null);
  const itemFilters = buildItemFilters(params.filters);

  // Fetch all active accounts
  const accountQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;

  const allAccounts = (await AccountModel.find(accountQuery).lean()) as Array<
    Record<string, unknown>
  >;

  // Split by statement type
  const bsIds: unknown[] = [];
  const isIds: unknown[] = [];

  for (const acc of allAccounts) {
    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at || at.isGroup) continue;

    if (at.category.startsWith('Balance Sheet')) bsIds.push(acc._id);
    else if (at.category.startsWith('Income Statement')) isIds.push(acc._id);
  }

  const baseMatch: Record<string, unknown> = { state: 'posted' };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const accountFilter = params.accountId ? { 'journalItems.account': params.accountId } : {};

  const accountLookup = new Map(allAccounts.map((a) => [String(a._id), a]));

  // Retained-earnings account that absorbs prior fiscal years' net income.
  // We attach the prior-FY P&L roll-forward to this account's OPENING balance
  // (see computeRowsForRange) so the trial balance ties out. Skip the
  // roll-forward when no RE account is configured/present or when the report is
  // scoped to a single account (a drill-down isn't expected to balance).
  const primaryReId = retainedEarningsAccountCode
    ? allAccounts.find((a) => (a.accountTypeCode as string) === retainedEarningsAccountCode)?._id
    : undefined;
  const rollForwardRE = !!primaryReId && isIds.length > 0 && !params.accountId;

  const buildPipeline = (ids: unknown[], dateFrom: Date, dateTo: Date): PipelineStage[] => [
    { $match: { ...baseMatch, date: { $gte: dateFrom, $lt: dateTo } } },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: ids }, ...accountFilter, ...itemFilters } },
    {
      $group: {
        _id: '$journalItems.account',
        d: { $sum: '$journalItems.debit' },
        c: { $sum: '$journalItems.credit' },
      },
    },
  ];

  const sortRows = (rows: TrialBalanceRow[]) =>
    rows.sort((a, b) => {
      const codeA =
        ((a.account as Record<string, unknown>)?.accountNumber as string) ??
        ((a.account as Record<string, unknown>)?.accountTypeCode as string) ??
        '';
      const codeB =
        ((b.account as Record<string, unknown>)?.accountNumber as string) ??
        ((b.account as Record<string, unknown>)?.accountTypeCode as string) ??
        '';
      return codeA.localeCompare(codeB, undefined, { numeric: true });
    });

  const computeRowsForRange = async (
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<TrialBalanceRow[]> => {
    const fiscalYearStart = getFiscalYearStart(rangeStart, fiscalYearStartMonth);

    const [bsInitial, isInitial, current, priorIs] = await Promise.all([
      bsIds.length
        ? JournalEntryModel.aggregate(buildPipeline(bsIds, new Date(0), rangeStart))
        : [],
      isIds.length
        ? JournalEntryModel.aggregate(buildPipeline(isIds, fiscalYearStart, rangeStart))
        : [],
      JournalEntryModel.aggregate(
        buildPipeline([...bsIds, ...isIds], rangeStart, new Date(rangeEnd.getTime() + 1)),
      ),
      // Pre-current-fiscal-year P&L — closed into retained earnings below so the
      // opening column balances. Only queried when we have an RE account to
      // absorb it (and not a single-account drill).
      rollForwardRE
        ? JournalEntryModel.aggregate(buildPipeline(isIds, new Date(0), fiscalYearStart))
        : [],
    ]);

    const map = new Map<string, { iD: number; iC: number; cD: number; cC: number }>();

    for (const r of [...bsInitial, ...isInitial]) {
      const key = String(r._id);
      map.set(key, { iD: r.d, iC: r.c, cD: 0, cC: 0 });
    }
    for (const r of current) {
      const key = String(r._id);
      const existing = map.get(key) ?? { iD: 0, iC: 0, cD: 0, cC: 0 };
      existing.cD = r.d;
      existing.cC = r.c;
      map.set(key, existing);
    }

    // Roll prior fiscal years' net P&L into the RE account's OPENING balance.
    // priorNet = Σdebit − Σcredit across IS accounts before the fiscal-year
    // start. A prior PROFIT is credit-heavy (net < 0) → credit RE; a prior LOSS
    // (net > 0) → debit RE. This is the only adjustment the opening column needs
    // to tie out (current-period activity is raw and already balances).
    //
    // Correct whether or not a real year-end closing entry was posted: a true
    // closing entry zeroes the prior IS accounts (their debits == credits), so
    // priorNet → 0 and this adds nothing on top of the already-closed RE
    // balance. It only injects when the prior P&L is still "open" in the IS
    // accounts — exactly the case the report must compensate for. (Same
    // assumption as balance-sheet.ts.) Note: unlike the balance sheet, the TB
    // keeps CURRENT-year P&L raw in the IS rows — a trial balance must list
    // every account at its gross balance — so the TB's RE opening (prior only)
    // is intentionally less than the balance sheet's RE total (prior + current).
    if (rollForwardRE && priorIs.length > 0) {
      const priorNet =
        priorIs.reduce((s, r) => s + r.d, 0) - priorIs.reduce((s, r) => s + r.c, 0);
      if (priorNet !== 0) {
        const reKey = String(primaryReId);
        const re = map.get(reKey) ?? { iD: 0, iC: 0, cD: 0, cC: 0 };
        if (priorNet < 0) re.iC += -priorNet;
        else re.iD += priorNet;
        map.set(reKey, re);
      }
    }

    const rows: TrialBalanceRow[] = [];
    for (const [id, bal] of map) {
      const acc = accountLookup.get(id);
      const totalD = bal.iD + bal.cD;
      const totalC = bal.iC + bal.cC;
      const net = totalD - totalC;

      rows.push({
        account: acc ?? id,
        initial: { debit: bal.iD, credit: bal.iC },
        current: { debit: bal.cD, credit: bal.cC },
        ending: net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: Math.abs(net) },
      });
    }

    return sortRows(rows);
  };

  const columnarRowsByAccount = new Map<string, TrialBalanceColumnRow>();
  for (const period of periods) {
    const periodRows = await computeRowsForRange(period.start, period.end);
    for (const row of periodRows) {
      const id = String((row.account as Record<string, unknown>)?._id ?? row.account);
      const columnar = columnarRowsByAccount.get(id) ?? {
        account: row.account,
        initial: {
          debit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
          credit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
        },
        current: {
          debit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
          credit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
        },
        ending: {
          debit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
          credit: Object.fromEntries(periods.map((p) => [p.column.key, 0])),
        },
      };
      columnar.initial.debit[period.column.key] = row.initial.debit;
      columnar.initial.credit[period.column.key] = row.initial.credit;
      columnar.current.debit[period.column.key] = row.current.debit;
      columnar.current.credit[period.column.key] = row.current.credit;
      columnar.ending.debit[period.column.key] = row.ending.debit;
      columnar.ending.credit[period.column.key] = row.ending.credit;
      columnarRowsByAccount.set(id, columnar);
    }
  }

  const columnarRows = [...columnarRowsByAccount.values()].sort((a, b) => {
    const codeA =
      ((a.account as Record<string, unknown>)?.accountNumber as string) ??
      ((a.account as Record<string, unknown>)?.accountTypeCode as string) ??
      '';
    const codeB =
      ((b.account as Record<string, unknown>)?.accountNumber as string) ??
      ((b.account as Record<string, unknown>)?.accountTypeCode as string) ??
      '';
    return codeA.localeCompare(codeB, undefined, { numeric: true });
  });

  const periodDisplay =
    params.dateOption === 'year'
      ? `For the year ended ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
      : `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: isoDate(startDate),
      periodEnd: isoDate(endDate),
      displayPeriod: periodDisplay,
      comparative: params.comparative ?? null,
    },
    period: { startDate, endDate },
    periods: periods.map((p) => p.column),
    columnarRows,
  };
}
