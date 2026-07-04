/**
 * Builtin lock presets (0.7.0).
 *
 * Thin wrappers around `createLockPlugin` + a resolver. They exist so
 * common cases stay one-liners in consumer code while still leaving
 * the low-level factory available for bespoke scopes.
 *
 *   fiscalLockPlugin ─ annual / quarterly fiscal close (FiscalPeriod model)
 *   dailyLockPlugin  ─ daily POS / operations close (single watermark)
 *
 * Consumers that need **tax-period filing locks** should wire them via a
 * tax engine package (e.g. `@classytic/bd-tax`, `@classytic/ca-tax`) that
 * owns the tax-period schema and composes `createLockPlugin` +
 * `periodResolver` internally. The ledger core is intentionally
 * tax-agnostic.
 *
 * Consumers that need bank-reconciliation / payroll-run / custom lock
 * windows should compose `createLockPlugin` with one of the resolvers
 * directly.
 */

import type { ClientSession, Model } from 'mongoose';
import { createLockPlugin } from './create-lock-plugin.js';
import { periodResolver } from './period-resolver.js';
import { watermarkResolver } from './watermark-resolver.js';

// ── Fiscal ──────────────────────────────────────────────────────────────────

export interface FiscalLockPluginOptions {
  FiscalPeriodModel: Model<unknown>;
  JournalEntryModel?: Model<unknown> | undefined;
  orgField?: string | undefined;
}

export function fiscalLockPlugin(options: FiscalLockPluginOptions) {
  return createLockPlugin({
    scope: 'fiscal',
    JournalEntryModel: options.JournalEntryModel,
    orgField: options.orgField,
    resolve: periodResolver({
      scope: 'fiscal',
      PeriodModel: options.FiscalPeriodModel,
      orgField: options.orgField,
    }),
  });
}

// ── Daily ───────────────────────────────────────────────────────────────────

export interface DailyLockPluginOptions {
  /**
   * Return the `lastClosedDate` for the given org/branch — everything
   * on or before this date is frozen. Return `null` if the branch
   * has never been closed.
   */
  getLastClosedDate: (
    orgValue: unknown,
    session: ClientSession | null,
  ) => Promise<Date | null> | Date | null;
  JournalEntryModel?: Model<unknown> | undefined;
  orgField?: string | undefined;
}

export function dailyLockPlugin(options: DailyLockPluginOptions) {
  return createLockPlugin({
    scope: 'daily',
    JournalEntryModel: options.JournalEntryModel,
    orgField: options.orgField,
    resolve: watermarkResolver({
      scope: 'daily',
      getWatermark: options.getLastClosedDate,
      formatLabel: (watermark) => `day closed through ${watermark.toISOString().split('T')[0]}`,
    }),
  });
}
