/**
 * Engine Configuration Types
 *
 * Defines how the accounting engine is configured —
 * single-tenant vs multi-tenant, currency, country pack, etc.
 */

import type { PaginationConfig, PluginType } from '@classytic/mongokit';
import type { Connection } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type { Logger } from '../utils/logger.js';

// ─── Plugin & Pagination Wiring ──────────────────────────────────────────────

/** Mongokit plugins to install per repository (composes with engine built-ins). */
export interface LedgerRepositoryPlugins {
  account?: PluginType[];
  journalEntry?: PluginType[];
  fiscalPeriod?: PluginType[];
  budget?: PluginType[];
  reconciliation?: PluginType[];
}

/** Pagination caps per repository. Omit a key to use mongokit defaults. */
export interface LedgerPaginationConfig {
  account?: PaginationConfig;
  journalEntry?: PaginationConfig;
  fiscalPeriod?: PaginationConfig;
  budget?: PaginationConfig;
  reconciliation?: PaginationConfig;
}

// ─── Multi-Tenancy ───────────────────────────────────────────────────────────

/** Multi-tenant configuration */
export interface MultiTenantConfig {
  /** Field name for the organization reference (e.g., 'business', 'organization', 'company') */
  orgField: string;
  /** Mongoose model name the org field references (e.g., 'Business', 'Organization') */
  orgRef: string;
}

// ─── Schema Options ──────────────────────────────────────────────────────────

/** Options passed to schema factory functions */
export interface SchemaOptions {
  /** Add recommended indexes (default: true) */
  indexes?: boolean;
  /** Extra Mongoose schema fields to merge in */
  extraFields?: Record<string, unknown>;
  /** Extra indexes to add */
  extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }>;
}

/** Journal entry schema-specific options */
export interface JournalSchemaOptions extends SchemaOptions {
  /** Auto-generate reference numbers (default: true) */
  autoReference?: boolean;
  /** Enable text search index on reference + label (default: true) */
  textSearch?: boolean;
  /** Extra Mongoose schema fields to merge into the JournalItem subdocument */
  extraItemFields?: Record<string, unknown>;
}

// ─── Audit Configuration ─────────────────────────────────────────────────────

/** Audit trail configuration */
export interface AuditConfig {
  /** Track actor (user) who performs each operation (post, reverse, approve) */
  trackActor?: boolean;
}

// ─── Strictness Configuration ────────────────────────────────────────────────

/** Strictness rules for the ledger */
export interface StrictnessConfig {
  /** If true, unpost() is disabled — correction only via reverse() (immutable ledger) */
  immutable?: boolean;
  /** If true, actorId is required on post/reverse/unpost operations */
  requireActor?: boolean;
  /** If true, entries must have approvedBy/approvedAt set before posting */
  requireApproval?: boolean;
}

// ─── Multi-Currency ──────────────────────────────────────────────────────────

/**
 * Multi-currency configuration.
 * When enabled, adds currency and exchange rate fields to journal items
 * and a currency field to accounts. Allows recording transactions in
 * foreign currencies while maintaining a base (functional) currency.
 *
 * @example
 * ```typescript
 * const engine = createAccountingEngine({
 *   country: canadaPack,
 *   currency: 'CAD',          // base/functional currency
 *   multiCurrency: {
 *     enabled: true,
 *     currencies: ['USD', 'GBP', 'BDT'],  // allowed foreign currencies
 *   },
 * });
 * ```
 */
export interface MultiCurrencyConfig {
  /** Enable multi-currency fields on schemas */
  enabled: boolean;
  /** Allowed foreign currency codes. If omitted, any ISO 4217 code is accepted. */
  currencies?: readonly string[];
}

// ─── Model Names ─────────────────────────────────────────────────────────────

/**
 * Override default model names. Useful when you want to avoid collisions
 * with existing models or use custom naming conventions.
 */
export interface ModelNames {
  account?: string; // default: 'Account'
  journalEntry?: string; // default: 'JournalEntry'
  fiscalPeriod?: string; // default: 'FiscalPeriod'
  budget?: string; // default: 'Budget'
  reconciliation?: string; // default: 'Reconciliation'
}

// ─── Engine Config ───────────────────────────────────────────────────────────

/** Main engine configuration */
export interface AccountingEngineConfig {
  /**
   * Mongoose connection. **Required** — the engine owns all models and
   * creates them on this connection.
   */
  mongoose: Connection;
  /** Override default model names (e.g. 'Account' → 'GLAccount') */
  modelNames?: ModelNames;
  /** Extra fields / indexes per model */
  schemaOptions?: {
    account?: SchemaOptions;
    journalEntry?: JournalSchemaOptions;
    fiscalPeriod?: SchemaOptions;
    budget?: SchemaOptions;
    reconciliation?: SchemaOptions;
  };
  /** Country pack providing account types, tax codes, and templates */
  country: CountryPack;
  /** Default ISO 4217 currency code — the functional/base currency (e.g., 'CAD', 'BDT') */
  currency: string;
  /** Multi-tenant configuration. Omit for single-tenant apps. */
  multiTenant?: MultiTenantConfig;
  /** Multi-currency support. Omit for single-currency apps. */
  multiCurrency?: MultiCurrencyConfig;
  /** Fiscal year start month (1-12, default: 1 = January) */
  fiscalYearStartMonth?: number;
  /**
   * The retained earnings account code (e.g. '3600' CA, '3310' BD).
   * Overrides the country pack value. See CountryPack.retainedEarningsAccountCode.
   */
  retainedEarningsAccountCode?: string;
  /** Display code for the "Previous Years Retained Earnings" line. Overrides country pack. */
  retainedEarningsDisplayCode?: string;
  /** Display code for current year net income line. Overrides country pack. */
  currentYearEarningsCode?: string;
  /** Logger instance. Defaults to console-based logger. */
  logger?: Logger;
  /** Audit trail configuration */
  audit?: AuditConfig;
  /** Enable built-in idempotency key field on journal entries */
  idempotency?: boolean;
  /** Strictness rules for the ledger */
  strictness?: StrictnessConfig;
  /** Mongokit plugins to install per repository. */
  plugins?: LedgerRepositoryPlugins;
  /** Pagination caps per repository. */
  pagination?: LedgerPaginationConfig;
}
