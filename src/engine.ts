/**
 * AccountingEngine — The main entry point for @classytic/ledger.
 *
 * The engine owns all models, repositories, and reports. Matches the
 * @classytic/flow and @classytic/promo pattern: pass a mongoose connection
 * in config, and everything is auto-wired.
 *
 * @example
 * ```typescript
 * import mongoose from 'mongoose';
 * import { createAccountingEngine } from '@classytic/ledger';
 * import { canadaPack } from '@classytic/ledger-ca';
 *
 * const engine = createAccountingEngine({
 *   mongoose: mongoose.connection,
 *   country: canadaPack,
 *   currency: 'CAD',
 *   multiTenant: { tenantField: 'organizationId', ref: 'Organization' },
 * });
 *
 * // Models — auto-created Mongoose models
 * engine.models.Account
 * engine.models.JournalEntry
 *
 * // Repositories — plugins + domain methods pre-wired
 * await engine.repositories.accounts.seedAccounts(orgId);
 * await engine.repositories.journalEntries.post(entryId, orgId);
 *
 * // Reports — bound to owned models
 * const bs = await engine.reports.balanceSheet({ organizationId: orgId, dateOption: 'year', dateValue: 2025 });
 * ```
 */

import { QueryParser, type QueryParserOptions } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import { isValidTimeZone } from '@classytic/primitives/timezone';
import type { Model } from 'mongoose';
import { runLedgerAssurance } from './assurance/run.js';
import type {
  AssuranceReport,
  LedgerAssuranceOptions,
  LedgerAssuranceParams,
} from './assurance/types.js';
import type { LedgerBridges } from './bridges/index.js';
import type { CountryPack } from './country/index.js';
import { InProcessLedgerBus } from './events/in-process-bus.js';
import type { OutboxStore } from './events/outbox-store.js';
import { createModels, type LedgerModels } from './models/factory.js';
import { Money } from './money.js';
import { generateAgedBalance } from './reports/aged-balance.js';
import { generateBalanceSheet } from './reports/balance-sheet.js';
import { generateBudgetVsActual } from './reports/budget-vs-actual.js';
import { generateCashFlow } from './reports/cash-flow.js';
import { type DaybookParams, generateDaybook } from './reports/daybook.js';
import { generateDimensionBreakdown } from './reports/dimension-breakdown.js';
import { generateGeneralLedger } from './reports/general-ledger.js';
import { generateIncomeStatement } from './reports/income-statement.js';
import { generateRevaluation } from './reports/revaluation.js';
import { generateTrialBalance } from './reports/trial-balance.js';
import { createRepositories, type LedgerRepositories } from './repositories/factory.js';
import { buildIntrospectAPI, type IntrospectAPI } from './semantic/introspect.js';
import { buildRecordAPI, type RecordAPI } from './semantic/record.js';
import type { AccountingEngineConfig } from './types/engine.js';

export class AccountingEngine {
  readonly config: AccountingEngineConfig;
  readonly country: CountryPack;
  readonly currency: string;
  readonly money = Money;
  readonly models: LedgerModels;
  readonly repositories: LedgerRepositories;
  readonly record: RecordAPI;
  readonly introspect: IntrospectAPI;
  /**
   * Event transport — structurally matches `@classytic/arc`'s `EventTransport`.
   * When the host does not inject one, the engine instantiates
   * `InProcessLedgerBus` (suitable for single-instance deployments only).
   * Subscribe with glob patterns: `ledger:entry.*`, `ledger:reconciliation.*`, `*`.
   */
  readonly events: EventTransport;
  /**
   * Host-provided bridges. Empty object when none supplied. Callers should
   * optional-chain every method (`engine.bridges.source?.resolve?.(...)`).
   */
  readonly bridges: LedgerBridges;
  /**
   * Host-provided outbox store for durable event delivery (0.9.0). When
   * present, every domain event is persisted to the outbox in the same
   * mongoose session as the ledger write before the transport publish.
   * Undefined when the host opts out of durable delivery.
   */
  readonly outboxStore: OutboxStore | undefined;

  private _reports?: ReturnType<AccountingEngine['_buildReports']>;
  private _assurance?: { run: (params?: LedgerAssuranceParams) => Promise<AssuranceReport> };

  constructor(config: AccountingEngineConfig) {
    if (!config.mongoose) {
      throw new Error(
        'createAccountingEngine: `mongoose` connection is required. ' +
          'Pass `mongoose: mongoose.connection` in config.',
      );
    }

    if (config.timezone !== undefined && !isValidTimeZone(config.timezone)) {
      throw new Error(
        `createAccountingEngine: invalid IANA timezone '${config.timezone}'. ` +
          'Reporting periods and reference numbers derive their civil boundaries ' +
          'from this zone; fix the config or omit it to default to UTC.',
      );
    }

    this.config = config;
    this.country = config.country;
    this.currency = config.currency;

    // Event transport + bridges + outbox — structurally arc-compatible.
    this.events = config.eventTransport ?? new InProcessLedgerBus();
    this.bridges = config.bridges ?? {};
    this.outboxStore = config.outboxStore;

    // Eagerly build models + repositories (flow/promo pattern)
    this.models = createModels(config.mongoose, config);
    this.repositories = createRepositories(
      this.models,
      config,
      config.plugins ?? {},
      config.pagination ?? {},
      {
        events: this.events,
        bridges: this.bridges,
        outboxStore: this.outboxStore,
      },
    );

    // 0.14.0: capability gate — fail boot loudly when the wired repository
    // backend can't satisfy the ledger's contract (flow/order/catalog
    // pattern), instead of a cryptic error on the first posting call.
    assertLedgerCapabilities(this.repositories.journalEntries, {
      outboxConfigured: this.outboxStore !== undefined,
    });

    // 0.9.0: optional auto-sync of indexes so new partial/TTL indexes are
    // present before the first write. Hosts running their own migration
    // pipeline should leave this off.
    if (config.syncIndexes) {
      // Fire-and-forget — errors surface on the first index-dependent query.
      void Promise.all([
        this.models.Account.syncIndexes().catch(() => undefined),
        this.models.JournalEntry.syncIndexes().catch(() => undefined),
        this.models.FiscalPeriod.syncIndexes().catch(() => undefined),
        this.models.Budget.syncIndexes().catch(() => undefined),
        this.models.Reconciliation.syncIndexes().catch(() => undefined),
        this.models.Journal.syncIndexes().catch(() => undefined),
      ]);
    }

    // Semantic APIs — primitives for AI agents and MCP tools
    this.record = buildRecordAPI({
      models: this.models,
      repositories: this.repositories,
      config: this.config,
    });
    this.introspect = buildIntrospectAPI({
      models: this.models,
      country: this.country,
      config: this.config,
    });
  }

  /**
   * Explicitly sync indexes on all managed models.
   * Call this in deploy-time scripts — NOT on every boot.
   * See PACKAGE_RULES section 32.
   */
  async syncIndexes(): Promise<void> {
    await Promise.all([
      this.models.Account.syncIndexes(),
      this.models.JournalEntry.syncIndexes(),
      this.models.FiscalPeriod.syncIndexes(),
      this.models.Budget.syncIndexes(),
      this.models.Reconciliation.syncIndexes(),
      this.models.Journal.syncIndexes(),
    ]);
  }

  /**
   * Pre-built reports bound to the engine's owned models.
   * Lazy-initialized on first access.
   */
  get reports() {
    if (!this._reports) {
      this._reports = this._buildReports();
    }
    return this._reports;
  }

  /**
   * Continuous integrity checks over the posted book, bound to the engine's
   * owned models: per-entry balance, denormalized-totals drift, trial-balance
   * conservation, orphan accounts, idempotency duplicates, control-account
   * tie-outs, stale drafts. Read-only aggregations — assurance never mutates
   * the book. See `@classytic/ledger/assurance`.
   */
  get assurance() {
    if (!this._assurance) {
      const opts: LedgerAssuranceOptions = {
        JournalEntryModel: this.models.JournalEntry as Model<unknown>,
        AccountModel: this.models.Account as Model<unknown>,
        orgField: this.config.multiTenant?.tenantField,
      };
      this._assurance = {
        run: (params?: LedgerAssuranceParams) => runLedgerAssurance(opts, params),
      };
    }
    return this._assurance;
  }

  // ── Account Type Helpers (delegate to country pack) ────────────────────────

  /** Get all posting account types (accounts you can post transactions to) */
  getPostingAccountTypes() {
    return this.country.getPostingAccountTypes();
  }

  /** Validate an account type code */
  isValidAccountType(code: string) {
    return this.country.isValidAccountType(code);
  }

  /** Get account type definition by code */
  getAccountType(code: string) {
    return this.country.getAccountType(code);
  }

  // ── Query Parser Factory ────────────────────────────────────────────────────

  /**
   * Create a pre-configured QueryParser for URL-driven queries against
   * ledger repositories. Returns a mongokit QueryParser with the correct
   * schema and pagination limits for the specified model.
   *
   * @param model - Which ledger model to parse queries for
   * @param overrides - Additional QueryParserOptions to merge
   *
   * @example
   * ```typescript
   * const parser = engine.createQueryParser('journalEntry');
   * const parsed = parser.parse(req.query);
   * const result = await engine.repositories.journalEntries.getAll({
   *   ...parsed,
   *   filters: { ...parsed.filters, organizationId },
   * });
   * ```
   */
  createQueryParser(
    model: 'account' | 'journalEntry' | 'fiscalPeriod' | 'budget' | 'reconciliation' | 'journal',
    overrides?: Partial<QueryParserOptions>,
  ): QueryParser {
    const paginationConfig = this.config.pagination ?? {};

    const modelMap: Record<
      string,
      { model: Model<unknown>; pagination?: { maxLimit?: number | undefined } | undefined }
    > = {
      account: {
        model: this.models.Account as Model<unknown>,
        pagination: paginationConfig.account,
      },
      journalEntry: {
        model: this.models.JournalEntry as Model<unknown>,
        pagination: paginationConfig.journalEntry,
      },
      fiscalPeriod: {
        model: this.models.FiscalPeriod as Model<unknown>,
        pagination: paginationConfig.fiscalPeriod,
      },
      budget: {
        model: this.models.Budget as Model<unknown>,
        pagination: paginationConfig.budget,
      },
      reconciliation: {
        model: this.models.Reconciliation as Model<unknown>,
        pagination: paginationConfig.reconciliation,
      },
      journal: {
        model: this.models.Journal as Model<unknown>,
        pagination: paginationConfig.journal,
      },
    };

    const entry = modelMap[model];
    if (!entry) {
      throw new Error(`createQueryParser: unknown model "${model}"`);
    }

    return new QueryParser({
      schema: entry.model.schema,
      maxLimit: entry.pagination?.maxLimit ?? 100,
      searchMode: 'regex',
      ...overrides,
    });
  }

  // ── Reports Builder (uses owned models) ────────────────────────────────────

  private _buildReports() {
    const AccountModel = this.models.Account as Model<unknown>;
    const JournalEntryModel = this.models.JournalEntry as Model<unknown>;
    const BudgetModel = this.models.Budget as Model<unknown>;
    const { country, config } = this;
    const orgField = config.multiTenant?.tenantField;
    const fiscalYearStartMonth = config.fiscalYearStartMonth ?? 1;
    const timezone = config.timezone ?? 'UTC';
    const retainedEarningsAccountCode = config.retainedEarningsAccountCode;
    const retainedEarningsDisplayCode = config.retainedEarningsDisplayCode;
    const currentYearEarningsCode = config.currentYearEarningsCode;

    return {
      trialBalance: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountId?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateTrialBalance(
          { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth, timezone },
          params,
        ),

      balanceSheet: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateBalanceSheet(
          {
            AccountModel,
            JournalEntryModel,
            country,
            orgField,
            fiscalYearStartMonth,
            retainedEarningsAccountCode,
            retainedEarningsDisplayCode,
            currentYearEarningsCode,
            timezone,
          },
          params,
        ),

      incomeStatement: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateIncomeStatement(
          { AccountModel, JournalEntryModel, country, orgField, timezone },
          params,
        ),

      generalLedger: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountId?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateGeneralLedger(
          { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth, timezone },
          params,
        ),

      cashFlow: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateCashFlow({ AccountModel, JournalEntryModel, country, orgField, timezone }, params),

      daybook: (params: DaybookParams) => generateDaybook({ JournalEntryModel, orgField }, params),

      agedBalance: (params: {
        organizationId?: unknown;
        asOfDate?: Date;
        type: 'receivable' | 'payable';
        accountIds?: unknown[];
        dueDateField?: string;
        contactField?: string;
        buckets?: Array<{ label: string; minDays: number; maxDays: number }>;
      }) => generateAgedBalance({ AccountModel, JournalEntryModel, country, orgField }, params),

      dimensionBreakdown: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        dimension: string;
        accountCategory?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateDimensionBreakdown(
          { AccountModel, JournalEntryModel, country, orgField, timezone },
          params,
        ),

      budgetVsActual: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountIds?: unknown[];
        filters?: Record<string, unknown>;
      }) =>
        generateBudgetVsActual(
          { AccountModel, JournalEntryModel, BudgetModel, country, orgField, timezone },
          params,
        ),

      revaluation: (params: {
        organizationId?: unknown;
        asOfDate: Date;
        rates: Array<{ currency: string; rate: number }>;
        unrealizedGainLossAccountId: unknown;
        generateEntry?: boolean;
      }) =>
        generateRevaluation(
          { AccountModel, JournalEntryModel, country, orgField, baseCurrency: this.currency },
          params,
        ),
    };
  }
}

// ── Capability gate (0.14.0) ────────────────────────────────────────────────

/**
 * Capability flags the ledger requires from the wired repository backend
 * (`RepoCapabilities`, declared by mongokit >= 3.16 / repo-core >= 0.6).
 *
 * Always required:
 *   - `upsert` — atomic reference-number counters ride
 *     findOneAndUpdate-with-upsert.
 *   - `duplicateKeyError` — race-safe idempotent create depends on typed
 *     11000 classification to re-read the winner instead of throwing raw.
 *
 * Required when an `outboxStore` is configured:
 *   - `transactions` — the durable-event contract is "outbox row commits
 *     atomically with the ledger write"; without multi-document
 *     transactions that guarantee is unenforceable, so the engine refuses
 *     to pretend. (Without an outbox, posting still works on standalone
 *     MongoDB via the ledger's non-transactional fallback paths.)
 */
const REQUIRED_CAPABILITIES = ['upsert', 'duplicateKeyError'] as const;

/**
 * Fail-fast check that the journal-entry repository's backend declares the
 * capabilities the ledger's write paths depend on. Runs automatically in
 * the engine constructor; exported for hosts wiring custom repositories.
 */
export function assertLedgerCapabilities(
  repository: unknown,
  options: { outboxConfigured?: boolean } = {},
): void {
  const repo = repository as { capabilities?: Record<string, boolean | undefined> };
  const caps = repo.capabilities;
  if (!caps) {
    throw new Error(
      'ledger: the wired repository backend declares no `capabilities` descriptor ' +
        '(RepoCapabilities, required since @classytic/repo-core 0.6 / mongokit 3.16). ' +
        'Upgrade the kit or declare capabilities on the custom repository.',
    );
  }

  const required: string[] = [...REQUIRED_CAPABILITIES];
  if (options.outboxConfigured) required.push('transactions');

  const missing = required.filter((flag) => caps[flag] !== true);
  if (missing.length > 0) {
    const outboxNote = options.outboxConfigured
      ? ' An outboxStore is configured, so multi-document transactions are mandatory — ' +
        'MongoDB must run as a replica set (or mongos); remove the outbox or fix the deployment.'
      : '';
    throw new Error(
      `ledger: the wired repository backend does not support required capabilities: ` +
        `${missing.join(', ')}.${outboxNote} See repo.capabilities (RepoCapabilities from @classytic/repo-core).`,
    );
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createAccountingEngine(config: AccountingEngineConfig): AccountingEngine {
  return new AccountingEngine(config);
}
