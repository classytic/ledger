/**
 * Builtin lock presets.
 *
 * Thin wrappers around `createLockPlugin` + a resolver. They exist so
 * common cases stay one-liners in consumer code while still leaving
 * the low-level factory available for bespoke scopes.
 *
 *   fiscalLockPlugin ─ annual / quarterly fiscal close (FiscalPeriod model)
 *   taxLockPlugin    ─ monthly / quarterly tax filings, narrowed by account
 *   dailyLockPlugin  ─ daily POS / operations close (single watermark)
 *
 * Consumers that need custom shapes (bank reconciliation windows,
 * payroll lock cycles, etc.) should compose `createLockPlugin` with
 * one of the resolvers directly.
 */

import type { ClientSession, Model } from 'mongoose';
import { createLockPlugin } from './create-lock-plugin.js';
import { periodResolver } from './period-resolver.js';
import type { LockAccountSelector } from './types.js';
import { watermarkResolver } from './watermark-resolver.js';

// ── Fiscal ──────────────────────────────────────────────────────────────────

export interface FiscalLockPluginOptions {
  FiscalPeriodModel: Model<unknown>;
  JournalEntryModel?: Model<unknown>;
  orgField?: string;
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

// ── Tax ─────────────────────────────────────────────────────────────────────

export interface TaxLockPluginOptions {
  /**
   * Tax-period model. Expected shape (fields are overridable via the
   * lower-level `createLockPlugin` if your schema differs):
   *
   *   {
   *     periodStart: Date,
   *     periodEnd: Date,
   *     status: 'open' | 'filed' | 'amended',
   *     jurisdiction?: string,
   *     taxType?: string,
   *     returnRef?: string,
   *     [orgField]?: unknown,
   *   }
   *
   * `status !== 'open'` counts as locked.
   */
  TaxPeriodModel: Model<unknown>;
  AccountModel: Model<unknown>;
  JournalEntryModel?: Model<unknown>;
  orgField?: string;
  /**
   * Predicate deciding which accounts participate in tax returns.
   * Defaults to `acc => acc.taxMetadata != null` — matches the
   * convention used by country packs that populate `taxMetadata` on
   * tax-payable / tax-recoverable account types.
   */
  isTaxAffecting?: LockAccountSelector;
  /**
   * Derive `{ jurisdiction, taxType }` from the entry payload so each
   * post can look up the right row. Default: use `data.jurisdiction`
   * and `data.taxType` directly when present.
   */
  deriveFilter?: (
    data: Record<string, unknown>,
  ) => { jurisdiction?: string; taxType?: string } | undefined;
}

const defaultTaxSelector: LockAccountSelector = (acc) => acc.taxMetadata != null;

export function taxLockPlugin(options: TaxLockPluginOptions) {
  const { TaxPeriodModel, AccountModel, JournalEntryModel, orgField } = options;
  const isTaxAffecting = options.isTaxAffecting ?? defaultTaxSelector;
  const deriveFilter =
    options.deriveFilter ??
    ((data: Record<string, unknown>) => ({
      jurisdiction: data.jurisdiction as string | undefined,
      taxType: data.taxType as string | undefined,
    }));

  return createLockPlugin({
    scope: 'tax',
    accountSelector: isTaxAffecting,
    AccountModel,
    JournalEntryModel,
    orgField,
    resolve: periodResolver({
      scope: 'tax',
      PeriodModel: TaxPeriodModel,
      startField: 'periodStart',
      endField: 'periodEnd',
      closedField: 'status',
      closedValue: { $ne: 'open' },
      labelField: 'jurisdiction',
      subTypeField: 'taxType',
      externalRefField: 'returnRef',
      orgField,
      extraQuery: (ctx) => {
        const filter = deriveFilter(ctx.data);
        if (!filter) return undefined;
        const out: Record<string, unknown> = {};
        if (filter.jurisdiction) out.jurisdiction = filter.jurisdiction;
        if (filter.taxType) out.taxType = filter.taxType;
        return Object.keys(out).length ? out : undefined;
      },
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
  JournalEntryModel?: Model<unknown>;
  orgField?: string;
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
