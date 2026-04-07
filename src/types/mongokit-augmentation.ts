/**
 * Module augmentation for `@classytic/mongokit`.
 *
 * Ledger's state-transition methods (post, unpost, archive, reverseMark) tag
 * their `repository.update()` call with a `_ledgerInternal` flag so the
 * double-entry immutability guard can distinguish legitimate transitions from
 * arbitrary edits. This file types that flag onto both `RepositoryContext`
 * (what plugins observe) and `SessionOptions` (what callers pass) so consumers
 * and plugin authors get full IntelliSense without casts.
 *
 * This file is side-effect only — importing it anywhere in the package is
 * enough to activate the augmentation. `src/types/index.ts` re-exports it.
 */

/**
 * Internal op tags attached to `repository.update()` / `repository.create()`
 * calls that the ledger itself initiates. Plugins observing the
 * `before:update` / `before:create` hooks can read `context._ledgerInternal`
 * to identify legitimate engine operations and skip guards accordingly.
 *
 * - `post` / `unpost` / `archive`  — state transitions on an entry
 * - `reverseMark`                  — marking an original as reversed
 *                                    (exempt from fiscal/daily locks)
 * - `fxRealize`                    — FX realization plugin balancing entry
 *                                    (exempt from all locks and credit-limit)
 *
 * Tax-specific internal ops (e.g. cash-basis exigibility realization) live
 * in their respective tax packages and are not part of the ledger core.
 */
export type LedgerInternalOp = 'post' | 'unpost' | 'archive' | 'reverseMark' | 'fxRealize';

declare module '@classytic/mongokit' {
  interface RepositoryContext {
    /**
     * Set by ledger's repository methods (post, unpost, archive, reverseMark)
     * to signal a legitimate internal state transition. Plugins observing
     * `before:update` can read this to distinguish from arbitrary edits.
     *
     * External `repository.update()` callers cannot spoof this flag because
     * it is only set by ledger's own repo methods, never surfaced in the
     * public API.
     */
    _ledgerInternal?: LedgerInternalOp;
  }

  interface SessionOptions {
    /**
     * Ledger-internal flag — see `RepositoryContext._ledgerInternal`.
     * Typed here so ledger's repo methods can pass it without casts.
     * Consumers should never set this directly.
     */
    _ledgerInternal?: LedgerInternalOp;
  }
}
