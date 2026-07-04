/**
 * `watermarkResolver` — single-date cutoff lock resolver.
 *
 * Suited to "everything up to and including this date is frozen" use
 * cases — daily POS close, simple year-end cutoffs, manually-pinned
 * compliance freezes. The caller supplies an async function that
 * returns the current high-water mark for a given org (or `null` when
 * nothing is locked).
 *
 * Semantics: entries dated strictly after the watermark pass; entries
 * dated on or before the watermark are blocked. This matches the way
 * daily close tracks `lastClosedDate`: "Nov 12 closed" ⇒ anything ≤ Nov 12
 * is frozen, Nov 13+ is open.
 */

import type { ClientSession } from 'mongoose';
import type { LockHit, LockResolver, LockResolverContext } from './types.js';

export interface WatermarkResolverOptions {
  /** Scope identifier, passed through to the resulting `LockHit`. */
  scope: string;
  /**
   * Resolve the current watermark for the given org. Return `null` to
   * mean "no lock in place". The session is forwarded so the lookup
   * can participate in the caller's transaction.
   */
  getWatermark: (
    orgValue: unknown,
    session: ClientSession | null,
  ) => Promise<Date | null> | Date | null;
  /**
   * Optional label override. Defaults to `"through {ISO date}"`.
   */
  formatLabel?: (watermark: Date, ctx: LockResolverContext) => string | undefined;
}

export function watermarkResolver(options: WatermarkResolverOptions): LockResolver {
  const { scope, getWatermark, formatLabel } = options;

  return async (ctx): Promise<LockHit | null> => {
    const watermark = await getWatermark(ctx.orgValue, ctx.session);
    if (!watermark) return null;

    // Entry date strictly after the watermark ⇒ allowed.
    if (ctx.entryDate.getTime() > watermark.getTime()) return null;

    const label =
      formatLabel?.(watermark, ctx) ?? `through ${watermark.toISOString().split('T')[0]}`;

    return { scope, label };
  };
}
