/**
 * Outbox contract — re-exported from `@classytic/primitives/outbox`.
 *
 * Primitives is the source of truth for the outbox store contract (itself a
 * bit-identical mirror of `@classytic/arc` v2.9's `OutboxStore`). Ledger
 * used to keep a hand-copied duplicate here; that drifted whenever arc
 * evolved. Now we re-export so ledger consumers get the canonical types
 * transitively — `implements OutboxStore` works identically against ledger,
 * primitives, or arc.
 *
 * Ledger does not ship a concrete outbox store. Durability is host policy
 * (see PACKAGE_RULES §5.5) — hosts pass a mongokit 3.8+ repository to arc's
 * `new EventOutbox({ repository })` or implement `OutboxStore` themselves.
 */

export type {
  OutboxAcknowledgeOptions,
  OutboxClaimOptions,
  OutboxErrorInfo,
  OutboxFailOptions,
  OutboxFailureContext,
  OutboxFailureDecision,
  OutboxFailurePolicy,
  OutboxStore,
  OutboxWriteOptions,
} from '@classytic/primitives/outbox';
export {
  InvalidOutboxEventError,
  OutboxOwnershipError,
} from '@classytic/primitives/outbox';
