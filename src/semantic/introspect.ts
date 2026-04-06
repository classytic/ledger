/**
 * Introspection API — runtime discovery for AI agents and MCP tools.
 *
 * Every method returns structured, JSON-serializable data that an
 * autonomous agent can consume without reading source code.
 *
 * @example
 * ```typescript
 * const accounts = await engine.introspect.accounts(orgId);
 * const journals = engine.introspect.journalTypes();
 * const reports = engine.introspect.reports();
 * const taxes = engine.introspect.taxCodes('ON');
 * const periods = await engine.introspect.fiscalPeriods(orgId);
 * ```
 */

import type { ClientSession, Model } from 'mongoose';
import { getCustomJournalTypes, JOURNAL_TYPES } from '../constants/journals.js';
import type { CountryPack, TaxCode } from '../country/index.js';
import type { LedgerModels } from '../models/factory.js';
import type { JournalType } from '../types/core.js';
import type { AccountingEngineConfig } from '../types/engine.js';

// ── Output Shapes ─────────────────────────────────────────────────────────

export interface AccountSummary {
  /** Mongoose _id */
  readonly id: string;
  /** Account type code from country pack (e.g. '1001') */
  readonly code: string;
  /** Display name from country pack */
  readonly name: string;
  /** Statement category (Balance Sheet-Asset, Income Statement-Expense, etc.) */
  readonly category: string;
  /** Normal balance (debit or credit) */
  readonly normalBalance: 'debit' | 'credit';
  /** Parent group code if nested */
  readonly parentCode: string | null;
  /** Is this a posting account (not a group/total)? */
  readonly isPosting: boolean;
  /** True if the Account document is active */
  readonly active: boolean;
  /** Organization id (multi-tenant only) */
  readonly organizationId?: string;
}

export interface ReportDescriptor {
  /** Programmatic name (e.g. 'trialBalance') */
  readonly name: string;
  /** Human-readable title */
  readonly title: string;
  /** Short description of what it returns */
  readonly description: string;
  /** List of parameter names and whether required */
  readonly params: ReadonlyArray<{
    readonly name: string;
    readonly required: boolean;
    readonly description: string;
  }>;
}

export interface FiscalPeriodSummary {
  readonly id: string;
  readonly name: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly closed: boolean;
  readonly closedAt?: Date;
  readonly organizationId?: string;
}

// ── Introspect API Shape ──────────────────────────────────────────────────

export interface IntrospectAPI {
  /**
   * List all accounts for an organization (or all if single-tenant).
   * Returns structured summaries suitable for MCP tool responses.
   */
  accounts(organizationId?: unknown, session?: ClientSession | null): Promise<AccountSummary[]>;

  /**
   * List all journal types — built-in (15) plus any custom types
   * registered via `registerJournalType()`.
   */
  journalTypes(): ReadonlyArray<JournalType>;

  /**
   * List all available reports with their parameter schemas.
   * Agents use this to discover what analytics they can run.
   */
  reports(): ReadonlyArray<ReportDescriptor>;

  /**
   * List tax codes — all of them, or filtered by region.
   */
  taxCodes(region?: string): ReadonlyArray<TaxCode>;

  /**
   * List fiscal periods for an organization.
   */
  fiscalPeriods(
    organizationId?: unknown,
    session?: ClientSession | null,
  ): Promise<FiscalPeriodSummary[]>;

  /**
   * A one-shot snapshot of everything an agent needs to start working:
   * accounts, journal types, reports, tax codes, fiscal periods.
   */
  catalog(organizationId?: unknown): Promise<{
    accounts: AccountSummary[];
    journalTypes: ReadonlyArray<JournalType>;
    reports: ReadonlyArray<ReportDescriptor>;
    taxCodes: ReadonlyArray<TaxCode>;
    fiscalPeriods: FiscalPeriodSummary[];
  }>;
}

// ── Report Catalog (static metadata) ──────────────────────────────────────

const REPORT_CATALOG: ReadonlyArray<ReportDescriptor> = Object.freeze([
  {
    name: 'trialBalance',
    title: 'Trial Balance',
    description:
      'Debits and credits per account for a period, with opening, current, and ending balances.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      {
        name: 'dateValue',
        required: true,
        description: 'Period value (format depends on dateOption)',
      },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'accountId', required: false, description: 'Filter to a single account' },
      { name: 'filters', required: false, description: 'Additional dimension filters' },
    ],
  },
  {
    name: 'balanceSheet',
    title: 'Balance Sheet',
    description:
      'Assets, liabilities, and equity at a point in time. Includes computed retained earnings.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'businessName', required: false, description: 'Header label' },
      { name: 'filters', required: false, description: 'Additional dimension filters' },
    ],
  },
  {
    name: 'incomeStatement',
    title: 'Income Statement',
    description: 'Revenue, COGS, gross profit, operating expenses, and net income for a period.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'businessName', required: false, description: 'Header label' },
      { name: 'filters', required: false, description: 'Additional dimension filters' },
    ],
  },
  {
    name: 'generalLedger',
    title: 'General Ledger',
    description: 'Per-account transaction detail with running balances. Use accountId to scope.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'accountId', required: false, description: 'Scope to a single account' },
    ],
  },
  {
    name: 'cashFlow',
    title: 'Cash Flow Statement',
    description: 'Cash movement by Operating / Investing / Financing sections.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
    ],
  },
  {
    name: 'agedBalance',
    title: 'Aged Receivables / Payables',
    description: 'Outstanding AR or AP bucketed by age (current, 30, 60, 90+).',
    params: [
      { name: 'type', required: true, description: "'receivable' | 'payable'" },
      { name: 'asOfDate', required: false, description: 'Defaults to now' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'buckets', required: false, description: 'Custom bucket definitions' },
    ],
  },
  {
    name: 'dimensionBreakdown',
    title: 'Dimension Breakdown',
    description: 'Expense/revenue by a custom dimension (department, project, cost center).',
    params: [
      {
        name: 'dimension',
        required: true,
        description: 'Field name to group by (e.g. departmentId)',
      },
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
      { name: 'accountCategory', required: false, description: 'Filter by statement category' },
    ],
  },
  {
    name: 'budgetVsActual',
    title: 'Budget vs Actual',
    description: 'Compare budgeted amounts to actual posted entries for a period.',
    params: [
      {
        name: 'dateOption',
        required: true,
        description: "'month' | 'quarter' | 'year' | 'custom'",
      },
      { name: 'dateValue', required: true, description: 'Period value' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
    ],
  },
  {
    name: 'revaluation',
    title: 'Foreign Exchange Revaluation',
    description: 'Unrealized FX gain/loss on foreign-currency accounts at a date.',
    params: [
      { name: 'asOfDate', required: true, description: 'Revaluation date' },
      { name: 'rates', required: true, description: 'Array of { currency, rate } at asOfDate' },
      { name: 'unrealizedGainLossAccountId', required: true, description: 'Account for FX P&L' },
      { name: 'generateEntry', required: false, description: 'Auto-create adjustment entry' },
      { name: 'organizationId', required: false, description: 'Multi-tenant scoping' },
    ],
  },
]);

// ── Implementation ────────────────────────────────────────────────────────

interface BuildDeps {
  models: LedgerModels;
  country: CountryPack;
  config: AccountingEngineConfig;
}

export function buildIntrospectAPI({ models, country, config }: BuildDeps): IntrospectAPI {
  const AccountModel = models.Account as Model<unknown>;
  const FiscalPeriodModel = models.FiscalPeriod as Model<unknown>;
  const orgField = config.multiTenant?.orgField;

  // ── Normal balance lookup from category ──
  const normalBalanceFor = (category: string): 'debit' | 'credit' => {
    // Assets and Expenses have debit normal balance; rest are credit.
    if (category.endsWith('Asset') || category.endsWith('Expense')) return 'debit';
    return 'credit';
  };

  const accounts: IntrospectAPI['accounts'] = async (organizationId, session = null) => {
    const filter: Record<string, unknown> = {};
    if (orgField && organizationId != null) filter[orgField] = organizationId;

    const docs = (await AccountModel.find(filter).session(session).lean()) as Array<
      Record<string, unknown>
    >;

    return docs.map((doc) => {
      const code = String(doc.accountTypeCode ?? '');
      const at = country.getAccountType(code);
      const category = at?.category ?? 'Unknown';
      return {
        id: String(doc._id),
        code,
        name: at?.name ?? code,
        category,
        normalBalance: normalBalanceFor(category),
        parentCode: at?.parentCode ?? null,
        isPosting: country.isPostingAccount(code),
        active: doc.active !== false,
        ...(orgField && doc[orgField] != null ? { organizationId: String(doc[orgField]) } : {}),
      };
    });
  };

  const journalTypes: IntrospectAPI['journalTypes'] = () => {
    const builtIn = Object.values(JOURNAL_TYPES);
    const custom = getCustomJournalTypes();
    return Object.freeze([...builtIn, ...custom]);
  };

  const reports: IntrospectAPI['reports'] = () => REPORT_CATALOG;

  const taxCodes: IntrospectAPI['taxCodes'] = (region) => {
    if (region) return Object.freeze(country.getTaxCodesForRegion(region));
    return Object.freeze(Object.values(country.taxCodes));
  };

  const fiscalPeriods: IntrospectAPI['fiscalPeriods'] = async (organizationId, session = null) => {
    const filter: Record<string, unknown> = {};
    if (orgField && organizationId != null) filter[orgField] = organizationId;

    const docs = (await FiscalPeriodModel.find(filter)
      .sort({ startDate: 1 })
      .session(session)
      .lean()) as Array<Record<string, unknown>>;

    return docs.map((doc) => ({
      id: String(doc._id),
      name: String(doc.name ?? ''),
      startDate: doc.startDate as Date,
      endDate: doc.endDate as Date,
      closed: Boolean(doc.closed),
      ...(doc.closedAt ? { closedAt: doc.closedAt as Date } : {}),
      ...(orgField && doc[orgField] != null ? { organizationId: String(doc[orgField]) } : {}),
    }));
  };

  const catalog: IntrospectAPI['catalog'] = async (organizationId) => ({
    accounts: await accounts(organizationId),
    journalTypes: journalTypes(),
    reports: reports(),
    taxCodes: taxCodes(),
    fiscalPeriods: await fiscalPeriods(organizationId),
  });

  return { accounts, journalTypes, reports, taxCodes, fiscalPeriods, catalog };
}
