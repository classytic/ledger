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

export type LedgerInternalOp = 'post' | 'unpost' | 'archive' | 'reverseMark';

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
