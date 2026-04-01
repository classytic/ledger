/**
 * Trial Balance Report
 *
 * Three-column trial balance: Initial + Current Period + Ending Balance.
 * Pure aggregation pipeline — no cached balances.
 */

import type { Model, PipelineStage } from 'mongoose';
import type { AccountType, CategoryKey } from '../types/core.js';
import type { TrialBalanceRow, TrialBalanceReport } from '../types/report.js';
import type { CountryPack } from '../country/index.js';
import { getDateRange, getFiscalYearStart } from '../utils/date-range.js';
import { computeEndingBalance } from '../utils/account-helpers.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { buildItemFilters } from '../utils/filter-builder.js';

export interface TrialBalanceOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  fiscalYearStartMonth?: number;
}

export async function generateTrialBalance(
  opts: TrialBalanceOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    accountId?: string;
    businessName?: string;
    filters?: Record<string, unknown>;
  },
): Promise<TrialBalanceReport> {
  const { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth = 1 } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);
  const fiscalYearStart = getFiscalYearStart(startDate, fiscalYearStartMonth);
  const itemFilters = buildItemFilters(params.filters);

  // Fetch all active accounts
  const accountQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;

  const allAccounts = await AccountModel.find(accountQuery).lean() as Array<Record<string, unknown>>;

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

  // Build pipelines
  const buildPipeline = (ids: unknown[], dateFrom: Date, dateTo: Date): PipelineStage[] => [
    { $match: { ...baseMatch, date: { $gte: dateFrom, $lt: dateTo } } },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: ids }, ...accountFilter, ...itemFilters } },
    { $group: { _id: '$journalItems.account', d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
  ];

  // BS initial: all history before startDate
  // IS initial: fiscal year start → startDate
  // Current: startDate → endDate
  const [bsInitial, isInitial, current] = await Promise.all([
    bsIds.length ? JournalEntryModel.aggregate(buildPipeline(bsIds, new Date(0), startDate)) : [],
    isIds.length ? JournalEntryModel.aggregate(buildPipeline(isIds, fiscalYearStart, startDate)) : [],
    JournalEntryModel.aggregate(buildPipeline([...bsIds, ...isIds], startDate, new Date(endDate.getTime() + 1))),
  ]);

  // Merge
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

  // Build rows
  const accountLookup = new Map(allAccounts.map(a => [String(a._id), a]));

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

  // Sort rows by account code for deterministic output
  rows.sort((a, b) => {
    const codeA = (a.account as Record<string, unknown>)?.accountNumber as string
      ?? (a.account as Record<string, unknown>)?.accountTypeCode as string ?? '';
    const codeB = (b.account as Record<string, unknown>)?.accountNumber as string
      ?? (b.account as Record<string, unknown>)?.accountTypeCode as string ?? '';
    return codeA.localeCompare(codeB, undefined, { numeric: true });
  });

  const periodDisplay = params.dateOption === 'year'
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
    rows,
    period: { startDate, endDate },
  };
}
