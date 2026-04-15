/**
 * Event creation helper.
 *
 * Builds a well-formed DomainEvent with auto-generated `meta.id` + `meta.timestamp`.
 * Threads optional context fields (userId, organizationId, correlationId) that
 * hosts rely on for audit trails and distributed tracing.
 */

import { randomUUID } from 'node:crypto';
import type { DomainEvent } from './transport.js';

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
  return {
    type,
    payload,
    meta: {
      id: randomUUID(),
      timestamp: new Date(),
      userId: toIdString(ctx?.actorId),
      organizationId: toIdString(ctx?.organizationId),
      correlationId: ctx?.correlationId ?? ctx?.traceId,
      ...meta,
    },
  };
}
