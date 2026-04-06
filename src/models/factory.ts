/**
 * Models Factory — creates all ledger models bound to a Mongoose connection.
 *
 * Matches the flow/promo pattern: engine owns the models, consumers just
 * use `engine.models.Account`, `engine.models.JournalEntry`, etc.
 *
 * Consumer never calls `mongoose.model()` for ledger models.
 */

import type { Connection, Model } from 'mongoose';
import { createAccountSchema } from '../schemas/account.schema.js';
import { createBudgetSchema } from '../schemas/budget.schema.js';
import { createFiscalPeriodSchema } from '../schemas/fiscal-period.schema.js';
import { createJournalEntrySchema } from '../schemas/journal-entry.schema.js';
import { createReconciliationSchema } from '../schemas/reconciliation.schema.js';
import type { AccountingEngineConfig, ModelNames } from '../types/engine.js';

export interface LedgerModels {
  Account: Model<unknown>;
  JournalEntry: Model<unknown>;
  FiscalPeriod: Model<unknown>;
  Budget: Model<unknown>;
  Reconciliation: Model<unknown>;
}

export interface ResolvedModelNames {
  account: string;
  journalEntry: string;
  fiscalPeriod: string;
  budget: string;
  reconciliation: string;
}

export function resolveModelNames(overrides?: ModelNames): ResolvedModelNames {
  return {
    account: overrides?.account ?? 'Account',
    journalEntry: overrides?.journalEntry ?? 'JournalEntry',
    fiscalPeriod: overrides?.fiscalPeriod ?? 'FiscalPeriod',
    budget: overrides?.budget ?? 'Budget',
    reconciliation: overrides?.reconciliation ?? 'Reconciliation',
  };
}

/**
 * Create (or reuse) all ledger models on the given connection.
 *
 * If a model with the same name is already registered on the connection,
 * the existing model is reused — this allows multiple engine instances
 * to share models and prevents "OverwriteModelError".
 */
export function createModels(connection: Connection, config: AccountingEngineConfig): LedgerModels {
  const names = resolveModelNames(config.modelNames);
  const so = config.schemaOptions ?? {};

  // Check for pre-registered models (supports hot-reload and multiple engines)
  const existing = connection.models as Record<string, Model<unknown>>;
  if (
    existing[names.account] &&
    existing[names.journalEntry] &&
    existing[names.fiscalPeriod] &&
    existing[names.budget] &&
    existing[names.reconciliation]
  ) {
    return {
      Account: existing[names.account],
      JournalEntry: existing[names.journalEntry],
      FiscalPeriod: existing[names.fiscalPeriod],
      Budget: existing[names.budget],
      Reconciliation: existing[names.reconciliation],
    };
  }

  const Account =
    existing[names.account] ??
    connection.model(names.account, createAccountSchema(config, so.account));

  const JournalEntry =
    existing[names.journalEntry] ??
    connection.model(
      names.journalEntry,
      createJournalEntrySchema(config, names.account, so.journalEntry),
    );

  const FiscalPeriod =
    existing[names.fiscalPeriod] ??
    connection.model(names.fiscalPeriod, createFiscalPeriodSchema(config, so.fiscalPeriod));

  const Budget =
    existing[names.budget] ?? connection.model(names.budget, createBudgetSchema(config, so.budget));

  const Reconciliation =
    existing[names.reconciliation] ??
    connection.model(
      names.reconciliation,
      createReconciliationSchema(config, names.account, names.journalEntry, so.reconciliation),
    );

  return {
    Account: Account as Model<unknown>,
    JournalEntry: JournalEntry as Model<unknown>,
    FiscalPeriod: FiscalPeriod as Model<unknown>,
    Budget: Budget as Model<unknown>,
    Reconciliation: Reconciliation as Model<unknown>,
  };
}
