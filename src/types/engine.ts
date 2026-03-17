/**
 * Engine Configuration Types
 *
 * Defines how the accounting engine is configured —
 * single-tenant vs multi-tenant, currency, country pack, etc.
 */

import type { CountryPack } from '../country/index.js';
import type { Logger } from '../utils/logger.js';

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
}

// ─── Engine Config ───────────────────────────────────────────────────────────

/** Main engine configuration */
export interface AccountingEngineConfig {
  /** Country pack providing account types, tax codes, and templates */
  country: CountryPack;
  /** Default ISO 4217 currency code (e.g., 'CAD', 'USD') */
  currency: string;
  /** Multi-tenant configuration. Omit for single-tenant apps. */
  multiTenant?: MultiTenantConfig;
  /** Fiscal year start month (1-12, default: 1 = January) */
  fiscalYearStartMonth?: number;
  /** Display code for prior retained earnings on balance sheet (default: '3660') */
  retainedEarningsCode?: string;
  /** Display code for current year net income on balance sheet (default: '3680') */
  currentYearEarningsCode?: string;
  /** Logger instance. Defaults to console-based logger. */
  logger?: Logger;
}
