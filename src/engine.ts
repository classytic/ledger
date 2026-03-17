/**
 * AccountingEngine — The main entry point for @classytic/ledger.
 *
 * Usage:
 *   const accounting = createAccountingEngine({
 *     country: canadaPack,
 *     currency: 'CAD',
 *     multiTenant: { orgField: 'business', orgRef: 'Business' },
 *   });
 *
 *   const AccountSchema = accounting.createAccountSchema();
 *   const JournalEntrySchema = accounting.createJournalEntrySchema('Account');
 *   const FiscalPeriodSchema = accounting.createFiscalPeriodSchema();
 *
 *   // Register models
 *   const Account = mongoose.model('Account', AccountSchema);
 *   const JournalEntry = mongoose.model('JournalEntry', JournalEntrySchema);
 *   const FiscalPeriod = mongoose.model('FiscalPeriod', FiscalPeriodSchema);
 *
 *   // Reports
 *   const reports = accounting.createReports({ Account, JournalEntry });
 *   const bs = await reports.balanceSheet({ dateOption: 'year', dateValue: 2025, organizationId: '...' });
 */

import type { Model } from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions, JournalSchemaOptions } from './types/engine.js';
import type { CountryPack } from './country/index.js';
import { createAccountSchema } from './schemas/account.schema.js';
import { createJournalEntrySchema } from './schemas/journal-entry.schema.js';
import { createFiscalPeriodSchema } from './schemas/fiscal-period.schema.js';
import { generateTrialBalance } from './reports/trial-balance.js';
import { generateBalanceSheet } from './reports/balance-sheet.js';
import { generateIncomeStatement } from './reports/income-statement.js';
import { generateGeneralLedger } from './reports/general-ledger.js';
import { generateCashFlow } from './reports/cash-flow.js';
import { Money } from './money.js';
import { wireJournalEntryMethods } from './repositories/journal-entry.repository.js';
import { wireAccountMethods } from './repositories/account.repository.js';
import { doubleEntryPlugin } from './plugins/double-entry.plugin.js';
import { fiscalLockPlugin } from './plugins/fiscal-lock.plugin.js';

export class AccountingEngine {
  readonly config: AccountingEngineConfig;
  readonly country: CountryPack;
  readonly currency: string;
  readonly money = Money;

  constructor(config: AccountingEngineConfig) {
    this.config = config;
    this.country = config.country;
    this.currency = config.currency;
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

  // ── Report Engine ──────────────────────────────────────────────────────────

  createReports(models: {
    Account: Model<unknown>;
    JournalEntry: Model<unknown>;
  }) {
    const { Account: AccountModel, JournalEntry: JournalEntryModel } = models;
    const { country, config } = this;
    const orgField = config.multiTenant?.orgField;
    const fiscalYearStartMonth = config.fiscalYearStartMonth ?? 1;
    const retainedEarningsCode = config.retainedEarningsCode;
    const currentYearEarningsCode = config.currentYearEarningsCode;

    return {
      trialBalance: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountId?: string;
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
      }) =>
        generateBalanceSheet(
          { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth, retainedEarningsCode, currentYearEarningsCode },
          params,
        ),

      incomeStatement: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        businessName?: string;
      }) =>
        generateIncomeStatement(
          { AccountModel, JournalEntryModel, country, orgField },
          params,
        ),

      generalLedger: (params: {
        organizationId?: unknown;
        dateOption: 'month' | 'quarter' | 'year' | 'custom';
        dateValue: unknown;
        accountId?: string;
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
      }) =>
        generateCashFlow(
          { AccountModel, JournalEntryModel, country, orgField },
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
  createJournalEntryRepository(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createRepository: (model: Model<unknown>, plugins: any[]) => any,
    models: {
      JournalEntryModel: Model<unknown>;
      AccountModel: Model<unknown>;
      FiscalPeriodModel?: Model<unknown>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    additionalPlugins: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    const orgField = this.config.multiTenant?.orgField;
    const { JournalEntryModel, AccountModel, FiscalPeriodModel } = models;

    const plugins = [
      ...additionalPlugins,
      doubleEntryPlugin({
        JournalEntryModel,
        AccountModel,
        orgField,
      }),
    ];

    if (FiscalPeriodModel) {
      plugins.push(
        fiscalLockPlugin({
          FiscalPeriodModel,
          JournalEntryModel,
          orgField,
        }),
      );
    }

    const repository = createRepository(JournalEntryModel, plugins);
    wireJournalEntryMethods(repository, JournalEntryModel, orgField);
    return repository;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wireJournalEntryRepository(repository: any, JournalEntryModel: Model<unknown>): any {
    const orgField = this.config.multiTenant?.orgField;
    wireJournalEntryMethods(repository, JournalEntryModel, orgField);
    return repository;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wireAccountRepository(repository: any, AccountModel: Model<unknown>): any {
    const orgField = this.config.multiTenant?.orgField;
    wireAccountMethods(repository, AccountModel, this.country, orgField);
    return repository;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createAccountingEngine(config: AccountingEngineConfig): AccountingEngine {
  return new AccountingEngine(config);
}
