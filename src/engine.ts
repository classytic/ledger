/**
 * AccountingEngine — The main entry point for @classytic/ledger.
 *
 * **Recommended usage (engine owns models):**
 * ```typescript
 * import mongoose from 'mongoose';
 * import { createAccountingEngine } from '@classytic/ledger';
 * import { canadaPack } from '@classytic/ledger-ca';
 *
 * const engine = createAccountingEngine({
 *   mongoose: mongoose.connection,
 *   country: canadaPack,
 *   currency: 'CAD',
 *   multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
 * });
 *
 * // Models and repositories are auto-created — no manual wiring
 * const account = await engine.repositories.accounts.seedAccounts(orgId);
 * const entry = await engine.repositories.journalEntries.post(entryId, orgId);
 * const bs = await engine.reports.balanceSheet({ dateOption: 'year', dateValue: 2025, organizationId: orgId });
 * ```
 *
 * **Low-level usage (manual schema/model setup):**
 * If you need custom model names or don't want the engine to own models,
 * omit `mongoose` from config and use `engine.createAccountSchema()` etc.
 */

import type { PluginType, Repository } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { CountryPack } from './country/index.js';
import { createModels, type LedgerModels } from './models/factory.js';
import { Money } from './money.js';
import { doubleEntryPlugin } from './plugins/double-entry.plugin.js';
import { fiscalLockPlugin } from './plugins/fiscal-lock.plugin.js';
import { idempotencyPlugin } from './plugins/idempotency.plugin.js';
import { generateAgedBalance } from './reports/aged-balance.js';
import { generateBalanceSheet } from './reports/balance-sheet.js';
import { generateBudgetVsActual } from './reports/budget-vs-actual.js';
import { generateCashFlow } from './reports/cash-flow.js';
import { generateDimensionBreakdown } from './reports/dimension-breakdown.js';
import { generateGeneralLedger } from './reports/general-ledger.js';
import { generateIncomeStatement } from './reports/income-statement.js';
import { generateRevaluation } from './reports/revaluation.js';
import { generateTrialBalance } from './reports/trial-balance.js';
import { wireAccountMethods } from './repositories/account.repository.js';
import {
  createRepositories,
  type LedgerPaginationConfig,
  type LedgerRepositories,
  type LedgerRepositoryPlugins,
} from './repositories/factory.js';
import { wireJournalEntryMethods } from './repositories/journal-entry.repository.js';
import { wireReconciliationMethods } from './repositories/reconciliation.repository.js';
import { createAccountSchema } from './schemas/account.schema.js';
import { createBudgetSchema } from './schemas/budget.schema.js';
import { createFiscalPeriodSchema } from './schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from './schemas/journal-entry.schema.js';
import { createReconciliationSchema } from './schemas/reconciliation.schema.js';
import type {
  AccountingEngineConfig,
  JournalSchemaOptions,
  SchemaOptions,
} from './types/engine.js';
import type {
  AccountRepository,
  JournalEntryRepository,
  ReconciliationRepository,
} from './types/repositories.js';

export class AccountingEngine {
  readonly config: AccountingEngineConfig;
  readonly country: CountryPack;
  readonly currency: string;
  readonly money = Money;

  private _models?: LedgerModels;
  private _repositories?: LedgerRepositories;
  private _reports?: ReturnType<AccountingEngine['_buildReports']>;

  constructor(
    config: AccountingEngineConfig,
    plugins: LedgerRepositoryPlugins = {},
    pagination: LedgerPaginationConfig = {},
  ) {
    this.config = config;
    this.country = config.country;
    this.currency = config.currency;

    // Eagerly build models + repositories if mongoose connection is provided.
    // Matches the flow/promo pattern: engine owns models, consumers use them.
    if (config.mongoose) {
      this._models = createModels(config.mongoose, config);
      this._repositories = createRepositories(this._models, config, plugins, pagination);
    }
  }

  /**
   * Auto-created Mongoose models. Requires `mongoose` in config.
   *
   * @throws if `mongoose` was not provided in config
   */
  get models(): LedgerModels {
    if (!this._models) {
      throw new Error(
        'engine.models requires a Mongoose connection. ' +
          'Pass `mongoose: connection` in createAccountingEngine config.',
      );
    }
    return this._models;
  }

  /**
   * Auto-wired repositories with plugins + domain methods (post, reverse, etc.).
   * Requires `mongoose` in config.
   *
   * @throws if `mongoose` was not provided in config
   */
  get repositories(): LedgerRepositories {
    if (!this._repositories) {
      throw new Error(
        'engine.repositories requires a Mongoose connection. ' +
          'Pass `mongoose: connection` in createAccountingEngine config.',
      );
    }
    return this._repositories;
  }

  /**
   * Pre-built reports bound to auto-created models. Requires `mongoose` in config.
   * For custom models, use `engine.createReports({ Account, JournalEntry, Budget })`.
   */
  get reports() {
    if (!this._reports) {
      if (!this._models) {
        throw new Error(
          'engine.reports requires a Mongoose connection. ' +
            'Pass `mongoose: connection` in createAccountingEngine config, ' +
            'or use engine.createReports({ Account, JournalEntry }) for manual models.',
        );
      }
      this._reports = this._buildReports({
        Account: this._models.Account,
        JournalEntry: this._models.JournalEntry,
        Budget: this._models.Budget,
      });
    }
    return this._reports;
  }

  // ── Schema Factories ───────────────────────────────────────────────────────

  createAccountSchema(options?: SchemaOptions) {
    return createAccountSchema(this.config, options);
  }

  createJournalEntrySchema(accountModelName: string, options?: JournalSchemaOptions) {
    return createJournalEntrySchema(this.config, accountModelName, options);
  }

  createFiscalPeriodSchema(options?: SchemaOptions) {
    return createFiscalPeriodSchema(this.config, options);
  }

  createBudgetSchema(options?: SchemaOptions) {
    return createBudgetSchema(this.config, options);
  }

  createReconciliationSchema(
    accountModelName: string,
    journalEntryModelName: string,
    options?: SchemaOptions,
  ) {
    return createReconciliationSchema(
      this.config,
      accountModelName,
      journalEntryModelName,
      options,
    );
  }

  // ── Report Engine ──────────────────────────────────────────────────────────

  /**
   * Build a reports object bound to the given models. Use this when you
   * need custom/external models. Prefer `engine.reports` when the engine
   * owns the models (via `mongoose` in config).
   */
  createReports(models: {
    Account: Model<unknown>;
    JournalEntry: Model<unknown>;
    Budget?: Model<unknown>;
  }) {
    return this._buildReports(models);
  }

  private _buildReports(models: {
    Account: Model<unknown>;
    JournalEntry: Model<unknown>;
    Budget?: Model<unknown>;
  }) {
    const { Account: AccountModel, JournalEntry: JournalEntryModel, Budget: BudgetModel } = models;
    const { country, config } = this;
    const orgField = config.multiTenant?.orgField;
    const fiscalYearStartMonth = config.fiscalYearStartMonth ?? 1;
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
          { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth },
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
          },
          params,
        ),

      incomeStatement: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
        filters?: Record<string, unknown>;
      }) => generateIncomeStatement({ AccountModel, JournalEntryModel, country, orgField }, params),

      generalLedger: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountId?: string;
        filters?: Record<string, unknown>;
      }) =>
        generateGeneralLedger(
          { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth },
          params,
        ),

      cashFlow: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
        filters?: Record<string, unknown>;
      }) => generateCashFlow({ AccountModel, JournalEntryModel, country, orgField }, params),

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
        generateDimensionBreakdown({ AccountModel, JournalEntryModel, country, orgField }, params),

      budgetVsActual: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountIds?: unknown[];
        filters?: Record<string, unknown>;
      }) => {
        if (!BudgetModel) throw new Error('Budget model required — pass Budget to createReports()');
        return generateBudgetVsActual(
          { AccountModel, JournalEntryModel, BudgetModel, country, orgField },
          params,
        );
      },

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

  // ── Account Type Helpers ───────────────────────────────────────────────────

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

  /** Get tax codes for a region */
  getTaxCodesForRegion(region: string) {
    return this.country.getTaxCodesForRegion(region);
  }

  // ── Repository Factories ─────────────────────────────────────────────────

  /**
   * Create a fully-configured journal entry repository with secure plugin wiring.
   * This is the **recommended** way to set up journal entry repositories.
   *
   * Includes:
   * - Double-entry plugin with account existence + tenant integrity validation
   * - Fiscal lock plugin (when FiscalPeriodModel is provided)
   * - post(), unpost(), reverse(), and duplicate() domain methods
   *
   * @param createRepository - The `createRepository` function from @classytic/mongokit
   * @param models.JournalEntryModel - Mongoose model for journal entries
   * @param models.AccountModel - Mongoose model for accounts (required for secure posted-create validation)
   * @param models.FiscalPeriodModel - Mongoose model for fiscal periods (optional, enables fiscal lock)
   * @param additionalPlugins - Extra plugins to include (e.g. timestampPlugin)
   * @returns A wired repository with post(), unpost(), reverse(), duplicate(), and all plugins configured
   */
  createJournalEntryRepository<TDoc = unknown>(
    createRepository: (model: Model<TDoc>, plugins: PluginType[]) => Repository<TDoc>,
    models: {
      JournalEntryModel: Model<TDoc>;
      AccountModel: Model<unknown>;
      FiscalPeriodModel?: Model<unknown>;
    },
    additionalPlugins: PluginType[] = [],
  ): JournalEntryRepository<TDoc> {
    const orgField = this.config.multiTenant?.orgField;
    const { JournalEntryModel, AccountModel, FiscalPeriodModel } = models;

    // Plugins use Model for queries only (findById, findOne) — safe to widen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jeModel = JournalEntryModel as any as Model<unknown>;

    const plugins = [
      ...additionalPlugins,
      doubleEntryPlugin({
        JournalEntryModel: jeModel,
        AccountModel,
        orgField,
      }),
    ];

    if (FiscalPeriodModel) {
      plugins.push(
        fiscalLockPlugin({
          FiscalPeriodModel,
          JournalEntryModel: jeModel,
          orgField,
        }),
      );
    }

    if (this.config.idempotency) {
      plugins.push(
        idempotencyPlugin({
          JournalEntryModel: jeModel,
          orgField,
        }),
      );
    }

    const repository = createRepository(JournalEntryModel, plugins);
    return wireJournalEntryMethods(repository, JournalEntryModel, orgField, this.config.strictness);
  }

  /**
   * Wire post/reverse domain methods onto a mongokit Repository
   * for journal entries. The repository must already be created via
   * `createRepository(Model, plugins)` from @classytic/mongokit.
   *
   * **Note:** Prefer `createJournalEntryRepository()` which guarantees
   * secure plugin wiring. This method only adds domain methods and does
   * not validate plugin configuration.
   *
   * @param repository - An existing mongokit Repository instance
   * @param JournalEntryModel - The Mongoose model for journal entries
   * @returns The same repository, now with `.post()` and `.reverse()`
   */
  wireJournalEntryRepository<TDoc = unknown>(
    repository: Repository<TDoc>,
    JournalEntryModel: Model<unknown>,
  ): JournalEntryRepository<TDoc> {
    const orgField = this.config.multiTenant?.orgField;
    return wireJournalEntryMethods(repository, JournalEntryModel, orgField, this.config.strictness);
  }

  /**
   * Wire seedAccounts/bulkCreate and posting-account validation onto a
   * mongokit Repository for accounts. The repository must already be
   * created via `createRepository(Model, plugins)` from @classytic/mongokit.
   *
   * @param repository - An existing mongokit Repository instance
   * @param AccountModel - The Mongoose model for accounts
   * @returns The same repository, now with `.seedAccounts()` and `.bulkCreate()`
   */
  wireAccountRepository<TDoc = unknown>(
    repository: Repository<TDoc>,
    AccountModel: Model<unknown>,
  ): AccountRepository<TDoc> {
    const orgField = this.config.multiTenant?.orgField;
    return wireAccountMethods(repository, AccountModel, this.country, orgField);
  }

  /**
   * Wire reconcile/unreconcile/getUnreconciled methods onto a mongokit Repository.
   */
  wireReconciliationRepository<TDoc = unknown>(
    repository: Repository<TDoc>,
    ReconciliationModel: Model<unknown>,
    JournalEntryModel: Model<unknown>,
  ): ReconciliationRepository<TDoc> {
    const orgField = this.config.multiTenant?.orgField;
    return wireReconciliationMethods(repository, ReconciliationModel, JournalEntryModel, orgField);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createAccountingEngine(
  config: AccountingEngineConfig,
  plugins: LedgerRepositoryPlugins = {},
  pagination: LedgerPaginationConfig = {},
): AccountingEngine {
  return new AccountingEngine(config, plugins, pagination);
}
