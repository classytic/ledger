/**
 * Foreign Exchange Revaluation Utilities
 *
 * Pure functions for computing unrealized exchange gains/losses
 * on foreign-currency-denominated balance sheet accounts.
 *
 * All monetary values are integer cents.
 * Exchange rates are decimals (e.g., 1 USD = 1.37 CAD means rate = 1.37).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A new exchange rate for a foreign currency */
export interface RevaluationRate {
  /** ISO 4217 currency code */
  currency: string;
  /** New exchange rate: 1 foreign unit = rate base units (decimal, e.g. 1.37) */
  rate: number;
}

/** An account's foreign-currency balance at historical rates */
export interface AccountForeignBalance {
  accountId: unknown;
  accountName: string;
  accountCode: string;
  currency: string;
  /** Integer cents in foreign currency */
  foreignBalance: number;
  /** Integer cents in base currency (at historical rates) */
  baseBalance: number;
  /** CategoryKey of the account */
  category: string;
}

/** Result of revaluing a single account */
export interface RevaluationResult {
  accountId: unknown;
  accountName: string;
  accountCode: string;
  currency: string;
  foreignBalance: number;
  /** Base currency amount at historical rates (integer cents) */
  historicalBase: number;
  /** Base currency amount at the new rate (integer cents) */
  revaluedBase: number;
  /** revaluedBase - historicalBase; positive = gain, negative = loss */
  gainLoss: number;
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Compute revaluation results for a set of accounts at new exchange rates.
 *
 * For each account, finds the matching rate by currency, computes the
 * revalued base amount, and determines the gain/loss.
 * Accounts with zero gain/loss are excluded from the results.
 *
 * @param accounts - Foreign-currency account balances at historical rates
 * @param rates - New exchange rates to revalue against
 * @param baseCurrency - The functional/base currency code (accounts in this currency are skipped)
 */
export function computeRevaluation(
  accounts: AccountForeignBalance[],
  rates: RevaluationRate[],
  baseCurrency: string,
): RevaluationResult[] {
  const rateMap = new Map(rates.map(r => [r.currency, r.rate]));
  const results: RevaluationResult[] = [];

  for (const acct of accounts) {
    // Skip accounts denominated in the base currency
    if (acct.currency === baseCurrency) continue;

    const rate = rateMap.get(acct.currency);
    if (rate === undefined) continue;

    const revaluedBase = Math.round(acct.foreignBalance * rate);
    const gainLoss = revaluedBase - acct.baseBalance;

    // Skip zero gain/loss
    if (gainLoss === 0) continue;

    results.push({
      accountId: acct.accountId,
      accountName: acct.accountName,
      accountCode: acct.accountCode,
      currency: acct.currency,
      foreignBalance: acct.foreignBalance,
      historicalBase: acct.baseBalance,
      revaluedBase,
      gainLoss,
    });
  }

  return results;
}

/**
 * Build a balanced revaluation journal entry from revaluation results.
 *
 * For each result with a non-zero gain/loss:
 * - Gain (positive gainLoss): Debit the account, Credit the unrealized gain/loss account
 * - Loss (negative gainLoss): Credit the account, Debit the unrealized gain/loss account
 *
 * @param results - Revaluation results from computeRevaluation
 * @param unrealizedGainLossAccountId - The account to book the offsetting entry against
 * @param date - Date for the revaluation entry
 */
export function buildRevaluationEntry(
  results: RevaluationResult[],
  unrealizedGainLossAccountId: unknown,
  date: Date,
): {
  journalItems: Array<{ account: unknown; debit: number; credit: number; label: string; originalDebit: number; originalCredit: number }>;
  totalDebit: number;
  totalCredit: number;
  label: string;
} {
  const journalItems: Array<{ account: unknown; debit: number; credit: number; label: string; originalDebit: number; originalCredit: number }> = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const r of results) {
    if (r.gainLoss === 0) continue;

    const absAmount = Math.abs(r.gainLoss);

    if (r.gainLoss > 0) {
      // Gain: Debit the account (increase asset / decrease liability at new rate)
      journalItems.push({
        account: r.accountId,
        debit: absAmount,
        credit: 0,
        originalDebit: 0,
        originalCredit: 0,
        label: `FX revaluation ${r.currency} — gain`,
      });
      // Credit unrealized gain/loss
      journalItems.push({
        account: unrealizedGainLossAccountId,
        debit: 0,
        credit: absAmount,
        originalDebit: 0,
        originalCredit: 0,
        label: `FX revaluation ${r.currency} — gain`,
      });
    } else {
      // Loss: Credit the account (decrease asset / increase liability at new rate)
      journalItems.push({
        account: r.accountId,
        debit: 0,
        credit: absAmount,
        originalDebit: 0,
        originalCredit: 0,
        label: `FX revaluation ${r.currency} — loss`,
      });
      // Debit unrealized gain/loss
      journalItems.push({
        account: unrealizedGainLossAccountId,
        debit: absAmount,
        credit: 0,
        originalDebit: 0,
        originalCredit: 0,
        label: `FX revaluation ${r.currency} — loss`,
      });
    }

    totalDebit += absAmount;
    totalCredit += absAmount;
  }

  const dateStr = date.toISOString().split('T')[0];

  return {
    journalItems,
    totalDebit,
    totalCredit,
    label: `Foreign exchange revaluation — ${dateStr}`,
  };
}
