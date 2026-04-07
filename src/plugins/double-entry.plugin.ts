/**
 * Double-Entry Validation Plugin for @classytic/mongokit
 *
 * Ensures every journal entry posted via the repository satisfies:
 *   sum(debits) === sum(credits)
 *
 * Plugs into the before:create and before:update hooks.
 */

import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
// Side-effect import: activates the `_ledgerInternal` typing on
// RepositoryContext so this plugin can read the flag without casts.
import '../types/mongokit-augmentation.js';
import { Errors } from '../utils/errors.js';

export interface DoubleEntryPluginOptions {
  /** Only enforce on posted entries (default: true) */
  onlyOnPost?: boolean;
  /** Mongoose model — required to validate partial updates that only set state */
  JournalEntryModel?: Model<unknown>;
  /** Account model — when provided, posted creates verify account existence + tenant scoping */
  AccountModel?: Model<unknown>;
  /** Multi-tenant org field name (e.g. 'business'). Required for tenant-account integrity checks. */
  orgField?: string;
}

export function doubleEntryPlugin(options: DoubleEntryPluginOptions = {}) {
  const { onlyOnPost = true, JournalEntryModel, AccountModel, orgField } = options;

  function validateItems(
    items: Array<{ debit?: number; credit?: number }>,
    data: Record<string, unknown>,
  ): void {
    // Each line must be debit OR credit (not both), and cannot be zero-value
    const lineErrors: Array<{ path: string; issue: string; value?: unknown }> = [];
    for (let i = 0; i < items.length; i++) {
      const d = items[i].debit ?? 0;
      const c = items[i].credit ?? 0;
      if (d > 0 && c > 0) {
        lineErrors.push({
          path: `journalItems.${i}`,
          issue: 'line cannot have both debit and credit greater than zero',
          value: { debit: d, credit: c },
        });
      }
      if (d === 0 && c === 0) {
        lineErrors.push({
          path: `journalItems.${i}`,
          issue: 'line cannot have both debit and credit equal to zero',
          value: { debit: 0, credit: 0 },
        });
      }
    }
    if (lineErrors.length > 0) {
      throw Errors.validation(
        `Invalid journal line(s): ${lineErrors.map((e) => `${e.path} — ${e.issue}`).join('; ')}`,
        lineErrors,
      );
    }

    const totalDebit = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    const totalCredit = items.reduce((s, i) => s + (i.credit ?? 0), 0);

    // Integer cents — exact comparison, no floating-point drift possible.
    if (totalDebit !== totalCredit) {
      throw Errors.validation(
        `Double-entry violation: debits (${totalDebit}) ≠ credits (${totalCredit}). ` +
          `Difference: ${Math.abs(totalDebit - totalCredit)}`,
        [
          {
            path: 'journalItems',
            issue: 'debits must equal credits',
            value: { totalDebit, totalCredit, difference: totalDebit - totalCredit },
          },
        ],
      );
    }

    // Sync totals onto the data object
    data.totalDebit = totalDebit;
    data.totalCredit = totalCredit;
  }

  return {
    name: 'accounting:double-entry',
    apply(repo: RepositoryInstance) {
      const validate = async (context: RepositoryContext) => {
        const data = context.data;
        if (!data) return;

        // Skip draft entries if configured
        if (onlyOnPost && data.state !== 'posted') return;

        const items = data.journalItems as
          | Array<{ debit?: number; credit?: number; account?: unknown }>
          | undefined;

        // Posted entries must have at least 2 journal items
        if (data.state === 'posted' && (!items || items.length < 2)) {
          throw Errors.validation(
            `Cannot post entry: at least 2 journal items required, got ${items?.length ?? 0}.`,
          );
        }

        if (!items || items.length === 0) return;

        validateItems(items, data);

        // Account existence + tenant-account integrity (fail-closed for posted creates)
        if (data.state === 'posted') {
          if (!AccountModel) {
            throw new Error(
              'doubleEntryPlugin: AccountModel is required to validate posted entries. ' +
                'Pass AccountModel in plugin options to enable account existence and tenant integrity checks.',
            );
          }
          await validateAccounts(items, data, context);
        }
      };

      /** Verify all journal item accounts exist and belong to the same org */
      const validateAccounts = async (
        items: Array<{ account?: unknown }>,
        data: Record<string, unknown>,
        context: RepositoryContext,
      ) => {
        const missingIdxs: number[] = [];
        items.forEach((item, idx) => {
          if (item.account == null || item.account === '') missingIdxs.push(idx);
        });
        if (missingIdxs.length > 0) {
          throw Errors.validation(
            `Posted entry has items with missing accounts at index(es): ${missingIdxs.join(', ')}.`,
            missingIdxs.map((i) => ({
              path: `journalItems.${i}.account`,
              issue: 'account is required on posted entries',
            })),
          );
        }

        const accountIds = items.map((i) => i.account);
        const selectFields = orgField ? `_id ${orgField}` : '_id';
        const accounts = (await AccountModel?.find({ _id: { $in: accountIds } })
          .select(selectFields)
          .session((context.session as ClientSession) ?? null)
          .lean()) as Array<Record<string, unknown>>;

        // Check all accounts exist
        const foundIds = new Set(accounts.map((a) => String(a._id)));
        const missingFieldErrors: Array<{ path: string; issue: string; value?: unknown }> = [];
        items.forEach((item, idx) => {
          if (!foundIds.has(String(item.account))) {
            missingFieldErrors.push({
              path: `journalItems.${idx}.account`,
              issue: 'account does not exist',
              value: item.account,
            });
          }
        });
        if (missingFieldErrors.length > 0) {
          throw Errors.validation(
            `${missingFieldErrors.length} item(s) reference non-existent accounts.`,
            missingFieldErrors,
          );
        }

        // Check tenant scoping
        if (orgField && data[orgField] != null) {
          const dataOrg = String(data[orgField]);
          const accountOrgById = new Map(
            accounts.map((a) => [String(a._id), String(a[orgField])] as const),
          );
          const crossTenantFieldErrors: Array<{ path: string; issue: string; value?: unknown }> =
            [];
          items.forEach((item, idx) => {
            const acctOrg = accountOrgById.get(String(item.account));
            if (acctOrg !== undefined && acctOrg !== dataOrg) {
              crossTenantFieldErrors.push({
                path: `journalItems.${idx}.account`,
                issue: 'account belongs to another organization',
                value: { account: item.account, expectedOrg: dataOrg, actualOrg: acctOrg },
              });
            }
          });
          if (crossTenantFieldErrors.length > 0) {
            throw Errors.validation(
              `${crossTenantFieldErrors.length} item(s) reference accounts from another organization.`,
              crossTenantFieldErrors,
            );
          }
        }
      };

      const validateUpdate = async (context: RepositoryContext) => {
        const data = context.data;
        if (!data) return;

        // ── Immutability guard: block modifications to posted entries ──────
        // Repository state-transition methods (post, unpost, archive) tag the
        // update context with `_ledgerInternal` so this guard can distinguish
        // legitimate transitions from arbitrary edits. External callers using
        // repository.update() directly cannot set this flag — the contract is
        // preserved for them.
        const internalOp = context._ledgerInternal;

        if (JournalEntryModel && !internalOp) {
          const id = context.id;
          if (id) {
            // Check if target entry is already posted
            const target = (await JournalEntryModel.findById(id)
              .select('state')
              .session((context.session as ClientSession) ?? null)
              .lean()) as Record<string, unknown> | null;

            if (target?.state === 'posted') {
              // Block any state transition away from 'posted' (immutable ledger)
              if (data.state !== undefined && data.state !== 'posted') {
                throw Errors.immutable(
                  'Cannot change state of a posted journal entry. Posted entries are immutable.',
                );
              }

              // Only allow idempotent state re-set on posted entries.
              const allowedKeys = new Set(['state']);
              const dataKeys = Object.keys(data);
              const hasDisallowedKeys = dataKeys.some((k) => !allowedKeys.has(k));

              if (hasDisallowedKeys) {
                throw Errors.immutable(
                  'Cannot modify a posted journal entry. Use reverse() to create a correcting entry instead.',
                );
              }
            }
          }
        }

        if (onlyOnPost && data.state !== 'posted') return;

        const items = data.journalItems as Array<{ debit?: number; credit?: number }> | undefined;

        if (items !== undefined) {
          // Items present in payload — validate directly
          if (items.length < 2) {
            throw Errors.validation(
              `Cannot post entry: at least 2 journal items required, got ${items.length}.`,
            );
          }
          validateItems(items, data);

          // Account existence + tenant-account integrity (when AccountModel provided)
          if (AccountModel) {
            await validateAccounts(items as Array<{ account?: unknown }>, data, context);
          }
          return;
        }

        // state → posted but no journalItems in payload: fetch the persisted doc
        if (!JournalEntryModel) {
          throw new Error(
            'doubleEntryPlugin: JournalEntryModel is required to validate partial updates that set state to "posted". ' +
              'Pass JournalEntryModel in plugin options.',
          );
        }

        const id = context.id;
        if (!id) {
          throw new Error(
            'doubleEntryPlugin: update context is missing "id". Cannot validate partial post without document ID.',
          );
        }

        const existing = (await JournalEntryModel.findById(id)
          .select('journalItems')
          .session((context.session as ClientSession) ?? null)
          .lean()) as Record<string, unknown> | null;

        if (!existing) return; // will 404 downstream

        const persistedItems = existing.journalItems as
          | Array<{ debit?: number; credit?: number; account?: unknown }>
          | undefined;
        if (!persistedItems || persistedItems.length < 2) {
          throw Errors.validation(
            `Cannot post entry: at least 2 journal items required, got ${persistedItems?.length ?? 0}.`,
          );
        }

        validateItems(persistedItems, data);

        // Account existence + tenant-account integrity (when AccountModel provided)
        if (AccountModel) {
          await validateAccounts(persistedItems, { ...data, ...existing }, context);
        }
      };

      repo.on('before:create', validate);
      repo.on('before:update', validateUpdate);
    },
  };
}
