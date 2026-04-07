/**
 * Country Pack Interface
 *
 * A country pack provides everything country-specific:
 * account types (chart of accounts template), tax codes,
 * and optionally a tax report generator.
 *
 * Example:
 *   import { canadaPack } from '@classytic/ledger-ca';
 *   const engine = createAccountingEngine({ country: canadaPack, currency: 'CAD' });
 */

import type { AccountType } from '../types/core.js';

// ─── Tax Repartition (Odoo-style multi-account splits) ──────────────────────

/**
 * A single destination for a fraction of a tax amount. A `TaxCode` can declare
 * multiple repartition lines so that one tax percentage produces multiple
 * journal items (e.g. reverse-charge VAT books +100% to payable AND -100% to
 * recoverable in the same entry). Factors sum across lines and the engine
 * enforces balance inside the existing double-entry plugin.
 *
 * `accountRole` is a logical name looked up against the consumer's chart of
 * accounts via the country pack's `resolveRepartitionAccount` helper — NOT a
 * direct ObjectId, so the same country pack can drive any consumer's accounts.
 * `gridCode` flows through to `taxDetails` for regulatory reporting (CRA
 * schedule lines, HMRC VAT boxes, NBR Mushak grid, etc.).
 */
export interface TaxRepartitionLine {
  /**
   * Signed multiplier applied to the base tax amount. Use `1` for the
   * "normal" line, `-1` for a mirror (e.g. recoverable reverse-charge).
   * Fractions (e.g. `0.5`) are allowed for split-destination taxes.
   */
  readonly factor: number;
  /**
   * Logical role resolved against the country pack. Standard roles:
   *   - `'collected'` — tax collected from customer (liability)
   *   - `'recoverable'` — tax paid to supplier, recoverable (asset)
   *   - `'expense'` — tax paid, non-recoverable (expense)
   *   - `'transition'` — temporary holding account for cash-basis exigibility
   * Consumers can define custom roles and wire them in their country pack.
   */
  readonly accountRole: string;
  /** Optional reporting grid code — propagated to `taxDetails` on the item. */
  readonly gridCode?: string | number;
  /** Optional human label surfaced in UI and audit trails. */
  readonly label?: string;
  /** Optional: only apply on these document types. Default: all. */
  readonly documentTypes?: readonly ('invoice' | 'refund' | 'payment')[];
}

/**
 * When a tax is realized into the books:
 *   - `'accrual'` (default) — books at entry time (what 0.5.x did for everything)
 *   - `'cash'` — books into a transition account at entry time, moves to the
 *     real tax account when the invoice is reconciled against a payment
 */
export type TaxExigibility = 'accrual' | 'cash';

export interface TaxCode {
  readonly code: string;
  readonly name: string;
  readonly taxType: string;
  readonly rate: number;
  readonly direction: 'collected' | 'recoverable' | 'paid';
  readonly province?: string;
  readonly reportLines?: readonly number[];
  readonly description: string;
  readonly active: boolean;
  /**
   * Multi-line repartition — when present, `createRepartitionTaxGenerator`
   * produces one journal item per line. When absent, the tax behaves as a
   * single-line tax routed to the `direction`-implied account.
   */
  readonly repartition?: readonly TaxRepartitionLine[];
  /**
   * Accrual (default) or cash-basis exigibility. When `'cash'`, requires
   * a `transition` repartition role in `repartition` OR a country-pack
   * default transition account.
   */
  readonly exigibility?: TaxExigibility;
}

// ─── Journal Templates (Odoo-style first-class Journal resource) ────────────

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

export interface TaxCodesByRegion {
  readonly [region: string]: readonly string[];
}

// ─── Tax Report Generator ────────────────────────────────────────────────────

export interface TaxReportLine {
  readonly line: number | string;
  readonly name: string;
  readonly description: string;
  readonly type: 'input' | 'calculated' | 'manual';
  readonly calculate?: (data: Record<string | number, number>) => number;
  readonly section: string;
}

export interface TaxReportTemplate {
  readonly name: string;
  readonly lines: Readonly<Record<string | number, TaxReportLine>>;
  calculate(
    inputData: Record<string | number, number>,
    manualData?: Record<string | number, number>,
  ): Record<string | number, number>;
  summarize(calculated: Record<string | number, number>): Record<string, unknown>;
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
   * Includes both regular accounts and virtual tax sub-accounts.
   */
  readonly accountTypes: readonly AccountType[];

  /** Tax codes indexed by code string */
  readonly taxCodes: Readonly<Record<string, TaxCode>>;

  /** Tax codes grouped by region/province/state */
  readonly taxCodesByRegion: TaxCodesByRegion;

  /** Available regions (provinces/states) */
  readonly regions: readonly string[];

  /** Tax report template (e.g., CRA GST/HST return) */
  readonly taxReport?: TaxReportTemplate;

  /**
   * Optional journal templates seeded per organization. When a consumer
   * calls `engine.repositories.journals.seedDefaults(orgId)`, the engine
   * creates one Journal document per template. See `JournalTemplate`.
   */
  readonly journalTemplates?: readonly JournalTemplate[];

  /**
   * Map a logical `accountRole` string (e.g. `'collected'`, `'recoverable'`,
   * `'transition'`) to the actual account-type code for this country. The
   * repartition tax generator calls this for each repartition line so the
   * same tax definition can resolve different account codes in BD vs CA.
   *
   * Default behavior when omitted: maps `'collected'` → account with
   * direction='collected' in `taxCodes`, `'recoverable'` →
   * direction='recoverable', etc. Consumers override for custom roles.
   */
  readonly resolveTaxRepartitionAccountCode?: (
    role: string,
    taxCode: TaxCode,
  ) => string | undefined;

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

  /** Get tax codes for a specific region */
  getTaxCodesForRegion(region: string): TaxCode[];

  /** Flatten hierarchical accounts (if needed) */
  flattenAccountTypes(): readonly AccountType[];
}

// ─── Helper: Build a country pack from raw data ──────────────────────────────

export interface CountryPackInput {
  code: string;
  name: string;
  defaultCurrency: string;
  accountTypes: readonly AccountType[];
  taxCodes: Readonly<Record<string, TaxCode>>;
  taxCodesByRegion: TaxCodesByRegion;
  regions: readonly string[];
  taxReport?: TaxReportTemplate;
  journalTemplates?: readonly JournalTemplate[];
  resolveTaxRepartitionAccountCode?: (role: string, taxCode: TaxCode) => string | undefined;
  retainedEarningsAccountCode?: string;
  retainedEarningsDisplayCode?: string;
  currentYearEarningsCode?: string;
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

    getTaxCodesForRegion: (region: string) => {
      const codes = input.taxCodesByRegion[region] ?? [];
      return codes.map((c) => input.taxCodes[c]).filter(Boolean) as TaxCode[];
    },

    flattenAccountTypes: () => input.accountTypes,
  };
}
