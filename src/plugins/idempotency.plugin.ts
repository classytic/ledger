/**
 * Idempotency Plugin for @classytic/mongokit
 *
 * Prevents duplicate journal entries by checking for existing entries
 * with the same idempotency key before creation.
 */

import type { Model, ClientSession } from 'mongoose';
import type { RepositoryInstance, RepositoryContext } from '@classytic/mongokit';
import { Errors } from '../utils/errors.js';

export interface IdempotencyPluginOptions {
  /** Mongoose model for journal entries */
  JournalEntryModel: Model<unknown>;
  /** Multi-tenant org field name */
  orgField?: string;
}

export function idempotencyPlugin(options: IdempotencyPluginOptions) {
  const { JournalEntryModel, orgField } = options;

  return {
    name: 'accounting:idempotency',
    apply(repo: RepositoryInstance) {
      repo.on('before:create', async (context: RepositoryContext) => {
        const data = context.data;
        if (!data?.idempotencyKey) return;

        const query: Record<string, unknown> = {
          idempotencyKey: data.idempotencyKey,
        };
        if (orgField && data[orgField]) {
          query[orgField] = data[orgField];
        }

        const existing = await JournalEntryModel.findOne(query)
          .select('_id')
          .session((context.session ?? null) as ClientSession | null)
          .lean() as Record<string, unknown> | null;

        if (existing) {
          throw Errors.conflict(
            `Duplicate idempotency key: "${data.idempotencyKey}". Existing entry: ${existing._id}`,
          );
        }
      });
    },
  };
}
