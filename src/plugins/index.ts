/**
 * @classytic/ledger/plugins
 */

export type { CreditLimitPluginOptions } from './credit-limit.plugin.js';
export { creditLimitPlugin } from './credit-limit.plugin.js';
export type { DoubleEntryPluginOptions } from './double-entry.plugin.js';
export { doubleEntryPlugin } from './double-entry.plugin.js';
export type { FxRealizationPluginOptions } from './fx-realization.plugin.js';
export { fxRealizationPlugin } from './fx-realization.plugin.js';
export type { IdempotencyPluginOptions } from './idempotency.plugin.js';
export { idempotencyPlugin } from './idempotency.plugin.js';
export type {
  CreateLockPluginOptions,
  DailyLockPluginOptions,
  FiscalLockPluginOptions,
  LockAccountSelector,
  LockHit,
  LockResolver,
  LockResolverContext,
  PeriodResolverOptions,
  WatermarkResolverOptions,
} from './lock/index.js';
// Unified lock primitive — fiscal, daily, and custom scopes.
// Tax-period locks live in tax packages (e.g. @classytic/bd-tax).
export {
  createLockPlugin,
  dailyLockPlugin,
  fiscalLockPlugin,
  periodResolver,
  watermarkResolver,
} from './lock/index.js';
