/**
 * `buildOpeningBalanceEntry` — pure function that builds a multi-line
 * opening balance journal entry from a list of account balances.
 *
 * **No DB, no Mongoose, no country pack dependency.** The caller resolves
 * account codes to ObjectIds and passes the equity code. This makes it:
 *   - Agent-callable (any MCP tool can produce the input)
 *   - Testable without any infrastructure
 *   - Reusable across all country packs
 *
 * Follows the conventions of Odoo (contra = retained earnings), Beancount
 * (Equity:Opening-Balances), and ERPNext (is_opening flag):
 *   - Each balance > 0 → debit that account
 *   - Each balance < 0 → credit that account
 *   - Residual → contra-line on equity account
 *   - Only balance sheet accounts (caller filters P&L before calling)
 *
 * @example
 * ```typescript
 * import { buildOpeningBalanceEntry } from '@classytic/ledger';
 *
 * const result = buildOpeningBalanceEntry({
 *   cutoverDate: new Date('2025-01-01'),
 *   balances: [
 *     { accountCode: '1000', balance: 5000000 },  // $50,000 debit (cash)
 *     { accountCode: '2620', balance: -1875000 },  // $18,750 credit (AP)
 *   ],
 *   equityAccountCode: '3600',  // retained earnings
 * });
 *
 * // result.entry is a JournalEntryInput ready for journalEntries.create()
 * // result.residual should be 0 for a balanced trial balance
 * ```
 */

import type { Cents } from '../types/core.js';
import type { JournalEntryInput, JournalItemInput } from '../types/journal-input.js';

export interface OpeningBalanceInput {
  /** Cutover date — typically the start of fiscal year.
   *  The opening balance entry is dated on this day. */
  cutoverDate: Date;

  /**
   * Account balances in integer cents (minor units), signed:
   *   - Positive = normal debit balance (assets, expenses)
   *   - Negative = normal credit balance (liabilities, equity, revenue)
   *
   * Callers should include balance sheet accounts only (assets, liabilities,
   * equity). P&L cumulative effect belongs in retained earnings (the equity
   * contra account) — this matches the Odoo and Beancount convention.
   *
   * The `accountCode` is opaque at this layer — it can be a GIFI code, a
   * custom account number, or an ObjectId string. The consumer resolves it.
   */
  balances: ReadonlyArray<{
    accountCode: string;
    /** Signed balance in integer cents. */
    balance: number;
  }>;

  /**
   * The equity account that absorbs the difference. Typically:
   *   - CA: '3600' (Retained Earnings)
   *   - BD: '3310' (Retained Earnings)
   *   - Generic: 'Opening Balance Equity'
   *
   * This follows Odoo's pattern (unaffected earnings) rather than ERPNext's
   * temporary account, because the retained earnings approach is
   * audit-clean and doesn't require a zeroing-out step.
   */
  equityAccountCode: string;

  /** Optional label. Defaults to 'Opening Balance — Cutover YYYY-MM-DD'. */
  label?: string | undefined;
}

export interface OpeningBalanceResult {
  /** The journal entry input, ready for `journalEntries.create()`. */
  entry: JournalEntryInput;

  /** The net residual posted to the equity account.
   *  Should be zero for a balanced trial balance.
   *  Non-zero means the TB was unbalanced — the equity account absorbs it. */
  residual: number;

  /** Number of account lines (excluding the equity contra line). */
  lineCount: number;
}

export function buildOpeningBalanceEntry(input: OpeningBalanceInput): OpeningBalanceResult {
  const { cutoverDate, balances, equityAccountCode } = input;
  const dateStr = cutoverDate.toISOString().split('T')[0];
  const label = input.label ?? `Opening Balance — Cutover ${dateStr}`;

  const items: JournalItemInput[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const { accountCode, balance } of balances) {
    if (balance === 0) continue;

    if (balance > 0) {
      // Debit-normal balance (assets)
      items.push({
        account: accountCode,
        debit: balance as Cents,
        credit: 0 as Cents,
        label: 'Opening balance',
      });
      totalDebit += balance;
    } else {
      // Credit-normal balance (liabilities, equity)
      const absBalance = Math.abs(balance);
      items.push({
        account: accountCode,
        debit: 0 as Cents,
        credit: absBalance as Cents,
        label: 'Opening balance',
      });
      totalCredit += absBalance;
    }
  }

  // The equity contra line absorbs the difference to make debits = credits.
  // For a balanced TB, this equals the sum of equity + liability credits
  // minus asset debits — which is exactly the retained earnings figure.
  const residual = totalDebit - totalCredit;
  const lineCount = items.length;

  if (residual > 0) {
    // More debits than credits → equity needs a credit to balance
    items.push({
      account: equityAccountCode,
      debit: 0 as Cents,
      credit: residual as Cents,
      label: 'Opening balance equity (contra)',
    });
  } else if (residual < 0) {
    // More credits than debits → equity needs a debit to balance
    items.push({
      account: equityAccountCode,
      debit: Math.abs(residual) as Cents,
      credit: 0 as Cents,
      label: 'Opening balance equity (contra)',
    });
  }
  // If residual === 0, the equity account was already included in balances
  // and the entry naturally balances. No extra line needed.

  const entry: JournalEntryInput = {
    date: cutoverDate,
    label,
    journalType: 'GENERAL',
    journalItems: items,
    extra: {
      _externalId: `opening-balance:${dateStr}`,
      _importSource: 'opening-balance',
    },
  };

  return { entry, residual, lineCount };
}
