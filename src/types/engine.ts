/**
 * Engine Configuration Types
 *
 * Defines how the accounting engine is configured —
 * single-tenant vs multi-tenant, currency, country pack, etc.
 */

import type { PaginationConfig, PluginType } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import type { TenantConfig } from '@classytic/primitives/tenant';
import type { Connection } from 'mongoose';
import type { LedgerBridges } from '../bridges/index.js';
import type { CountryPack } from '../country/index.js';
import type { OutboxStore } from '../events/outbox-store.js';
import type { Logger } from '../utils/logger.js';

// ─── Plugin & Pagination Wiring ──────────────────────────────────────────────

/** Mongokit plugins to install per repository (composes with engine built-ins). */
export interface LedgerRepositoryPlugins {
  account?: PluginType[] | undefined;
  journalEntry?: PluginType[] | undefined;
  fiscalPeriod?: PluginType[] | undefined;
  budget?: PluginType[] | undefined;
  reconciliation?: PluginType[] | undefined;
  journal?: PluginType[] | undefined;
}

/** Pagination caps per repository. Omit a key to use mongokit defaults. */
export interface LedgerPaginationConfig {
  account?: PaginationConfig | undefined;
  journalEntry?: PaginationConfig | undefined;
  fiscalPeriod?: PaginationConfig | undefined;
  budget?: PaginationConfig | undefined;
  reconciliation?: PaginationConfig | undefined;
  journal?: PaginationConfig | undefined;
}

// ─── Multi-Tenancy ───────────────────────────────────────────────────────────

/**
 * Multi-tenant configuration.
 *
 * Extends `@classytic/primitives/tenant` `TenantConfig` — field names match
 * across primitives, mongokit's `MultiTenantOptions`, and ledger so hosts
 * don't learn three shapes for the same idea. Ledger tightens the
 * primitives' optional `tenantField` and `ref` into required (ledger has
 * no sensible default — the host must name its organization collection).
 */
export interface MultiTenantConfig extends TenantConfig {
  /**
   * Field name for the organization reference (e.g., 'business',
   * 'organization', 'company'). Required — ledger has no default here.
   */
  tenantField: string;
  /**
   * Mongoose model name the tenant field references (e.g., 'Business',
   * 'Organization'). Required.
   */
  ref: string;
  /**
   * Enable mongokit's `multiTenantPlugin` on every ledger repository. The
   * plugin injects the tenant filter at POLICY priority (before cache/audit)
   * whenever `ctx.organizationId` is present on a call. When `false`
   * (default), only manual `tenantField` filters inside domain verbs enforce
   * scoping.
   *
   * Recommended: `true` for new hosts. Keep `false` if your app has not yet
   * migrated to context-based scoping.
   */
  plugin?: boolean | undefined;
  /**
   * Fail closed when `ctx.organizationId` is missing on a plugin-scoped call.
   * Only applies when `plugin: true`. Default: `false` (skip injection when
   * context is empty — matches historical ledger behavior).
   *
   * Note: this is *plugin-level* fail-closed; the schema-level required flag
   * on the tenant field is always `true` when multi-tenant is on.
   */
  required?: boolean | undefined;
}

// ─── Schema Options ──────────────────────────────────────────────────────────

/** Options passed to schema factory functions */
export interface SchemaOptions {
  /** Add recommended indexes (default: true) */
  indexes?: boolean | undefined;
  /** Extra Mongoose schema fields to merge in */
  extraFields?: Record<string, unknown> | undefined;
  /** Extra indexes to add */
  extraIndexes?:
    | Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> | undefined }>
    | undefined;
}

/** Journal entry schema-specific options */
export interface JournalSchemaOptions extends SchemaOptions {
  /** Auto-generate reference numbers (default: true) */
  autoReference?: boolean | undefined;
  /** Enable text search index on reference + label (default: true) */
  textSearch?: boolean | undefined;
  /** Extra Mongoose schema fields to merge into the JournalItem subdocument */
  extraItemFields?: Record<string, unknown> | undefined;
}

// ─── Audit Configuration ─────────────────────────────────────────────────────

/** Audit trail configuration */
export interface AuditConfig {
  /** Track actor (user) who performs each operation (post, reverse, approve) */
  trackActor?: boolean | undefined;
}

// ─── Strictness Configuration ────────────────────────────────────────────────

/** Strictness rules for the ledger */
export interface StrictnessConfig {
  /** If true, unpost() is disabled — correction only via reverse() (immutable ledger) */
  immutable?: boolean | undefined;
  /** If true, actorId is required on post/reverse/unpost operations */
  requireActor?: boolean | undefined;
  /** If true, entries must have approvedBy/approvedAt set before posting */
  requireApproval?: boolean | undefined;
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
  currencies?: readonly string[] | undefined;
}

// ─── Model Names ─────────────────────────────────────────────────────────────

/**
 * Override default model names. Useful when you want to avoid collisions
 * with existing models or use custom naming conventions.
 */
export interface ModelNames {
  account?: string | undefined; // default: 'Account'
  journalEntry?: string | undefined; // default: 'JournalEntry'
  fiscalPeriod?: string | undefined; // default: 'FiscalPeriod'
  budget?: string | undefined; // default: 'Budget'
  reconciliation?: string | undefined; // default: 'Reconciliation'
  journal?: string | undefined; // default: 'Journal'
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
  modelNames?: ModelNames | undefined;
  /** Extra fields / indexes per model */
  schemaOptions?:
    | {
        account?: SchemaOptions | undefined;
        journalEntry?: JournalSchemaOptions | undefined;
        fiscalPeriod?: SchemaOptions | undefined;
        budget?: SchemaOptions | undefined;
        reconciliation?: SchemaOptions | undefined;
        journal?: SchemaOptions | undefined;
      }
    | undefined;
  /** Country pack providing account types, tax codes, and templates */
  country: CountryPack;
  /** Default ISO 4217 currency code — the functional/base currency (e.g., 'CAD', 'BDT') */
  currency: string;
  /** Multi-tenant configuration. Omit for single-tenant apps. */
  multiTenant?: MultiTenantConfig | undefined;
  /** Multi-currency support. Omit for single-currency apps. */
  multiCurrency?: MultiCurrencyConfig | undefined;
  /** Fiscal year start month (1-12, default: 1 = January) */
  fiscalYearStartMonth?: number | undefined;
  /**
   * The retained earnings account code (e.g. '3600' CA, '3310' BD).
   * Overrides the country pack value. See CountryPack.retainedEarningsAccountCode.
   */
  retainedEarningsAccountCode?: string | undefined;
  /** Display code for the "Previous Years Retained Earnings" line. Overrides country pack. */
  retainedEarningsDisplayCode?: string | undefined;
  /** Display code for current year net income line. Overrides country pack. */
  currentYearEarningsCode?: string | undefined;
  /** Logger instance. Defaults to console-based logger. */
  logger?: Logger | undefined;
  /** Audit trail configuration */
  audit?: AuditConfig | undefined;
  /** Enable built-in idempotency key field on journal entries */
  idempotency?: boolean | undefined;
  /**
   * TTL in seconds for idempotency records — stale replay keys auto-expire
   * via a partial TTL index so they don't collide with legitimate reuse
   * after the window closes. Default: 86400 (24h). Matches Stripe / Saleor
   * convention. Only applies when `idempotency: true`.
   */
  idempotencyTtlSeconds?: number | undefined;
  /**
   * Automatically call `Model.syncIndexes()` on every managed model right
   * after the engine boots. Ensures new partial/TTL indexes (0.9.0+) are
   * present in MongoDB before the first write. Default: `false` — hosts
   * that run migrations themselves should leave this off.
   */
  syncIndexes?: boolean | undefined;
  /** Strictness rules for the ledger */
  strictness?: StrictnessConfig | undefined;
  /** Mongokit plugins to install per repository. */
  plugins?: LedgerRepositoryPlugins | undefined;
  /** Pagination caps per repository. */
  pagination?: LedgerPaginationConfig | undefined;
  /**
   * Mongoose type for the multi-tenant field on all ledger schemas.
   *
   * - `'string'` (default, back-compat): stores tenant IDs as strings.
   *   Accepts any external auth system (UUIDs, slugs, external identifiers).
   * - `'objectId'`: stores tenant IDs as native MongoDB ObjectId with a
   *   Mongoose ref to the organization collection. Enables `$lookup` and
   *   `.populate()` against Better Auth's `organization` collection.
   *
   * New hosts wiring Better Auth should pass `'objectId'`. See
   * PACKAGE_RULES §9.1 and §9.2.
   *
   * Note: this field is plumbed into `multiTenantPlugin` when
   * `multiTenant.plugin: true`. Schema-level type switching is applied
   * by the models factory when it supports dynamic type declaration.
   */
  tenantFieldType?: 'objectId' | 'string' | undefined;
  /**
   * Optional event transport — structurally identical to `@classytic/arc`'s
   * `EventTransport`. Drop in any arc transport (Memory, Redis, Kafka, BullMQ)
   * or provide a custom one. When omitted, the engine uses an in-process bus
   * (`InProcessLedgerBus`) that is NOT suitable for multi-instance deployments.
   */
  eventTransport?: EventTransport | undefined;
  /**
   * Optional host-owned outbox store — structurally identical to
   * `@classytic/arc`'s `OutboxStore`. When provided, domain events are
   * persisted via `outbox.save(event, { session })` inside the same
   * mongoose session as the ledger write, giving at-least-once delivery
   * guarantees. A host-side relay worker calls `store.claimPending` +
   * `transport.publish` + `store.acknowledge` independently.
   *
   * Package-owned durable outbox storage is an anti-pattern per
   * PACKAGE_RULES §5.5. Ledger does NOT ship a concrete store — the
   * host picks `MongoOutboxStore` (arc), a SQL store, a Redis store,
   * etc. See `src/events/outbox-store.ts` for the interface contract.
   */
  outboxStore?: OutboxStore | undefined;
  /**
   * Host-provided bridges for external integrations (source resolution,
   * notifications). All bridges and all methods are optional — features
   * degrade gracefully when a bridge is missing.
   */
  bridges?: LedgerBridges | undefined;
}
