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
import { type ClaimRepositoryContext, isReverseMarkClaim } from './claim-context.js';

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

    // ── before:claim — block claims that try to leave `posted` ─────────
    //
    // In strict mode, posted entries are append-only audit records — the
    // only way to correct one is `reverse()`, which creates a counter-
    // entry. Without this hook, a host calling `repo.claim(id, { from:
    // 'posted', to: 'draft' })` directly would unpost an immutable entry,
    // bypassing the `unpost()` strictness check.
    //
    // Reverse-mark is exempt — it's a state-noop (`from === to ===
    // 'posted'`) with a `reversed: { $ne: true }` race guard; the
    // mutation is already constrained to the legitimate audit-trail
    // fingerprint (reversed/reversedBy/reversedByUser fields).
    repo.on('before:claim', async (rawCtx: RepositoryContext) => {
      const ctx = rawCtx as ClaimRepositoryContext & InternalCtx;
      if (ctx._ledgerInternal) return;
      if (isReverseMarkClaim(ctx)) return;

      const transition = ctx.transition;
      if (!transition) return;
      const stateField = transition.field ?? 'state';
      if (stateField !== 'state') return;

      // Determine if the transition's `from` set includes 'posted'. When
      // it does, the caller is asking to leave (or stay-on) posted via a
      // direct claim — refuse in strict mode unless this is the exempt
      // reverse-mark shape (handled above).
      const fromSpec = transition.from;
      const fromIncludesPosted = Array.isArray(fromSpec)
        ? fromSpec.includes('posted')
        : fromSpec === 'posted';
      if (!fromIncludesPosted) return;

      // `from === to === 'posted'` with a non-reverse-mark patch reaches
      // here too — block it; arbitrary stamping on posted entries violates
      // the audit-trail contract.
      throw new ImmutableViolationError(ctx.id);
    });
  };
}
