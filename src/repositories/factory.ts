/**
 * Repositories Factory — wires fully-configured repositories.
 *
 * Matches the flow/promo pattern: engine owns the repositories with all
 * plugins (double-entry, fiscal-lock, idempotency) pre-wired.
 *
 * Consumer never constructs Repository, never calls wireXxx methods.
 * Just uses `engine.repositories.accounts.seedAccounts(orgId)`.
 */

import { type PluginType, Repository } from '@classytic/mongokit';
import type { LedgerModels } from '../models/factory.js';
import { doubleEntryPlugin } from '../plugins/double-entry.plugin.js';
import { idempotencyPlugin } from '../plugins/idempotency.plugin.js';
import { fiscalLockPlugin } from '../plugins/lock/index.js';
import type {
  AccountingEngineConfig,
  LedgerPaginationConfig,
  LedgerRepositoryPlugins,
} from '../types/engine.js';
import type {
  AccountRepository,
  JournalEntryRepository,
  JournalRepository,
  ReconciliationRepository,
} from '../types/repositories.js';
import { wireAccountMethods } from './account.repository.js';
import { wireJournalMethods } from './journal.repository.js';
import { wireJournalEntryMethods } from './journal-entry.repository.js';
import { wireReconciliationMethods } from './reconciliation.repository.js';

export type { LedgerPaginationConfig, LedgerRepositoryPlugins } from '../types/engine.js';

export interface LedgerRepositories {
  accounts: AccountRepository<unknown>;
  journalEntries: JournalEntryRepository<unknown>;
  fiscalPeriods: Repository<unknown>;
  budgets: Repository<unknown>;
  reconciliations: ReconciliationRepository<unknown>;
  journals: JournalRepository<unknown>;
}

/**
 * Build all ledger repositories with plugins + domain methods pre-wired.
 *
 * - `accounts` — has seedAccounts(), bulkCreate()
 * - `journalEntries` — has post(), unpost(), reverse(), duplicate() + double-entry + fiscal-lock (+ idempotency if enabled)
 * - `fiscalPeriods` — plain CRUD
 * - `budgets` — plain CRUD
 * - `reconciliations` — has reconcile(), unreconcile(), getUnreconciled()
 */
export function createRepositories(
  models: LedgerModels,
  config: AccountingEngineConfig,
  plugins: LedgerRepositoryPlugins = {},
  pagination: LedgerPaginationConfig = {},
): LedgerRepositories {
  const orgField = config.multiTenant?.orgField;
  const strictness = config.strictness;
  const country = config.country;

  // No default cap on accounts — enterprise charts of accounts can exceed
  // any fixed number. Pass `pagination: { account: { maxLimit: N } }` to cap.
  const accountPagination = pagination.account ?? {};
  const jePagination = pagination.journalEntry ?? {};
  const fpPagination = pagination.fiscalPeriod ?? {};
  const budgetPagination = pagination.budget ?? {};
  const reconPagination = pagination.reconciliation ?? {};

  // ── Account repository ──────────────────────────────────────────────────
  const accountBase = new Repository(models.Account, plugins.account ?? [], accountPagination);
  const accounts = wireAccountMethods(accountBase, models.Account, country, orgField);

  // ── Journal entry repository (with plugins) ─────────────────────────────
  const jePlugins: PluginType[] = [
    ...(plugins.journalEntry ?? []),
    doubleEntryPlugin({
      JournalEntryModel: models.JournalEntry,
      AccountModel: models.Account,
      orgField,
    }),
    fiscalLockPlugin({
      FiscalPeriodModel: models.FiscalPeriod,
      JournalEntryModel: models.JournalEntry,
      orgField,
    }),
  ];
  if (config.idempotency) {
    jePlugins.push(idempotencyPlugin({ JournalEntryModel: models.JournalEntry, orgField }));
  }

  const jeBase = new Repository(models.JournalEntry, jePlugins, jePagination);
  const journalEntries = wireJournalEntryMethods(jeBase, models.JournalEntry, orgField, strictness);

  // ── Fiscal period repository ────────────────────────────────────────────
  const fiscalPeriods = new Repository(
    models.FiscalPeriod,
    plugins.fiscalPeriod ?? [],
    fpPagination,
  );

  // ── Budget repository ───────────────────────────────────────────────────
  const budgets = new Repository(models.Budget, plugins.budget ?? [], budgetPagination);

  // ── Reconciliation repository ───────────────────────────────────────────
  const reconBase = new Repository(
    models.Reconciliation,
    plugins.reconciliation ?? [],
    reconPagination,
  );
  const reconciliations = wireReconciliationMethods(
    reconBase,
    models.Reconciliation,
    models.JournalEntry,
    orgField,
  );

  // ── Journal repository (0.6.0) ──────────────────────────────────────────
  const journalPagination = pagination.journal ?? {};
  const journalBase = new Repository(models.Journal, plugins.journal ?? [], journalPagination);
  const journals = wireJournalMethods(journalBase, country, orgField);

  return {
    accounts,
    journalEntries,
    fiscalPeriods,
    budgets,
    reconciliations,
    journals,
  };
}
