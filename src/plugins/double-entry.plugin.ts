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
    for (let i = 0; i < items.length; i++) {
      const d = items[i].debit ?? 0;
      const c = items[i].credit ?? 0;
      if (d > 0 && c > 0) {
        throw Errors.validation(
          `Invalid journal item at index ${i}: a line cannot have both debit (${d}) and credit (${c}) greater than zero.`,
        );
      }
      if (d === 0 && c === 0) {
        throw Errors.validation(
          `Invalid journal item at index ${i}: a line cannot have both debit and credit equal to zero.`,
        );
      }
    }

    const totalDebit = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    const totalCredit = items.reduce((s, i) => s + (i.credit ?? 0), 0);

    // Integer cents — exact comparison, no floating-point drift possible.
    if (totalDebit !== totalCredit) {
      throw Errors.validation(
        `Double-entry violation: debits (${totalDebit}) ≠ credits (${totalCredit}). ` +
          `Difference: ${Math.abs(totalDebit - totalCredit)}`,
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
        const accountIds = items.map((i) => i.account).filter((a) => a != null && a !== '');

        if (accountIds.length === 0) {
          throw Errors.validation('Posted entry has items with missing accounts.');
        }

        const selectFields = orgField ? `_id ${orgField}` : '_id';
        const accounts = (await AccountModel?.find({ _id: { $in: accountIds } })
          .select(selectFields)
          .session((context.session as ClientSession) ?? null)
          .lean()) as Array<Record<string, unknown>>;

        // Check all accounts exist
        const foundIds = new Set(accounts.map((a) => String(a._id)));
        const missingCount = accountIds.filter((id) => !foundIds.has(String(id))).length;
        if (missingCount > 0) {
          throw Errors.validation(`${missingCount} item(s) reference non-existent accounts.`);
        }

        // Check tenant scoping
        if (orgField && data[orgField] != null) {
          const dataOrg = String(data[orgField]);
          const crossTenant = accounts.filter((a) => String(a[orgField]) !== dataOrg);
          if (crossTenant.length > 0) {
            throw Errors.validation(
              `${crossTenant.length} item(s) reference accounts from another organization.`,
            );
          }
        }
      };

      const validateUpdate = async (context: RepositoryContext) => {
        const data = context.data;
        if (!data) return;

        // ── Immutability guard: block modifications to posted entries ──────
        // Allow: idempotent state re-set (state: 'posted')
        // Block: everything else — including reversed/reversedBy (only settable via
        //        reverse() which uses entry.save() directly, bypassing this hook)
        if (JournalEntryModel) {
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
              // reversed/reversedBy are NOT allowed through repository.update() —
              // reverse() uses entry.save() directly to bypass the plugin, so any
              // attempt to set these flags through the generic update path is illegitimate.
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
