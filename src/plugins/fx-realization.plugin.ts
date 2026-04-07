/**
 * FX Realization Plugin (0.6.0)
 *
 * Listens on the reconciliation repository's `after:match` hook. When a
 * matched set of items shares a single foreign currency but was posted
 * at different exchange rates, this plugin computes the realized
 * gain/loss in base currency and books a balancing journal entry.
 *
 *   Invoice  : 1000 USD @ 1.35 CAD/USD  → 1350 CAD debit AR
 *   Payment  : 1000 USD @ 1.42 CAD/USD  → 1420 CAD credit Bank
 *                                                ↓
 *   Realized gain: 70 CAD  (debit AR / credit FX gain)
 *
 * The generated entry is tagged `_ledgerInternal: 'fxRealize'` so the
 * lock plugins don't block it and the double-entry guard doesn't
 * re-validate the immutability of the matched items.
 *
 * Consumers wire this manually against the reconciliation repository:
 *
 *   fxRealizationPlugin({
 *     journalEntries: engine.repositories.journalEntries,
 *     realizedGainAccount: gainAcctId,
 *     realizedLossAccount: lossAcctId,
 *     baseCurrency: 'CAD',
 *     orgField: 'organizationId',
 *   }).apply(engine.repositories.reconciliations);
 */

import type { RepositoryInstance } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import type { JournalEntryRepository } from '../types/repositories.js';

export interface FxRealizationPluginOptions {
  /** Repository used to create the balancing FX entry. */
  journalEntries: JournalEntryRepository<Record<string, unknown>>;
  /** Account id for realized FX gains (income). */
  realizedGainAccount: unknown;
  /** Account id for realized FX losses (expense). */
  realizedLossAccount: unknown;
  /** Base/functional currency — FX is computed relative to this. */
  baseCurrency: string;
  /** Multi-tenant org field. */
  orgField?: string;
}

interface MatchHookItem {
  entry: unknown;
  itemIndex: number;
  debit: number;
  credit: number;
  amountCurrency: number | null;
  exchangeRate: number | null;
}

interface MatchHookContext {
  reconciliation: Record<string, unknown>;
  items: MatchHookItem[];
  sharedCurrency: string | null;
  session: ClientSession | null;
}

export function fxRealizationPlugin(options: FxRealizationPluginOptions) {
  const { journalEntries, realizedGainAccount, realizedLossAccount, baseCurrency, orgField } =
    options;

  return {
    name: 'accounting:fx-realization',
    apply(repo: RepositoryInstance) {
      repo.on('after:match', async (ctx: unknown) => {
        const hook = ctx as MatchHookContext;
        const { reconciliation, items, sharedCurrency, session } = hook;

        // Skip if no shared foreign currency or all items carry the same rate.
        if (!sharedCurrency || sharedCurrency === baseCurrency) return;
        const rates = items
          .map((i) => i.exchangeRate)
          .filter((r): r is number => typeof r === 'number' && r > 0);
        if (rates.length < 2) return;
        const allSameRate = rates.every((r) => r === rates[0]);
        if (allSameRate) return;

        // Realized FX = sum(base-currency debit - base-currency credit)
        // Since matching is only approved when the FOREIGN totals net
        // to zero (or within tolerance), any BASE currency imbalance is
        // pure FX.
        const baseNet = items.reduce((sum, it) => sum + it.debit - it.credit, 0);
        if (baseNet === 0) return;

        // baseNet > 0 → ledger gained base currency on settlement → gain
        const gain = baseNet > 0;
        const absAmount = Math.abs(baseNet);

        // The balancing entry debits/credits the matched account vs gain/loss.
        const accountId = (reconciliation as { account: unknown }).account;
        const matchingNumber = (reconciliation as { matchingNumber: string }).matchingNumber;
        const orgId = orgField ? (reconciliation as Record<string, unknown>)[orgField] : undefined;

        // The generated entry is balanced: one side absorbs the FX mismatch
        // on the matched account, the other goes to gain/loss.
        const fxItems = gain
          ? [
              { account: realizedGainAccount, debit: 0, credit: absAmount },
              { account: accountId, debit: absAmount, credit: 0 },
            ]
          : [
              { account: realizedLossAccount, debit: absAmount, credit: 0 },
              { account: accountId, debit: 0, credit: absAmount },
            ];

        const entryData: Record<string, unknown> = {
          journalType: 'MISC',
          state: 'posted',
          date: new Date(),
          label: `FX realization for ${matchingNumber}`,
          journalItems: fxItems,
        };
        if (orgField && orgId != null) entryData[orgField] = orgId;

        const created = await journalEntries.create(
          entryData as Parameters<typeof journalEntries.create>[0],
          { session, _ledgerInternal: 'fxRealize' } as Parameters<typeof journalEntries.create>[1],
        );

        // Stamp the FX entry id onto the reconciliation for audit.
        const reconModel = (
          repo as unknown as {
            Model: {
              updateOne: (
                f: Record<string, unknown>,
                u: Record<string, unknown>,
                o?: Record<string, unknown>,
              ) => Promise<unknown>;
            };
          }
        ).Model;
        await reconModel.updateOne(
          { matchingNumber },
          { $set: { fxRealizationEntry: (created as { _id: unknown })._id } },
          { session: session ?? undefined },
        );
      });
    },
  };
}
