/**
 * Foreign Exchange Revaluation Report
 *
 * Queries foreign-currency balance sheet accounts, computes unrealized
 * exchange gains/losses at new rates, and optionally creates a
 * revaluation journal entry.
 *
 * All monetary values are integer cents.
 */

import type { Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import {
  type AccountForeignBalance,
  buildRevaluationEntry,
  computeRevaluation,
  type RevaluationRate,
  type RevaluationResult,
} from '../utils/revaluation.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RevaluationOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string | undefined;
  baseCurrency: string;
}

export interface RevaluationParams {
  organizationId?: unknown | undefined;
  asOfDate: Date;
  rates: RevaluationRate[];
  unrealizedGainLossAccountId: unknown;
  /** If true, create and save the revaluation journal entry */
  generateEntry?: boolean | undefined;
}

export interface RevaluationReport {
  metadata: {
    generatedAt: string;
    asOfDate: string;
    baseCurrency: string;
  };
  results: RevaluationResult[];
  totalGainLoss: number;
  /** Present only when generateEntry was true */
  entryId?: unknown | undefined;
}

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Generate a foreign exchange revaluation report.
 *
 * 1. Finds all accounts with a `currency` field (foreign-currency accounts)
 * 2. Filters to balance sheet accounts only (not P&L)
 * 3. Aggregates foreign-currency and base-currency balances from posted entries
 * 4. Computes gain/loss at the new rates
 * 5. Optionally creates and saves a balanced journal entry
 */
export async function generateRevaluation(
  opts: RevaluationOptions,
  params: RevaluationParams,
): Promise<RevaluationReport> {
  const { AccountModel, JournalEntryModel, country, orgField, baseCurrency } = opts;
  requireOrgScope(orgField, params.organizationId);

  // ── 1. Find foreign-currency balance sheet accounts ─────────────────────

  const accountQuery: Record<string, unknown> = {
    active: true,
    currency: { $exists: true, $ne: null },
  };
  if (orgField && params.organizationId) {
    accountQuery[orgField] = params.organizationId;
  }

  const allForeignAccounts = (await AccountModel.find(accountQuery).lean()) as Array<
    Record<string, unknown>
  >;

  // Filter to balance sheet accounts only
  const bsAccounts = allForeignAccounts.filter((a) => {
    const at = country.getAccountType(a.accountTypeCode as string);
    return at && !at.isGroup && at.category.startsWith('Balance Sheet');
  });

  if (bsAccounts.length === 0) {
    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        asOfDate: params.asOfDate.toISOString().split('T')[0],
        baseCurrency,
      },
      results: [],
      totalGainLoss: 0,
    };
  }

  const bsAccountIds = bsAccounts.map((a) => a._id);

  // ── 2. Aggregate balances ───────────────────────────────────────────────

  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $lte: params.asOfDate },
  };
  if (orgField && params.organizationId) {
    baseMatch[orgField] = params.organizationId;
  }

  const balanceResults = (await JournalEntryModel.aggregate([
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: bsAccountIds } } },
    {
      $group: {
        _id: '$journalItems.account',
        debit: { $sum: '$journalItems.debit' },
        credit: { $sum: '$journalItems.credit' },
        originalDebit: { $sum: { $ifNull: ['$journalItems.originalDebit', 0] } },
        originalCredit: { $sum: { $ifNull: ['$journalItems.originalCredit', 0] } },
      },
    },
  ])) as Array<{
    _id: unknown;
    debit: number;
    credit: number;
    originalDebit: number;
    originalCredit: number;
  }>;

  // ── 3. Build AccountForeignBalance array ────────────────────────────────

  const accountMap = new Map(bsAccounts.map((a) => [String(a._id), a]));

  const accountBalances: AccountForeignBalance[] = [];
  for (const r of balanceResults) {
    const acct = accountMap.get(String(r._id));
    if (!acct) continue;

    const at = country.getAccountType(acct.accountTypeCode as string);
    if (!at) continue;

    accountBalances.push({
      accountId: r._id,
      accountName: (acct.name as string) ?? at.name,
      accountCode: (acct.accountNumber as string) ?? at.code,
      currency: acct.currency as string,
      foreignBalance: r.originalDebit - r.originalCredit,
      baseBalance: r.debit - r.credit,
      category: at.category,
    });
  }

  // ── 4. Compute revaluation ──────────────────────────────────────────────

  const results = computeRevaluation(accountBalances, params.rates, baseCurrency);

  const totalGainLoss = results.reduce((sum, r) => sum + r.gainLoss, 0);

  // ── 5. Optionally create journal entry ──────────────────────────────────

  let entryId: unknown;

  if (params.generateEntry && results.length > 0) {
    const entryData = buildRevaluationEntry(
      results,
      params.unrealizedGainLossAccountId,
      params.asOfDate,
    );

    const doc: Record<string, unknown> = {
      journalType: 'GENERAL',
      state: 'posted',
      date: params.asOfDate,
      label: entryData.label,
      journalItems: entryData.journalItems,
      totalDebit: entryData.totalDebit,
      totalCredit: entryData.totalCredit,
    };

    if (orgField && params.organizationId) {
      doc[orgField] = params.organizationId;
    }

    const saved = await JournalEntryModel.create(doc);
    entryId = (saved as unknown as Record<string, unknown>)._id;
  }

  // ── 6. Return report ───────────────────────────────────────────────────

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      asOfDate: params.asOfDate.toISOString().split('T')[0],
      baseCurrency,
    },
    results,
    totalGainLoss,
    ...(entryId !== undefined ? { entryId } : {}),
  };
}
