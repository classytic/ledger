/**
 * Repositories Factory — wires fully-configured repositories.
 *
 * Matches the flow/promo pattern: engine owns the repositories with all
 * plugins (double-entry, fiscal-lock, idempotency) pre-wired.
 *
 * 0.9.0 additions:
 *   - Optional `multiTenantPlugin` adoption (config.multiTenant.plugin)
 *   - Optional `EventTransport` threaded to every wireXxxMethods call
 *   - Optional `LedgerBridges` threaded through so domain verbs can resolve
 *     external sources or send notifications without importing siblings.
 */

import { multiTenantPlugin, type PluginType, Repository } from '@classytic/mongokit';
import type { LedgerBridges } from '../bridges/index.js';
import type { OutboxStore } from '../events/outbox-store.js';
import type { EventTransport } from '../events/transport.js';
import type { LedgerModels } from '../models/factory.js';
import { doubleEntryPlugin } from '../plugins/double-entry.plugin.js';
import { idempotencyPlugin } from '../plugins/idempotency.plugin.js';
import { immutableGuardPlugin } from '../plugins/immutable-guard.plugin.js';
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
 * Extra wiring context passed into wireXxxMethods so domain verbs can emit
 * events and reach out through host-provided bridges. Always optional so
 * consumers without events/bridges see no behavioral change.
 */
export interface LedgerRepositoryIntegrations {
  events?: EventTransport;
  bridges?: LedgerBridges;
  outboxStore?: OutboxStore;
}

/**
 * Build all ledger repositories with plugins + domain methods pre-wired.
 */
export function createRepositories(
  models: LedgerModels,
  config: AccountingEngineConfig,
  plugins: LedgerRepositoryPlugins = {},
  pagination: LedgerPaginationConfig = {},
  integrations: LedgerRepositoryIntegrations = {},
): LedgerRepositories {
  const orgField = config.multiTenant?.orgField;
  const strictness = config.strictness;
  const country = config.country;
  const { events, bridges, outboxStore } = integrations;

  // ── Optional tenant scoping plugin ──────────────────────────────────────
  // When enabled, mongokit injects the tenant filter at POLICY priority
  // (before cache/audit/observability) whenever ctx.organizationId is present.
  // `required: false` preserves historical behavior — calls without context
  // still work. Existing manual `orgField` filters inside wireXxxMethods act
  // as defense-in-depth and will be removed in 1.0.0.
  const tenantPlugins: PluginType[] = [];
  if (orgField && config.multiTenant?.plugin) {
    tenantPlugins.push(
      multiTenantPlugin({
        tenantField: orgField,
        contextKey: 'organizationId',
        required: config.multiTenant.required ?? false,
        // 0.9.0: `fieldType` arrived in mongokit 3.6.2. Pass through so the
        // plugin casts string tenant IDs to `ObjectId` when the schema
        // stores the tenant as `Schema.Types.ObjectId` (Better Auth
        // compatibility — enables `$lookup` and `.populate()` against the
        // `organization` collection). See PACKAGE_RULES §9.1 / §9.2.
        fieldType: config.tenantFieldType ?? 'string',
      }),
    );
  }

  // No default cap on accounts — enterprise charts of accounts can exceed
  // any fixed number. Pass `pagination: { account: { maxLimit: N } }` to cap.
  const accountPagination = pagination.account ?? {};
  const jePagination = pagination.journalEntry ?? {};
  const fpPagination = pagination.fiscalPeriod ?? {};
  const budgetPagination = pagination.budget ?? {};
  const reconPagination = pagination.reconciliation ?? {};

  // ── Account repository ──────────────────────────────────────────────────
  const accountBase = new Repository(
    models.Account,
    [...tenantPlugins, ...(plugins.account ?? [])],
    accountPagination,
  );
  const accounts = wireAccountMethods(accountBase, country, orgField, {
    events,
    bridges,
    outboxStore,
  });

  // ── Journal entry repository (with plugins) ─────────────────────────────
  const jePlugins: PluginType[] = [
    ...tenantPlugins,
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
  // 0.9.0: enforce strictness.immutable at the hook layer so direct
  // repository.update()/delete() callers can't mutate posted entries.
  if (strictness?.immutable) {
    jePlugins.push(
      immutableGuardPlugin({
        JournalEntryModel: models.JournalEntry,
        orgField,
      }),
    );
  }

  const jeBase = new Repository(models.JournalEntry, jePlugins, jePagination);
  const journalEntries = wireJournalEntryMethods(
    jeBase,
    models.JournalEntry,
    orgField,
    strictness,
    {
      events,
      bridges,
      outboxStore,
    },
  );

  // ── Fiscal period repository ────────────────────────────────────────────
  const fiscalPeriods = new Repository(
    models.FiscalPeriod,
    [...tenantPlugins, ...(plugins.fiscalPeriod ?? [])],
    fpPagination,
  );

  // ── Budget repository ───────────────────────────────────────────────────
  const budgets = new Repository(
    models.Budget,
    [...tenantPlugins, ...(plugins.budget ?? [])],
    budgetPagination,
  );

  // ── Reconciliation repository ───────────────────────────────────────────
  const reconBase = new Repository(
    models.Reconciliation,
    [...tenantPlugins, ...(plugins.reconciliation ?? [])],
    reconPagination,
  );
  const reconciliations = wireReconciliationMethods(
    reconBase,
    models.Reconciliation,
    models.JournalEntry,
    orgField,
    { events, bridges, outboxStore },
  );

  // ── Journal repository (0.6.0) ──────────────────────────────────────────
  const journalPagination = pagination.journal ?? {};
  const journalBase = new Repository(
    models.Journal,
    [...tenantPlugins, ...(plugins.journal ?? [])],
    journalPagination,
  );
  const journals = wireJournalMethods(journalBase, country, orgField, {
    events,
    bridges,
    outboxStore,
  });

  return {
    accounts,
    journalEntries,
    fiscalPeriods,
    budgets,
    reconciliations,
    journals,
  };
}
