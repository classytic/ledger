/**
 * Immutable Guard Plugin (0.9.0)
 *
 * Enforces `config.strictness.immutable === true` at the repository hook
 * layer: any `update` or `delete` targeting a posted entry is rejected
 * unless the caller explicitly sets the `_ledgerInternal` flag.
 *
 * The engine's own state-transition verbs (`post`, `unpost`, `reverse`,
 * `archive`) pass `_ledgerInternal: '<op>'` so they're permitted. Direct
 * `repository.update()` / `repository.delete()` callers have no way to
 * set the flag, so they hit the guard.
 *
 * Before 0.9.0 the `strictness.immutable` config was silently ignored on
 * the update path — only `unpost()` checked it. Flagged by peer review.
 */

import type { PluginFunction, RepositoryContext } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import { ImmutableViolationError } from '../utils/errors.js';

export interface ImmutableGuardOptions {
  /** The JournalEntry Mongoose model, for looking up current state on update. */
  JournalEntryModel: Model<unknown>;
  /** Multi-tenant org field name (if enabled). */
  orgField?: string;
}

type InternalCtx = RepositoryContext & {
  _ledgerInternal?: string;
  data?: Record<string, unknown>;
  id?: unknown;
  query?: Record<string, unknown>;
};

/**
 * Returns a mongokit plugin function. Install only when
 * `config.strictness.immutable === true`.
 */
export function immutableGuardPlugin(options: ImmutableGuardOptions): PluginFunction {
  const { JournalEntryModel, orgField } = options;

  return (repo) => {
    // Block direct updates on posted entries.
    repo.on('before:update', async (ctx: InternalCtx) => {
      // Engine-internal transitions (post/unpost/reverseMark/archive) opt out.
      if (ctx._ledgerInternal) return;

      const id = ctx.id;
      if (!id) return;

      // Look up the current state of the target entry. Use the raw Model to
      // avoid re-entering the repository layer (which would fire this hook
      // again). Scope by org when available.
      const query: Record<string, unknown> = { _id: id };
      if (orgField && ctx.query && orgField in ctx.query) {
        query[orgField] = ctx.query[orgField];
      }
      const current = (await JournalEntryModel.findOne(query).select({ state: 1 }).lean()) as {
        state?: string;
      } | null;

      if (current?.state === 'posted') {
        throw new ImmutableViolationError(id);
      }
    });

    // Block direct deletes on posted entries.
    repo.on('before:delete', async (ctx: InternalCtx) => {
      if (ctx._ledgerInternal) return;
      const id = ctx.id;
      if (!id) return;
      const query: Record<string, unknown> = { _id: id };
      if (orgField && ctx.query && orgField in ctx.query) {
        query[orgField] = ctx.query[orgField];
      }
      const current = (await JournalEntryModel.findOne(query).select({ state: 1 }).lean()) as {
        state?: string;
      } | null;
      if (current?.state === 'posted') {
        throw new ImmutableViolationError(id);
      }
    });
  };
}
