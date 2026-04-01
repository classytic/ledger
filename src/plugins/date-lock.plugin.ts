/**
 * Date Lock Plugin for @classytic/mongokit
 *
 * Prevents journal entries from being created or posted
 * with a date before a configurable lock date cutoff.
 *
 * More flexible than period-based locks — just a single date.
 */

import type { Model, ClientSession } from 'mongoose';
import type { RepositoryInstance, RepositoryContext } from '@classytic/mongokit';
import { Errors } from '../utils/errors.js';

export interface DateLockPluginOptions {
  /** Async function to resolve the lock date for a given org. Return null for no lock. */
  getLockDate: (orgId?: unknown, session?: ClientSession) => Promise<Date | null>;
  /** Mongoose model for journal entries (needed for partial updates) */
  JournalEntryModel: Model<unknown>;
  /** Org field name */
  orgField?: string;
}

export function dateLockPlugin(options: DateLockPluginOptions) {
  const { getLockDate, JournalEntryModel, orgField } = options;

  return {
    name: 'accounting:date-lock',
    apply(repo: RepositoryInstance) {
      const checkLock = async (context: RepositoryContext, isUpdate: boolean) => {
        const data = context.data;
        if (!data) return;

        // Only check when posting or creating posted entries
        if (data.state !== 'posted') return;

        const session = (context.session ?? null) as ClientSession | null;

        // Resolve the entry date (and org field from persisted doc if needed)
        let entryDate: Date | undefined;
        let persistedDoc: Record<string, unknown> | null = null;

        if (data.date) {
          entryDate = new Date(data.date as string | number | Date);
        } else if (!isUpdate) {
          // Create without explicit date — schema will default to now, so check against now
          entryDate = new Date();
        } else {
          // Partial update without date — fetch the persisted doc
          if (!context.id) {
            throw new Error(
              'dateLockPlugin: update context is missing "id". Cannot validate date lock without document ID.',
            );
          }
          const selectFields = orgField ? `date ${orgField}` : 'date';
          persistedDoc = await JournalEntryModel.findById(context.id)
            .select(selectFields)
            .session(session)
            .lean() as Record<string, unknown> | null;
          if (persistedDoc?.date) {
            entryDate = new Date(persistedDoc.date as string | number | Date);
          }
        }

        if (!entryDate) return; // No date to check against

        // Resolve org value for multi-tenant scoping
        let orgValue: unknown;
        if (orgField) {
          orgValue = data[orgField] ?? context[orgField];

          if (!orgValue && isUpdate) {
            // Org field not in payload or context — resolve from persisted doc
            if (persistedDoc) {
              orgValue = persistedDoc[orgField];
            } else if (context.id) {
              const persisted = await JournalEntryModel.findById(context.id)
                .select(orgField)
                .session(session)
                .lean() as Record<string, unknown> | null;
              if (persisted) orgValue = persisted[orgField];
            }
          }
        }

        const lockDate = await getLockDate(orgValue, session ?? undefined);

        if (!lockDate) return; // No lock configured

        if (entryDate < lockDate) {
          throw Errors.fiscal(
            `Cannot post entry dated ${entryDate.toISOString().split('T')[0]}: ` +
            `date is before lock date ${lockDate.toISOString().split('T')[0]}.`,
          );
        }
      };

      repo.on('before:create', (ctx: RepositoryContext) => checkLock(ctx, false));
      repo.on('before:update', (ctx: RepositoryContext) => checkLock(ctx, true));
    },
  };
}
