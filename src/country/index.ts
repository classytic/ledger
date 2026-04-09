/**
 * Country Pack Interface (0.7.0)
 *
 * A country pack ships the **chart of accounts** and accounting conventions
 * for a jurisdiction. It intentionally does NOT own tax codes, tax rate
 * tables, tax return templates, or any tax calculation logic — those
 * belong in separate, jurisdiction-specific tax engines (e.g.
 * `@classytic/bd-tax`, `@classytic/ca-tax`) that the consumer wires in
 * independently when they need tax functionality.
 *
 * This mirrors how Odoo (`account/` vs `l10n_*`), QuickBooks (Ledger vs
 * TaxService), and Xero (accounting vs Xero Tax) separate the two
 * concerns. A pure accounting consumer never needs to know tax exists.
 *
 * @example
 * ```typescript
 * import { createAccountingEngine } from '@classytic/ledger';
 * import { canadaPack } from '@classytic/ledger-ca';
 *
 * const engine = createAccountingEngine({
 *   mongoose,
 *   country: canadaPack,
 *   currency: 'CAD',
 * });
 *
 * // If you ALSO need Canadian tax (GST/HST/PST, CRA forms, etc.):
 * // import { canadaTax, wireTax } from '@classytic/ca-tax';
 * // wireTax(engine, canadaTax);
 * ```
 */

import type { AccountType } from '../types/core.js';

// ─── Journal Templates (first-class Journal resource) ──────────────────────

/**
 * Declarative template that tells the engine which journals to seed for a
 * new organization. Consumers call
 * `engine.repositories.journals.seedDefaults(orgId)` which reads these from
 * the country pack and creates one Journal document per template.
 *
 * Journals are *optional* — if a consumer never seeds journals, the legacy
 * `journalType` enum on a journal entry still works. Consumers opting in
 * get per-journal sequence prefixes, restricted payment methods, bank
 * statement sources, etc.
 */
export interface JournalTemplate {
  /** Short stable identifier — e.g. `'SALES'`, `'PURCHASE'`, `'BANK'`. */
  readonly code: string;
  /** Display name. */
  readonly name: string;
  /**
   * One of the registered `JOURNAL_TYPES` codes — connects this journal to
   * the engine's reference-number generator and posting-contract system.
   */
  readonly journalType: string;
  /** Reference-number prefix — defaults to `code` when omitted. */
  readonly sequencePrefix?: string;
  /** First sequence number — defaults to `1`. */
  readonly sequenceStartNum?: number;
  /**
   * Logical source — pure ledgering (`'general'`), sale-side docs (`'sale'`),
   * purchase-side docs (`'purchase'`), cash/bank movement (`'bank'`, `'cash'`).
   * Drives default locks (sale-lock, purchase-lock) when they're wired.
   */
  readonly kind?: 'general' | 'sale' | 'purchase' | 'bank' | 'cash' | string;
  /** Optional default debit/credit account roles for quick data entry. */
  readonly defaultDebitAccountRole?: string;
  readonly defaultCreditAccountRole?: string;
}

// ─── Country Pack ────────────────────────────────────────────────────────────

export interface CountryPack {
  /** ISO 3166-1 alpha-2 code (e.g., 'CA', 'US', 'GB') */
  readonly code: string;
  /** Country name */
  readonly name: string;
  /** Default currency code */
  readonly defaultCurrency: string;

  /**
   * Full chart of accounts template — flat array of account type definitions.
   * Includes both posting accounts and grouping / total rows.
   */
  readonly accountTypes: readonly AccountType[];

  /**
   * Optional journal templates seeded per organization. When a consumer
   * calls `engine.repositories.journals.seedDefaults(orgId)`, the engine
   * creates one Journal document per template. See `JournalTemplate`.
   */
  readonly journalTemplates?: readonly JournalTemplate[];

  // ── Country-specific report defaults ──

  /**
   * The retained earnings account code — the account that holds accumulated
   * retained earnings (e.g. '3600' CA, '3310' BD).
   *
   * On the balance sheet, this account is excluded from normal equity grouping
   * and its balance is folded into the computed "Retained Earnings" section
   * (opening RE = RE account balance + prior-year unclosed P&L).
   *
   * Inspired by Odoo's `equity_unaffected` account type.
   */
  readonly retainedEarningsAccountCode?: string;
  /**
   * Display code for the "Previous Years Retained Earnings" line on the
   * balance sheet (e.g. '3660' for CA GIFI). Defaults to retainedEarningsAccountCode.
   */
  readonly retainedEarningsDisplayCode?: string;
  /** Display code for current year net income line (e.g. '3680' CA, '3311' BD) */
  readonly currentYearEarningsCode?: string;
  /**
   * Account code used as the equity contra for opening balance entries.
   * Defaults to `retainedEarningsAccountCode` when not set.
   *
   * Following Odoo convention, this is typically the retained earnings
   * account itself (not a temporary "Opening Balance Equity" account).
   * Country packs that prefer a separate temporary account (like ERPNext)
   * can override this.
   */
  readonly openingBalanceEquityCode?: string;
  /** Group label code used to identify Cost of Sales in the income statement */
  readonly cogsGroupCode?: string;
  /** Override default English report section names */
  readonly reportLabels?: {
    readonly assets?: string;
    readonly liabilities?: string;
    readonly equity?: string;
    readonly revenue?: string;
    readonly expenses?: string;
  };

  // ── Helpers ──

  /** Get all account types that can be posted to (not groups, not totals) */
  getPostingAccountTypes(): readonly AccountType[];

  /** Get account type by code */
  getAccountType(code: string): AccountType | undefined;

  /** Validate an account type code exists */
  isValidAccountType(code: string): boolean;

  /** Check if an account type can receive postings */
  isPostingAccount(code: string): boolean;

  /** Flatten hierarchical accounts (if needed) */
  flattenAccountTypes(): readonly AccountType[];
}

// ─── Helper: Build a country pack from raw data ──────────────────────────────

export interface CountryPackInput {
  code: string;
  name: string;
  defaultCurrency: string;
  accountTypes: readonly AccountType[];
  journalTemplates?: readonly JournalTemplate[];
  retainedEarningsAccountCode?: string;
  retainedEarningsDisplayCode?: string;
  currentYearEarningsCode?: string;
  openingBalanceEquityCode?: string;
  cogsGroupCode?: string;
  reportLabels?: {
    readonly assets?: string;
    readonly liabilities?: string;
    readonly equity?: string;
    readonly revenue?: string;
    readonly expenses?: string;
  };
}

/**
 * Factory to create a CountryPack with auto-generated helper methods.
 */
export function defineCountryPack(input: CountryPackInput): CountryPack {
  // Build lookup map once
  const accountMap = new Map<string, AccountType>();
  for (const at of input.accountTypes) {
    accountMap.set(at.code, at);
  }

  const postingTypes = input.accountTypes.filter((at) => !at.isTotal && !at.isGroup);

  return {
    ...input,

    getPostingAccountTypes: () => postingTypes,

    getAccountType: (code: string) => accountMap.get(code),

    isValidAccountType: (code: string) => accountMap.has(code),

    isPostingAccount: (code: string) => {
      const at = accountMap.get(code);
      return at !== undefined && !at.isTotal && !at.isGroup;
    },

    flattenAccountTypes: () => input.accountTypes,
  };
}
