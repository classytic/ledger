/**
 * Budget vs Actual Report
 *
 * Compares budgeted amounts against actual journal entry balances
 * for a given period. All monetary values are integer cents.
 */

import mongoose from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { CategoryKey } from '../types/core.js';
import { getDateRange } from '../utils/date-range.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { extractMainType } from '../constants/categories.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface BudgetVsActualOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  BudgetModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
}

export interface BudgetVsActualParams {
  organizationId?: unknown;
  dateOption: 'month' | 'quarter' | 'year' | 'custom';
  dateValue: unknown;
  accountIds?: unknown[];
  filters?: Record<string, unknown>;
}

export interface BudgetVsActualRow {
  accountId: unknown;
  accountName: string;
  accountCode: string;
  category: string;
  budgetAmount: number;
  actualAmount: number;
  variance: number;
  variancePercent: number;
}

export interface BudgetVsActualReport {
  metadata: { generatedAt: string; periodStart: string; periodEnd: string };
  rows: BudgetVsActualRow[];
  summary: {
    totalBudget: number;
    totalActual: number;
    totalVariance: number;
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

export async function generateBudgetVsActual(
  opts: BudgetVsActualOptions,
  params: BudgetVsActualParams,
): Promise<BudgetVsActualReport> {
  const { AccountModel, JournalEntryModel, BudgetModel, country, orgField } = opts;
  requireOrgScope(orgField, params.organizationId);

  const { startDate, endDate } = getDateRange(params.dateOption, params.dateValue);

  // 1. Query budget records overlapping the period
  const budgetQuery: Record<string, unknown> = {
    periodStart: { $lte: endDate },
    periodEnd: { $gte: startDate },
  };
  if (orgField && params.organizationId) budgetQuery[orgField] = params.organizationId;
  if (params.accountIds && params.accountIds.length > 0) {
    budgetQuery.account = { $in: params.accountIds };
  }

  const budgets = await BudgetModel.find(budgetQuery).lean() as Array<Record<string, unknown>>;

  if (budgets.length === 0) {
    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        periodStart: startDate.toISOString(),
        periodEnd: endDate.toISOString(),
      },
      rows: [],
      summary: { totalBudget: 0, totalActual: 0, totalVariance: 0 },
    };
  }

  // 2. Aggregate budget amounts per account
  const budgetByAccount = new Map<string, number>();
  for (const b of budgets) {
    const key = String(b.account);
    budgetByAccount.set(key, (budgetByAccount.get(key) ?? 0) + (b.amount as number));
  }

  const accountIds = [...budgetByAccount.keys()];

  // 3. Fetch account details
  const accountQuery: Record<string, unknown> = { _id: { $in: accountIds } };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;
  const accounts = await AccountModel.find(accountQuery).lean() as Array<Record<string, unknown>>;
  const accountMap = new Map(accounts.map(a => [String(a._id), a]));

  // 4. Aggregate actual balances from posted journal entries
  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && params.organizationId) baseMatch[orgField] = params.organizationId;

  const pipeline: PipelineStage[] = [
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: accountIds.map(id => new mongoose.Types.ObjectId(id)) } } },
    { $group: {
      _id: '$journalItems.account',
      totalDebit: { $sum: '$journalItems.debit' },
      totalCredit: { $sum: '$journalItems.credit' },
    } },
  ];

  const actuals = await JournalEntryModel.aggregate(pipeline);
  const actualByAccount = new Map<string, { debit: number; credit: number }>();
  for (const a of actuals) {
    actualByAccount.set(String(a._id), { debit: a.totalDebit, credit: a.totalCredit });
  }

  // 5. Build rows
  const rows: BudgetVsActualRow[] = [];

  for (const [accountId, budgetAmount] of budgetByAccount) {
    const acc = accountMap.get(accountId);
    if (!acc) continue;

    const at = country.getAccountType(acc.accountTypeCode as string);
    if (!at || at.isGroup) continue;

    const actual = actualByAccount.get(accountId) ?? { debit: 0, credit: 0 };

    // For income accounts: actual = credits - debits
    // For expense accounts: actual = debits - credits
    const mainType = extractMainType(at.category as string);
    let actualAmount: number;
    if (mainType === 'Income') {
      actualAmount = actual.credit - actual.debit;
    } else if (mainType === 'Expense') {
      actualAmount = actual.debit - actual.credit;
    } else if (mainType === 'Asset') {
      actualAmount = actual.debit - actual.credit;
    } else {
      // Liability, Equity
      actualAmount = actual.credit - actual.debit;
    }

    const variance = actualAmount - budgetAmount;
    const variancePercent = budgetAmount !== 0
      ? Math.round((variance / budgetAmount) * 10000) / 100
      : 0;

    rows.push({
      accountId: acc._id,
      accountName: acc.name as string,
      accountCode: acc.accountNumber as string,
      category: at.category,
      budgetAmount,
      actualAmount,
      variance,
      variancePercent,
    });
  }

  // 6. Sort by account code
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  // 7. Summary
  const summary = {
    totalBudget: rows.reduce((s, r) => s + r.budgetAmount, 0),
    totalActual: rows.reduce((s, r) => s + r.actualAmount, 0),
    totalVariance: rows.reduce((s, r) => s + r.variance, 0),
  };

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      periodStart: startDate.toISOString(),
      periodEnd: endDate.toISOString(),
    },
    rows,
    summary,
  };
}
