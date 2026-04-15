/**
 * OutboxStore — host-owned durable event persistence (structurally compatible
 * with `@classytic/arc`'s `OutboxStore`).
 *
 * Copied shape, not import — same pattern as `EventTransport`. A host running
 * arc passes its arc-backed `MongoOutboxStore` directly; non-arc hosts
 * implement the 4 required methods against whatever DB they already own.
 *
 * See arc: packages/arc/src/events/outbox.ts (lines 73-293) for the reference
 * semantics documentation. Keep this file field-for-field identical with arc's
 * definitions so structural typing makes them interchangeable.
 *
 * **Ledger does not ship a concrete MongoOutboxStore.** Package-owned outbox
 * storage is an anti-pattern per PACKAGE_RULES §5.5. Durability is host policy.
 */

import type { DomainEvent } from './transport.js';

/** Options passed to `OutboxStore.save` for richer write semantics. */
export interface OutboxWriteOptions {
  /** Host-provided DB session/transaction handle for atomic writes. */
  readonly session?: unknown;
  /** Earliest time the event should be visible to relay workers. */
  readonly visibleAt?: Date;
  /** Idempotency key — stores that support it should dedupe on this. */
  readonly dedupeKey?: string;
  /** Partition/routing key for sharded transports (Kafka, Redis Streams). */
  readonly partitionKey?: string;
  /** Arbitrary headers propagated to the transport layer. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options for lease-based work claim. */
export interface OutboxClaimOptions {
  readonly limit?: number;
  readonly consumerId?: string;
  readonly leaseMs?: number;
  readonly types?: readonly string[];
}

/** Options for `OutboxStore.acknowledge`. */
export interface OutboxAcknowledgeOptions {
  readonly consumerId?: string;
}

/** Options for `OutboxStore.fail`. */
export interface OutboxFailOptions {
  readonly consumerId?: string;
  readonly retryAt?: Date;
  readonly deadLetter?: boolean;
}

/** Normalized error info passed to `OutboxStore.fail`. */
export interface OutboxErrorInfo {
  readonly message: string;
  readonly code?: string;
}

/**
 * Thrown by a store when `acknowledge` / `fail` is called by a consumer that
 * does not own the event's current lease.
 */
export class OutboxOwnershipError extends Error {
  readonly eventId: string;
  readonly attemptedBy: string;
  readonly currentOwner: string | null;

  constructor(eventId: string, attemptedBy: string, currentOwner: string | null) {
    super(
      `Outbox ownership mismatch for event "${eventId}": attempted by "${attemptedBy}", ` +
        `current owner is "${currentOwner ?? 'none'}". ` +
        `The lease may have expired and been reclaimed by another worker.`,
    );
    this.name = 'OutboxOwnershipError';
    this.eventId = eventId;
    this.attemptedBy = attemptedBy;
    this.currentOwner = currentOwner;
  }
}

/**
 * Durable storage contract for the transactional outbox pattern.
 *
 * **Required**: `save`, `getPending`, `acknowledge`.
 * **Optional** (stores opt-in): `claimPending`, `fail`, `purge`.
 *
 * Structurally identical to arc's `OutboxStore` — assignable in both
 * directions via TypeScript structural typing.
 */
export interface OutboxStore {
  /**
   * Save event to outbox (typically inside a business transaction via `options.session`).
   * MUST reject events missing `type` or `meta.id` — throw rather than persist.
   */
  save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void>;

  /**
   * Get pending (unrelayed) events, FIFO ordered.
   * Multi-worker deployments should prefer `claimPending` if supported.
   */
  getPending(limit: number): Promise<DomainEvent[]>;

  /**
   * Atomically claim pending events with a lease.
   * Two concurrent callers MUST never receive overlapping events.
   */
  claimPending?(options?: OutboxClaimOptions): Promise<DomainEvent[]>;

  /**
   * Mark event as successfully relayed. Unknown eventId is a no-op (idempotent).
   * Ownership mismatch MUST throw `OutboxOwnershipError`.
   */
  acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void>;

  /**
   * Record a relay failure. Enables retry scheduling and dead-letter flow.
   * Ownership mismatch MUST throw `OutboxOwnershipError`.
   */
  fail?(eventId: string, error: OutboxErrorInfo, options?: OutboxFailOptions): Promise<void>;

  /** Purge old delivered events (older than `olderThanMs`). Returns count. */
  purge?(olderThanMs: number): Promise<number>;
}
