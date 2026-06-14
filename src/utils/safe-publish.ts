import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { ClientSession } from 'mongoose';
import { createEvent } from '../events/helpers.js';
import type { OutboxStore } from '../events/outbox-store.js';
import { defaultLogger, type Logger } from './logger.js';

export interface SafePublishContext {
  actorId?: unknown;
  organizationId?: unknown;
  session?: ClientSession | null;
}

export interface SafePublishMeta {
  resource?: string;
  resourceId?: string;
}

/**
 * Persist and publish a ledger domain event (PACKAGE_RULES §P8).
 *
 * Non-negotiable propagation contract:
 *   - The outbox row is saved FIRST (durability), inside the caller's
 *     mongoose session, and a save failure MUST PROPAGATE. The transactional
 *     outbox's whole correctness argument is "business write + event row
 *     commit atomically": when `ctx.session` is live, the throw rolls the
 *     enclosing transaction back; without a session the verb still fails
 *     loudly rather than silently dropping a durable event. A logged-and-
 *     swallowed save would land the ledger write while the event vanished and
 *     the host relay never knew — unacceptable for financial events.
 *   - The transport publish runs SECOND (in-process subscribers) and its
 *     failures ARE swallowed (logged) — the host-side relay re-delivers from
 *     the durable outbox row, so a transient transport blip must not break
 *     the mutation.
 */
export async function safePublish(
  events: EventTransport | undefined,
  outboxStore: OutboxStore | undefined,
  type: string,
  payload: unknown,
  ctx?: SafePublishContext,
  meta?: SafePublishMeta,
  logger: Logger = defaultLogger,
): Promise<void> {
  const event: DomainEvent = createEvent(type, payload, ctx, meta);

  if (outboxStore) {
    try {
      await outboxStore.save(event, { session: ctx?.session ?? undefined });
    } catch (err) {
      logger.error(`safePublish: outbox.save failed for ${type}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // P8: MUST propagate — the caller's transaction must roll back so the
      // ledger write and the durable event commit atomically (or not at all).
      throw err;
    }
  }

  if (events) {
    try {
      await events.publish(event);
    } catch (err) {
      // Swallow — the host relay re-delivers from the durable outbox row.
      logger.error(`safePublish: transport publish failed for ${type}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
