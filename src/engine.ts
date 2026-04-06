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
 *   multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
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

import type { Model } from 'mongoose';
import type { CountryPack } from './country/index.js';
import { createModels, type LedgerModels } from './models/factory.js';
import { Money } from './money.js';
import { generateAgedBalance } from './reports/aged-balance.js';
import { generateBalanceSheet } from './reports/balance-sheet.js';
import { generateBudgetVsActual } from './reports/budget-vs-actual.js';
import { generateCashFlow } from './reports/cash-flow.js';
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

  private _reports?: ReturnType<AccountingEngine['_buildReports']>;

  constructor(config: AccountingEngineConfig) {
    if (!config.mongoose) {
      throw new Error(
        'createAccountingEngine: `mongoose` connection is required. ' +
          'Pass `mongoose: mongoose.connection` in config.',
      );
    }

    this.config = config;
    this.country = config.country;
    this.currency = config.currency;

    // Eagerly build models + repositories (flow/promo pattern)
    this.models = createModels(config.mongoose, config);
    this.repositories = createRepositories(
      this.models,
      config,
      config.plugins ?? {},
      config.pagination ?? {},
    );

    // Semantic APIs — primitives for AI agents and MCP tools
    this.record = buildRecordAPI({
      models: this.models,
      repositories: this.repositories,
      country: this.country,
      config: this.config,
    });
    this.introspect = buildIntrospectAPI({
      models: this.models,
      country: this.country,
      config: this.config,
    });
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

  /** Get tax codes for a region */
  getTaxCodesForRegion(region: string) {
    return this.country.getTaxCodesForRegion(region);
  }

  // ── Reports Builder (uses owned models) ────────────────────────────────────

  private _buildReports() {
    const AccountModel = this.models.Account as Model<unknown>;
    const JournalEntryModel = this.models.JournalEntry as Model<unknown>;
    const BudgetModel = this.models.Budget as Model<unknown>;
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
      }) =>
        generateBudgetVsActual(
          { AccountModel, JournalEntryModel, BudgetModel, country, orgField },
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

// ── Factory ────────────────────────────────────────────────────────────────

export function createAccountingEngine(config: AccountingEngineConfig): AccountingEngine {
  return new AccountingEngine(config);
}
