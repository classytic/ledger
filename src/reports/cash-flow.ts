/**
 * Cash Flow Statement
 *
 * Groups transactions by cashFlowCategory from account type definitions:
 * Operating, Investing, Financing.
 * Uses aggregation pipeline — no in-memory processing.
 */

import type { Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { CashFlowCategory, CategoryKey } from '../types/core.js';
import type { CashFlowReport } from '../types/report.js';
import { getDateRange } from '../utils/date-range.js';
import { computeEndingBalance } from '../utils/account-helpers.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface CashFlowOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
}

export async function generateCashFlow(
  opts: CashFlowOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    businessName?: string;
  },
): Promise<CashFlowReport> {
  const { AccountModel, JournalEntryModel, country, orgField } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);

  // Fetch accounts
  const q: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) q[orgField] = params.organizationId;
  const allAccounts = await AccountModel.find(q).lean() as Array<Record<string, unknown>>;

  // Build maps: accountId -> metadata, accountId -> raw account doc
  const accountCfMap = new Map<string, { category: CategoryKey; cfCategory: CashFlowCategory }>();
  const accountMap = new Map(allAccounts.map(a => [String(a._id), a]));
  const cfAccountIds: unknown[] = [];

  for (const acc of allAccounts) {
    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at || at.isGroup || at.isTotal) continue;

    const cf = at.cashFlowCategory;
    if (!cf) continue;

    // Normalize case: 'operating' → 'Operating'
    const normalized = (cf.charAt(0).toUpperCase() + cf.slice(1)) as CashFlowCategory;
    accountCfMap.set(String(acc._id), { category: at.category, cfCategory: normalized });
    cfAccountIds.push(acc._id);
  }

  // Aggregate journal items for accounts with cashFlowCategory
  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const results = cfAccountIds.length > 0
    ? await JournalEntryModel.aggregate([
        { $match: baseMatch },
        { $unwind: '$journalItems' },
        { $match: { 'journalItems.account': { $in: cfAccountIds } } },
        { $group: { _id: '$journalItems.account', d: { $sum: '$journalItems.debit' }, c: { $sum: '$journalItems.credit' } } },
      ]) as Array<{ _id: unknown; d: number; c: number }>
    : [];

  // Accumulate by category
  const flows: Record<CashFlowCategory, { total: number; accounts: Array<{ name: string; code: string; amount: number }> }> = {
    Operating: { total: 0, accounts: [] },
    Investing: { total: 0, accounts: [] },
    Financing: { total: 0, accounts: [] },
  };

  for (const r of results) {
    const accIdStr = String(r._id);
    const meta = accountCfMap.get(accIdStr);
    if (!meta) continue;

    // Net cash flow: for assets/expenses, debit increases (cash out), credit decreases (cash in)
    // For liabilities/equity/income, credit increases, debit decreases
    const amount = computeEndingBalance(meta.category, r.d, r.c);
    const acc = accountMap.get(accIdStr);
    const at = country.getAccountType(acc?.accountTypeCode as string);

    flows[meta.cfCategory].accounts.push({
      name: at?.name ?? '',
      code: at?.code ?? '',
      amount,
    });
    flows[meta.cfCategory].total += amount;
  }

  const netCashFlow = flows.Operating.total + flows.Investing.total + flows.Financing.total;

  const periodDisplay = `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: startDate.toISOString().split('T')[0],
      periodEnd: endDate.toISOString().split('T')[0],
      displayPeriod: periodDisplay,
    },
    operating: flows.Operating,
    investing: flows.Investing,
    financing: flows.Financing,
    netCashFlow,
  };
}
