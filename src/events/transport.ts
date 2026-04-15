/**
 * EventTransport — structurally identical to @classytic/arc's EventTransport.
 *
 * DO NOT import from @classytic/arc at runtime. TypeScript structural typing
 * means any arc transport (Memory, Redis, BullMQ, Kafka) is assignable to this
 * interface with zero adapter code, as long as the shape matches exactly.
 *
 * See: packages/arc/src/events/EventTransport.ts
 */

export interface DomainEvent<T = unknown> {
  type: string;
  payload: T;
  meta: {
    id: string;
    timestamp: Date;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

/**
 * Per-event outcome returned by `EventTransport.publishMany`.
 * Key is `event.meta.id`; value is `null` for success or `Error` for per-event failure.
 */
export type PublishManyResult = ReadonlyMap<string, Error | null>;

export interface EventLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface EventTransport {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
  publishMany?(events: readonly DomainEvent[]): Promise<PublishManyResult>;
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;
  close?(): Promise<void>;
}
