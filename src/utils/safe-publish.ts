import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { ClientSession } from 'mongoose';
import { createEvent } from '../events/helpers.js';
import type { OutboxStore } from '../events/outbox-store.js';

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
 * Persist and publish a ledger domain event without letting delivery failures
 * break the write path. When an outbox is configured, the outbox row is saved
 * first and participates in the caller's mongoose session.
 */
export async function safePublish(
  events: EventTransport | undefined,
  outboxStore: OutboxStore | undefined,
  type: string,
  payload: unknown,
  ctx?: SafePublishContext,
  meta?: SafePublishMeta,
): Promise<void> {
  const event: DomainEvent = createEvent(type, payload, ctx, meta);

  if (outboxStore) {
    try {
      await outboxStore.save(event, { session: ctx?.session ?? undefined });
    } catch {
      /* outbox failures must not break mutations */
    }
  }

  if (events) {
    try {
      await events.publish(event);
    } catch {
      /* transport failures must not break mutations */
    }
  }
}
