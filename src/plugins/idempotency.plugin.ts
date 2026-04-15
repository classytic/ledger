/**
 * Idempotency Plugin for @classytic/mongokit
 *
 * Prevents duplicate journal entries by checking for existing entries
 * with the same idempotency key before creation.
 */

import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
import { Errors, IdempotencyConflictError } from '../utils/errors.js';

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

        const existing = (await JournalEntryModel.findOne(query)
          .select('_id')
          .session((context.session ?? null) as ClientSession | null)
          .lean()) as Record<string, unknown> | null;

        if (existing) {
          // 0.9.0: throw a typed error that the repository's race-safe
          // `create()` wrapper catches and re-reads the winner, so concurrent
          // losers never see a raw dup-key error. Pre-0.9 callers that
          // bypass the wrapper still get an AccountingError subclass with
          // `code: 'IDEMPOTENCY_CONFLICT'` they can type-check.
          throw new IdempotencyConflictError(data.idempotencyKey as string, existing._id);
        }
      });

      repo.on('before:createMany', async (context: RepositoryContext) => {
        const docs = context.dataArray as Array<Record<string, unknown>> | undefined;
        if (!docs || docs.length === 0) return;

        const keys = docs
          .map((d) => d.idempotencyKey as string | undefined)
          .filter((k): k is string => !!k);
        if (keys.length === 0) return;

        // Batch lookup — single query for all keys
        const query: Record<string, unknown> = {
          idempotencyKey: { $in: keys },
        };
        // Use org scope from the first doc (all docs in a batch share the same org)
        const firstOrg = orgField && docs[0]?.[orgField];
        if (orgField && firstOrg) {
          query[orgField] = firstOrg;
        }

        const existingDocs = (await JournalEntryModel.find(query)
          .select('idempotencyKey')
          .session((context.session ?? null) as ClientSession | null)
          .lean()) as Array<Record<string, unknown>>;

        if (existingDocs.length > 0) {
          const existingKeys = existingDocs.map((d) => d.idempotencyKey);
          throw Errors.conflict(
            `Duplicate idempotency keys: ${existingKeys.join(', ')}. ` +
              `${existingDocs.length} entries already exist.`,
          );
        }
      });
    },
  };
}
