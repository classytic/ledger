/**
 * Shared Mongoose field definition for multi-currency support.
 * Used by both Account and JournalItem schemas when multiCurrency is enabled.
 */

import type { AccountingEngineConfig } from '../types/engine.js';

/**
 * Build the Mongoose currency field definition.
 * Returns `null` if multi-currency is not enabled.
 */
export function buildCurrencyField(config: AccountingEngineConfig): Record<string, unknown> | null {
  if (!config.multiCurrency?.enabled) return null;

  const allowed = config.multiCurrency.currencies;
  return {
    type: String,
    default: null,
    ...(allowed?.length ? { enum: [null, config.currency, ...allowed] } : {}),
  };
}
