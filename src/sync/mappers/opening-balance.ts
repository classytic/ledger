/**
 * Opening balance mapper — converts a CanonicalTrialBalance into a single
 * multi-line JournalEntry via the wireImport pipeline.
 *
 * This mapper wraps `buildOpeningBalanceEntry` for consumers that want to
 * use the standard wireImport flow (with findExisting dedup, batch processing,
 * error reporting, etc.).
 *
 * For simpler use cases, call `buildOpeningBalanceEntry` directly or use
 * `engine.record.openingBalance()`.
 *
 * @example
 * ```typescript
 * import { wireImport, openingBalanceMapper } from '@classytic/ledger/sync';
 *
 * const report = await wireImport({
 *   source: [trialBalance],
 *   mapper: openingBalanceMapper({
 *     resolveAccountCode: (code) => accountIdMap.get(code),
 *     equityAccountId: retainedEarningsId,
 *     cutoverDate: new Date('2025-01-01'),
 *   }),
 *   journalEntries: engine.repositories.journalEntries,
 *   context: { organizationId },
 * }).run();
 * ```
 */

import type { ImportMapper } from '../../types/sync';
import { buildOpeningBalanceEntry } from '../builders/opening-balance';

/** Minimal trial balance shape — matches CanonicalTrialBalance from fin-io
 *  but defined locally to avoid a hard dependency on fin-io. Any object
 *  matching this shape works. */
export interface TrialBalanceInput {
  asOfDate: Date;
  currency: string;
  lines: ReadonlyArray<{
    accountCode: string;
    accountName: string;
    debit?: { amount: bigint; currency: string };
    credit?: { amount: bigint; currency: string };
  }>;
}

export interface OpeningBalanceMapperConfig {
  /** Resolve an account type code to a ledger Account ObjectId (or any ID).
   *  Return `undefined` to skip an account line. */
  resolveAccountCode: (code: string) => unknown | undefined;
  /** The ObjectId of the equity/retained earnings account. */
  equityAccountId: unknown;
  /** Cutover date for the opening balance entry. */
  cutoverDate: Date;
}

export function openingBalanceMapper(
  config: OpeningBalanceMapperConfig,
): ImportMapper<TrialBalanceInput> {
  return {
    externalId: (_tb) => {
      const dateStr = config.cutoverDate.toISOString().split('T')[0];
      return `opening-balance:${dateStr}`;
    },

    toJournalEntry: (tb, _ctx) => {
      // Convert CanonicalTrialBalance lines → signed balances in cents
      const balances: Array<{ accountCode: string; balance: number }> = [];

      for (const line of tb.lines) {
        const debitCents = line.debit ? Number(line.debit.amount) : 0;
        const creditCents = line.credit ? Number(line.credit.amount) : 0;
        const net = debitCents - creditCents;
        if (net === 0) continue;

        const resolved = config.resolveAccountCode(line.accountCode);
        if (!resolved) continue; // skip unresolvable accounts

        balances.push({ accountCode: String(resolved), balance: net });
      }

      if (balances.length === 0) return null;

      const result = buildOpeningBalanceEntry({
        cutoverDate: config.cutoverDate,
        balances,
        equityAccountCode: String(config.equityAccountId),
      });

      return result.entry;
    },
  };
}
