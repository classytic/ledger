/**
 * @classytic/ledger/plugins/lock
 *
 * Unified lock primitive for fiscal, tax, daily, and custom scopes.
 * The factory and resolvers stay generic; the presets cover the
 * common cases. Consumers needing bespoke scopes compose the factory
 * with a resolver of their own.
 */

export { createLockPlugin } from './create-lock-plugin.js';
export type { PeriodResolverOptions } from './period-resolver.js';
export { periodResolver } from './period-resolver.js';
export type {
  DailyLockPluginOptions,
  FiscalLockPluginOptions,
  TaxLockPluginOptions,
} from './presets.js';
export {
  dailyLockPlugin,
  fiscalLockPlugin,
  taxLockPlugin,
} from './presets.js';
export type {
  CreateLockPluginOptions,
  LockAccountSelector,
  LockHit,
  LockResolver,
  LockResolverContext,
} from './types.js';
export type { WatermarkResolverOptions } from './watermark-resolver.js';
export { watermarkResolver } from './watermark-resolver.js';
