/**
 * Event creation helper.
 *
 * Wraps `@classytic/primitives/events` `createEvent` with ledger's
 * cross-runtime id coercion: `actorId` / `organizationId` values commonly
 * arrive as Mongoose ObjectId or Buffer, so we normalize them to strings
 * before the primitives helper stamps them into the event meta.
 */
import type { DomainEvent } from '@classytic/primitives/events';
import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';

/** Minimal context shape for event metadata. */
export interface EventContext {
  actorId?: unknown;
  organizationId?: unknown;
  correlationId?: string;
  traceId?: string;
}

function toIdString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  // Mongoose ObjectId + Buffer-backed ids both expose toHexString / toString
  const obj = value as { toHexString?: () => string; toString?: () => string };
  if (typeof obj.toHexString === 'function') return obj.toHexString();
  if (typeof obj.toString === 'function') {
    const s = obj.toString();
    return s === '[object Object]' ? undefined : s;
  }
  return undefined;
}

export function createEvent<T>(
  type: string,
  payload: T,
  ctx?: EventContext,
  meta?: Partial<DomainEvent['meta']>,
): DomainEvent<T> {
  return createPrimitiveEvent(type, payload, {
    userId: toIdString(ctx?.actorId),
    organizationId: toIdString(ctx?.organizationId),
    correlationId: ctx?.correlationId ?? ctx?.traceId,
    ...meta,
  });
}
