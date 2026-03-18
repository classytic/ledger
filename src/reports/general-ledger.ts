/**
 * General Ledger Report
 *
 * Shows every posted entry for selected accounts with running balances.
 * Uses batched queries (3 max) instead of per-account loops.
 */

import type { Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { GeneralLedgerReport, GeneralLedgerAccount, LedgerEntry } from '../types/report.js';
import type { AccountType } from '../types/core.js';
import type { CategoryKey } from '../types/core.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { computeEndingBalance } from '../utils/account-helpers.js';
import { extractMainType } from '../constants/categories.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { buildItemFilters } from '../utils/filter-builder.js';

export interface GeneralLedgerOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  fiscalYearStartMonth?: number;
}

export async function generateGeneralLedger(
  opts: GeneralLedgerOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    accountId?: string;
    filters?: Record<string, unknown>;
  },
): Promise<GeneralLedgerReport> {
  const { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth = 1 } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);
  const fiscalYearStart = getFiscalYearStart(startDate, fiscalYearStartMonth);
  const itemFilters = buildItemFilters(params.filters);

  // Get target accounts
  const acctQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) acctQuery[orgField] = params.organizationId;
  if (params.accountId) acctQuery._id = params.accountId;

  const allAccounts = await AccountModel.find(acctQuery).lean() as Array<Record<string, unknown>>;

  // Filter to postable accounts (no groups, no totals)
  const filtered: Array<{ acc: Record<string, unknown>; at: AccountType }> = [];
  for (const acc of allAccounts) {
    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at || at.isGroup || at.isTotal) continue;
    filtered.push({ acc, at });
  }

  if (filtered.length === 0) {
    return { accounts: [], period: { startDate, endDate } };
  }

  // Separate BS vs IS account IDs (different opening-balance date ranges)
  const bsAccountIds: unknown[] = [];
  const isAccountIds: unknown[] = [];
  const allAccountIds: unknown[] = [];

  for (const { acc, at } of filtered) {
    allAccountIds.push(acc._id);
    if (at.category.startsWith('Balance Sheet')) {
      bsAccountIds.push(acc._id);
    } else {
      isAccountIds.push(acc._id);
    }
  }

  // Org scope helper
  const orgScope: Record<string, unknown> = {};
  if (orgField && params.organizationId) orgScope[orgField] = params.organizationId;

  // ── Batch queries (3 max, run in parallel) ──────────────────────────────────

  const openingBalancePipeline = (
    accountIds: unknown[],
    dateFilter: Record<string, unknown>,
  ) =>
    accountIds.length > 0
      ? JournalEntryModel.aggregate([
          { $match: { state: 'posted', date: dateFilter, ...orgScope } },
          { $unwind: '$journalItems' },
          { $match: { 'journalItems.account': { $in: accountIds }, ...itemFilters } },
          {
            $group: {
              _id: '$journalItems.account',
              d: { $sum: '$journalItems.debit' },
              c: { $sum: '$journalItems.credit' },
            },
          },
        ])
      : Promise.resolve([]);

  const [bsOpenResults, isOpenResults, periodEntries] = await Promise.all([
    // BS opening: all posted entries before startDate
    openingBalancePipeline(bsAccountIds, { $lt: startDate }),
    // IS opening: posted entries from fiscal year start to before startDate
    openingBalancePipeline(isAccountIds, { $gte: fiscalYearStart, $lt: startDate }),
    // Period entries: all posted entries for any target account in the period
    JournalEntryModel.find({
      state: 'posted',
      date: { $gte: startDate, $lte: endDate },
      'journalItems.account': { $in: allAccountIds },
      ...orgScope,
      ...itemFilters,
    })
      .select('date referenceNumber label journalItems')
      .sort({ date: 1 })
      .lean() as Promise<Array<Record<string, unknown>>>,
  ]);

  // ── Build lookup maps ───────────────────────────────────────────────────────

  // Opening balance by account ID
  const openBalMap = new Map<string, { d: number; c: number }>();
  for (const r of [...(bsOpenResults as Array<{ _id: unknown; d: number; c: number }>),
                    ...(isOpenResults as Array<{ _id: unknown; d: number; c: number }>)]) {
    openBalMap.set(String(r._id), { d: r.d, c: r.c });
  }

  // ── Pre-index period entries by account ID (O(entries × items) once) ────────

  const entryItemsByAccount = new Map<string, Array<{
    date: Date; referenceNumber: string; label: string; debit: number; credit: number;
  }>>();

  for (const entry of periodEntries) {
    const items = (entry.journalItems as Array<Record<string, unknown>>) ?? [];
    for (const item of items) {
      const accId = String(item.account);
      const debit = (item.debit as number) ?? 0;
      const credit = (item.credit as number) ?? 0;

      let list = entryItemsByAccount.get(accId);
      if (!list) {
        list = [];
        entryItemsByAccount.set(accId, list);
      }
      list.push({
        date: entry.date as Date,
        referenceNumber: (entry.referenceNumber as string) ?? '',
        label: (entry.label as string) ?? '',
        debit,
        credit,
      });
    }
  }

  // ── Assemble per-account results (O(accounts + total items)) ──────────────

  const glAccounts: GeneralLedgerAccount[] = [];

  for (const { acc, at } of filtered) {
    const accIdStr = String(acc._id);
    const openData = openBalMap.get(accIdStr);
    const openingBalance = openData
      ? computeEndingBalance(at.category as CategoryKey, openData.d, openData.c)
      : 0;

    let runningBalance = openingBalance;
    const entries: LedgerEntry[] = [];
    const mainType = extractMainType(at.category as CategoryKey);

    const accountItems = entryItemsByAccount.get(accIdStr) ?? [];
    for (const item of accountItems) {
      const delta =
        mainType === 'Asset' || mainType === 'Expense'
          ? item.debit - item.credit
          : item.credit - item.debit;

      runningBalance += delta;

      entries.push({
        date: item.date,
        referenceNumber: item.referenceNumber,
        label: item.label,
        debit: item.debit,
        credit: item.credit,
        runningBalance,
      });
    }

    glAccounts.push({
      account: acc,
      openingBalance,
      entries,
      closingBalance: runningBalance,
    });
  }

  return { accounts: glAccounts, period: { startDate, endDate } };
}
