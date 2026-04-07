/**
 * Credit Limit Plugin (0.6.0)
 *
 * Enforces a per-partner outstanding A/R limit on the create path.
 * Hooks `before:create` on the journal entry repository, finds any
 * journal item that *increases* the partner's outstanding balance on
 * the configured A/R control account, sums the partner's existing
 * open items, adds the prospective new exposure, and throws
 * `AccountingError(402, 'CREDIT_LIMIT_EXCEEDED')` if the partner's
 * `getCreditLimit` callback returns a smaller cap.
 *
 * "Increases the outstanding balance" = a debit on the A/R control
 * account (sale on credit). Credits to A/R (cash receipts, credit
 * notes) reduce exposure and are exempt.
 *
 * The same plugin works on the A/P side if you flip the semantics:
 * pass the A/P account and have the consumer treat "credit limit" as
 * a max-payable-to-supplier policy. Most consumers only enable it on
 * A/R; this is the canonical use.
 *
 * Lock exemptions:
 *   - `_ledgerInternal === 'reverseMark'` → reversal of an existing
 *     overdue invoice should not be blocked
 *   - `_ledgerInternal === 'fxRealize'`   → FX revaluation entries
 *
 * The plugin reads `journalItems[].partnerId` (or whatever
 * `partnerField` you configure) — the same field the partner ledger
 * report and `getOpenItems({filter})` use.
 */

import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
import { AccountingError, Errors } from '../utils/errors.js';

export interface CreditLimitPluginOptions {
  /** The A/R control account that this limit guards. */
  arControlAccountId: unknown;
  /**
   * Resolve the partner's credit limit in cents. Return `null` for
   * "no limit" (skip the check), `0` for "cash-only customer".
   */
  getCreditLimit: (
    partnerId: unknown,
    session: ClientSession | null,
  ) => Promise<number | null> | number | null;
  /** Field name for the partner ref on each journal item. Default: `'partnerId'`. */
  partnerField?: string;
  /** JournalEntry model — required to sum existing exposure. */
  JournalEntryModel: Model<unknown>;
  /** Multi-tenant scope field. */
  orgField?: string;
  /**
   * Optional tolerance in cents — allow up to N cents over the limit.
   * Defaults to 0 (strict).
   */
  toleranceCents?: number;
}

interface JournalItemSnapshot {
  account: unknown;
  debit?: number;
  credit?: number;
  [key: string]: unknown;
}

export function creditLimitPlugin(options: CreditLimitPluginOptions) {
  const {
    arControlAccountId,
    getCreditLimit,
    partnerField = 'partnerId',
    JournalEntryModel,
    orgField,
    toleranceCents = 0,
  } = options;

  const arControlStr = String(arControlAccountId);

  return {
    name: 'accounting:credit-limit',
    apply(repo: RepositoryInstance) {
      repo.on('before:create', async (context: RepositoryContext) => {
        const data = context.data as Record<string, unknown> | undefined;
        if (!data) return;

        // Internal entries (reversals, FX, cash-basis moves) are exempt.
        if (context._ledgerInternal) return;

        // Only enforce on entries that will actually post (or are already
        // being created posted). Drafts can hold any amount.
        if (data.state !== 'posted') return;

        const items = (data.journalItems as JournalItemSnapshot[] | undefined) ?? [];
        if (items.length === 0) return;

        const session = (context.session ?? null) as ClientSession | null;

        // Group prospective debits to the A/R control account by partner.
        const newExposureByPartner = new Map<string, number>();
        for (const item of items) {
          if (String(item.account) !== arControlStr) continue;
          const debit = item.debit ?? 0;
          const credit = item.credit ?? 0;
          const delta = debit - credit;
          if (delta <= 0) continue; // credits to A/R reduce exposure
          const partner = item[partnerField];
          if (partner == null) {
            throw Errors.validation(
              `creditLimitPlugin: A/R item missing required "${partnerField}" — every credit-sale line must carry a partner reference.`,
            );
          }
          const key = String(partner);
          newExposureByPartner.set(key, (newExposureByPartner.get(key) ?? 0) + delta);
        }

        if (newExposureByPartner.size === 0) return;

        // For each partner, sum existing open A/R + add the new exposure
        // and compare against the limit.
        for (const [partnerKey, newDelta] of newExposureByPartner) {
          const limit = await getCreditLimit(partnerKey, session);
          if (limit == null) continue; // null = no limit configured

          // Sum existing open items via aggregate — single round trip per partner.
          const orgFilter: Record<string, unknown> = {};
          if (orgField && context[orgField] != null) {
            orgFilter[orgField] = (context as Record<string, unknown>)[orgField];
          } else if (orgField && (data as Record<string, unknown>)[orgField] != null) {
            orgFilter[orgField] = (data as Record<string, unknown>)[orgField];
          }

          const pipeline: Array<Record<string, unknown>> = [
            { $match: { state: 'posted', ...orgFilter } },
            { $unwind: '$journalItems' },
            {
              $match: {
                'journalItems.account': arControlAccountId,
                [`journalItems.${partnerField}`]: partnerKey,
                $or: [
                  { 'journalItems.matchingNumber': null },
                  { 'journalItems.matchingNumber': { $exists: false } },
                ],
              },
            },
            {
              $group: {
                _id: null,
                outstanding: {
                  $sum: {
                    $subtract: [
                      { $ifNull: ['$journalItems.debit', 0] },
                      { $ifNull: ['$journalItems.credit', 0] },
                    ],
                  },
                },
              },
            },
          ];

          const result = (await JournalEntryModel.aggregate(
            pipeline as unknown as Parameters<typeof JournalEntryModel.aggregate>[0],
          ).session(session)) as Array<{ outstanding?: number }>;
          const currentOutstanding = result[0]?.outstanding ?? 0;
          const projected = currentOutstanding + newDelta;

          if (projected > limit + toleranceCents) {
            throw new AccountingError(
              `Credit limit exceeded for partner ${partnerKey}: projected ${projected}c > limit ${limit}c (current ${currentOutstanding}c + new ${newDelta}c).`,
              402,
              'CREDIT_LIMIT_EXCEEDED',
              [
                { path: partnerField, issue: 'over credit limit', value: partnerKey },
                { path: 'limit', issue: 'partner credit limit in cents', value: limit },
                {
                  path: 'currentOutstanding',
                  issue: 'existing open A/R in cents',
                  value: currentOutstanding,
                },
                { path: 'newExposure', issue: 'new debit being posted in cents', value: newDelta },
              ],
            );
          }
        }
      });
    },
  };
}
