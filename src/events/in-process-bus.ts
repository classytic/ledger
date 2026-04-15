/**
 * InProcessLedgerBus — minimal structural match of @classytic/arc's MemoryEventTransport.
 *
 * Supports exact, `*`, and `resource.*` glob matching. Per-handler errors are
 * caught so one failing listener cannot block siblings. This is the default
 * transport when the host does not inject one.
 *
 * NOT suitable for multi-instance deployments — use a durable transport
 * (Redis pub/sub, Kafka, BullMQ) wired through arc for those.
 */

import type {
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
  PublishManyResult,
} from './transport.js';

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
    const exact = this.handlers.get(event.type) ?? new Set();
    const wildcard = this.handlers.get('*') ?? new Set();

    const pattern = new Set<EventHandler>();
    for (const [p, handlers] of this.handlers.entries()) {
      if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        if (event.type.startsWith(`${prefix}.`)) {
          for (const h of handlers) pattern.add(h);
        }
      } else if (p.endsWith(':*')) {
        const prefix = p.slice(0, -2);
        if (event.type.startsWith(`${prefix}:`)) {
          for (const h of handlers) pattern.add(h);
        }
      }
    }

    const all = new Set([...exact, ...wildcard, ...pattern]);
    for (const handler of all) {
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
