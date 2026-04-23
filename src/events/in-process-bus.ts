/**
 * InProcessLedgerBus — minimal default transport for ledger.
 *
 * Structurally identical to `@classytic/arc`'s `MemoryEventTransport`.
 * Pattern matching (exact, `*`, `resource.*`, `resource:*`) delegates to
 * `matchEventPattern` from `@classytic/primitives/events` so all packages
 * share one rule set.
 *
 * Not suitable for multi-instance deployments — use a durable transport
 * (Redis pub/sub, Kafka, BullMQ) wired through arc for those.
 */
import type {
  DomainEvent,
  EventHandler,
  EventTransport,
  PublishManyResult,
} from '@classytic/primitives/events';
import { matchEventPattern } from '@classytic/primitives/events';

/** Package-specific logger contract — `console` satisfies it. */
export interface EventLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface InProcessLedgerBusOptions {
  logger?: EventLogger;
}

export class InProcessLedgerBus implements EventTransport {
  readonly name = 'in-process-ledger';
  private handlers = new Map<string, Set<EventHandler>>();
  private logger: EventLogger;

  constructor(options?: InProcessLedgerBusOptions) {
    this.logger = options?.logger ?? console;
  }

  async publish(event: DomainEvent): Promise<void> {
    const matched = new Set<EventHandler>();
    for (const [pattern, set] of this.handlers.entries()) {
      if (matchEventPattern(pattern, event.type)) {
        for (const h of set) matched.add(h);
      }
    }
    for (const handler of matched) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`[InProcessLedgerBus] Handler error for ${event.type}:`, err);
      }
    }
  }

  async publishMany(events: readonly DomainEvent[]): Promise<PublishManyResult> {
    const results = new Map<string, Error | null>();
    for (const event of events) {
      try {
        await this.publish(event);
        results.set(event.meta.id, null);
      } catch (err) {
        results.set(event.meta.id, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return results;
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)?.add(handler);

    return () => {
      const set = this.handlers.get(pattern);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(pattern);
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
