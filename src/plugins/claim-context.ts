/**
 * Claim-context helpers for ledger plugins (0.10.6+).
 *
 * `repo.claim()` from mongokit 3.13 fires `before:claim` with a context
 * that carries:
 *   - `data`        — operator-form update payload (`{ $set: {...} }`)
 *   - `transition`  — the original `{ from, to, where, field? }` spec
 *   - `id`, `query`, `session`, etc.
 *
 * Existing ledger plugins (double-entry, lock, immutable-guard) were
 * authored for `before:update`'s flat data shape (`{ state, journalItems,
 * ... }`). To extend their coverage to `claim` without forking every
 * plugin's validation logic, we synthesize a flat view from the claim
 * context that mirrors the update shape.
 *
 * The plugins call these helpers from a `before:claim` listener, then
 * invoke their existing per-update validators on the flattened context.
 *
 * Without this, `repo.claim()` slips past every hand-rolled `before:update`
 * plugin in the package — fiscal-lock checks would not fire on
 * draft → posted CAS transitions, etc.
 */

import type { RepositoryContext } from '@classytic/mongokit';

/** Extra fields mongokit's claim builder attaches to the hook context. */
export interface ClaimContextExtras {
  data?: { $set?: Record<string, unknown> } & Record<string, unknown>;
  transition?: {
    from?: unknown | readonly unknown[];
    to?: unknown;
    field?: string;
    where?: Record<string, unknown>;
  };
}

/** Concrete claim-hook context shape — RepositoryContext + claim extras. */
export type ClaimRepositoryContext = RepositoryContext & ClaimContextExtras;

/**
 * Synthesize a flat data view from a claim context, matching the shape
 * that `before:update` listeners expect (`{ state, ...patchFields }`).
 *
 * - Pulls `$set` from the operator-form patch and treats those as flat
 *   fields.
 * - Adds the target state from `transition.to` so update-shaped checks
 *   like `data.state === 'posted'` work unchanged.
 * - For state-noop transitions (`from === to`), `transition.to` is the
 *   current state — same value gets written, callers see it as a "stamp"
 *   on a posted entry.
 */
export function flattenClaimData(ctx: ClaimRepositoryContext): Record<string, unknown> {
  const $set = (ctx.data?.$set ?? {}) as Record<string, unknown>;
  const flat: Record<string, unknown> = { ...$set };
  const stateField = ctx.transition?.field ?? 'state';
  const target = ctx.transition?.to;
  if (target !== undefined && flat[stateField] === undefined) {
    flat[stateField] = target;
  }
  return flat;
}

/**
 * Detect the `reverseMark` claim shape — the state-noop CAS used to stamp
 * `reversed: true` on the original entry during `reverse()`.
 *
 * Lock plugins exempt this transition (the original entry's date can sit
 * inside a closed period; the new counter-entry on the reversal date is
 * subject to lock checks independently).
 */
export function isReverseMarkClaim(ctx: ClaimRepositoryContext): boolean {
  const t = ctx.transition;
  if (!t) return false;
  if (t.from !== 'posted' || t.to !== 'posted') return false;
  // The reverse() helper uses `where: { reversed: { $ne: true } }` as the
  // race guard. Fingerprint: that predicate AND a `reversed: true` $set.
  const where = t.where ?? {};
  const reversedGuard = where.reversed as { $ne?: unknown } | undefined;
  if (!reversedGuard || reversedGuard.$ne !== true) return false;
  const $set = (ctx.data?.$set ?? {}) as Record<string, unknown>;
  return $set.reversed === true;
}
