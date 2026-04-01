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

import type { AccountType, CategoryKey } from '../types/core.js';

// ─── Tax Code ────────────────────────────────────────────────────────────────

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
  calculate(inputData: Record<string | number, number>, manualData?: Record<string | number, number>): Record<string | number, number>;
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

  const postingTypes = input.accountTypes.filter(at => !at.isTotal && !at.isGroup);

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
      return codes.map(c => input.taxCodes[c]).filter(Boolean) as TaxCode[];
    },

    flattenAccountTypes: () => input.accountTypes,
  };
}
