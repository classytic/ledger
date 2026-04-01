/**
 * Fiscal Lock Plugin for @classytic/mongokit
 *
 * Prevents journal entries from being created or posted
 * in a closed fiscal period.
 *
 * Requires a FiscalPeriod model to check against.
 */

import type { Model, ClientSession } from 'mongoose';
import type { RepositoryInstance, RepositoryContext } from '@classytic/mongokit';
import { Errors } from '../utils/errors.js';

export interface FiscalLockPluginOptions {
  /** Mongoose model for fiscal periods */
  FiscalPeriodModel: Model<unknown>;
  /** Mongoose model for journal entries — needed to look up persisted date on partial updates */
  JournalEntryModel?: Model<unknown>;
  /** Organization field name (for multi-tenant) */
  orgField?: string;
}

export function fiscalLockPlugin(options: FiscalLockPluginOptions) {
  const { FiscalPeriodModel, JournalEntryModel, orgField } = options;

  return {
    name: 'accounting:fiscal-lock',
    apply(repo: RepositoryInstance) {
      const checkPeriod = async (context: RepositoryContext, isUpdate: boolean) => {
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
              'fiscalLockPlugin: update context is missing "id". Cannot validate fiscal lock without document ID.',
            );
          }
          if (!JournalEntryModel) {
            throw new Error(
              'fiscalLockPlugin: JournalEntryModel is required to validate partial updates that set state to "posted". ' +
              'Pass JournalEntryModel in plugin options.',
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

        if (!entryDate) return; // No date to check against (new entry without date defaults to draft)

        // Build query
        const query: Record<string, unknown> = {
          startDate: { $lte: entryDate },
          endDate: { $gte: entryDate },
          closed: true,
        };

        // Multi-tenant scope — check payload, context, then persisted doc
        if (orgField) {
          let orgValue = data[orgField] ?? context[orgField];

          if (!orgValue && isUpdate) {
            // Org field not in payload or context — resolve from persisted doc
            if (persistedDoc) {
              orgValue = persistedDoc[orgField];
            } else if (context.id && JournalEntryModel) {
              const persisted = await JournalEntryModel.findById(context.id)
                .select(orgField)
                .session(session)
                .lean() as Record<string, unknown> | null;
              if (persisted) orgValue = persisted[orgField];
            }
          }

          if (!orgValue) {
            throw new Error(
              `fiscalLockPlugin: orgField "${orgField}" is configured but could not be resolved from ` +
              'payload, context, or persisted document. Refusing to run unscoped fiscal period query.',
            );
          }

          query[orgField] = orgValue;
        }

        const closedPeriod = await FiscalPeriodModel.findOne(query).session(session).lean();

        if (closedPeriod) {
          const period = closedPeriod as Record<string, unknown>;
          throw Errors.fiscal(
            `Cannot post entry dated ${entryDate.toISOString().split('T')[0]}: ` +
            `fiscal period "${period.name}" is closed.`,
          );
        }
      };

      repo.on('before:create', (ctx: RepositoryContext) => checkPeriod(ctx, false));
      repo.on('before:update', (ctx: RepositoryContext) => checkPeriod(ctx, true));
    },
  };
}
