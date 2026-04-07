/**
 * Models Factory — creates all ledger models bound to a Mongoose connection.
 *
 * Matches the flow/promo pattern: engine owns the models, consumers just
 * use `engine.models.Account`, `engine.models.JournalEntry`, etc.
 */

import type { Connection, Model } from 'mongoose';
import { createAccountSchema } from '../schemas/account.schema.js';
import { createBudgetSchema } from '../schemas/budget.schema.js';
import { createFiscalPeriodSchema } from '../schemas/fiscal-period.schema.js';
import { createJournalSchema } from '../schemas/journal.schema.js';
import { createJournalEntrySchema } from '../schemas/journal-entry.schema.js';
import { createReconciliationSchema } from '../schemas/reconciliation.schema.js';
import type { AccountingEngineConfig, ModelNames } from '../types/engine.js';

export interface LedgerModels {
  Account: Model<unknown>;
  JournalEntry: Model<unknown>;
  FiscalPeriod: Model<unknown>;
  Budget: Model<unknown>;
  Reconciliation: Model<unknown>;
  Journal: Model<unknown>;
}

export interface ResolvedModelNames {
  account: string;
  journalEntry: string;
  fiscalPeriod: string;
  budget: string;
  reconciliation: string;
  journal: string;
}

export function resolveModelNames(overrides?: ModelNames): ResolvedModelNames {
  return {
    account: overrides?.account ?? 'Account',
    journalEntry: overrides?.journalEntry ?? 'JournalEntry',
    fiscalPeriod: overrides?.fiscalPeriod ?? 'FiscalPeriod',
    budget: overrides?.budget ?? 'Budget',
    reconciliation: overrides?.reconciliation ?? 'Reconciliation',
    journal: overrides?.journal ?? 'Journal',
  };
}

export function createModels(connection: Connection, config: AccountingEngineConfig): LedgerModels {
  const names = resolveModelNames(config.modelNames);
  const so = config.schemaOptions ?? {};

  const existing = connection.models as Record<string, Model<unknown>>;
  const allPresent =
    existing[names.account] &&
    existing[names.journalEntry] &&
    existing[names.fiscalPeriod] &&
    existing[names.budget] &&
    existing[names.reconciliation] &&
    existing[names.journal];

  if (allPresent) {
    return {
      Account: existing[names.account],
      JournalEntry: existing[names.journalEntry],
      FiscalPeriod: existing[names.fiscalPeriod],
      Budget: existing[names.budget],
      Reconciliation: existing[names.reconciliation],
      Journal: existing[names.journal],
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

  const Journal =
    existing[names.journal] ??
    connection.model(names.journal, createJournalSchema(config, names.account, so.journal));

  return {
    Account: Account as Model<unknown>,
    JournalEntry: JournalEntry as Model<unknown>,
    FiscalPeriod: FiscalPeriod as Model<unknown>,
    Budget: Budget as Model<unknown>,
    Reconciliation: Reconciliation as Model<unknown>,
    Journal: Journal as Model<unknown>,
  };
}
