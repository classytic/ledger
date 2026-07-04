/**
 * Ledger event catalog — Zod-source-of-truth definitions for every
 * `ledger:*` event.
 *
 * Each definition exposes:
 *   - `.zodSchema`   — source of truth, used by host code's `.safeParse()`
 *   - `.schema`      — JSON Schema derived via `z.toJSONSchema()`, consumed
 *                     by Arc's EventRegistry + OpenAPI plugin
 *   - `.create(...)` — DomainEvent envelope builder, structurally compatible
 *                     with `@classytic/arc`'s `EventDefinitionOutput`
 *
 * Structurally compatible with Arc 2.10's `EventRegistry` — hosts register
 * `ledgerEventDefinitions` directly, no adapter code. Ledger does NOT
 * import from `@classytic/arc` (PACKAGE_RULES §11); compatibility is
 * purely structural.
 *
 * `entryId`, `accountId`, `organizationId` and other Mongo `_id` fields
 * are modelled as `z.string()`. Repositories pass the raw `ObjectId`,
 * which JSON-serialises to its 24-char hex string over the wire.
 * In-process subscribers that want the ObjectId back call
 * `new Types.ObjectId(id)`.
 *
 * Payload schemas mirror the typed interfaces in
 * [event-payloads.ts](./event-payloads.ts). See PACKAGE_RULES §18.5 for
 * the pattern.
 *
 * @example Wiring into an Arc app
 * ```ts
 * import { createEventRegistry } from '@classytic/arc/events';
 * import { ledgerEventDefinitions } from '@classytic/ledger/events';
 *
 * const registry = createEventRegistry();
 * for (const def of ledgerEventDefinitions) registry.register(def);
 * ```
 */

import { CURRENCY_PATTERN } from '@classytic/primitives/currency';
import type { DomainEvent } from '@classytic/primitives/events';
import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';
import { z } from 'zod';
import { LEDGER_EVENTS } from './event-constants.js';

// ─── Definition shape (structurally compatible with Arc EventRegistry) ────

export interface LedgerEventSchema {
  type: 'object';
  properties?: Record<string, { type?: string; format?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

export interface LedgerEventDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly schema: LedgerEventSchema;
  readonly zodSchema: TSchema;
  create(
    payload: z.infer<TSchema>,
    meta?: Partial<DomainEvent['meta']>,
  ): DomainEvent<z.infer<TSchema>>;
  readonly __payload?: z.infer<TSchema>;
}

export type LedgerEventPayloadOf<D> = D extends LedgerEventDefinition<infer S> ? z.infer<S> : never;

function defineLedgerEvent<TSchema extends z.ZodType>(input: {
  name: string;
  version?: number;
  description?: string;
  zodSchema: TSchema;
}): LedgerEventDefinition<TSchema> {
  const { name, version = 1, description, zodSchema } = input;
  const def: LedgerEventDefinition<TSchema> = {
    name,
    version,
    schema: z.toJSONSchema(zodSchema) as LedgerEventSchema,
    zodSchema,
    create(payload, meta) {
      return createPrimitiveEvent(name, payload, { source: 'ledger', ...meta });
    },
  };
  if (description !== undefined) {
    (def as { description: string }).description = description;
  }
  return def;
}

// ─── Reusable fragments ───────────────────────────────────────────────────

/**
 * Mongo ObjectId or string — repositories pass raw ObjectIds which JSON
 * serialise to hex strings. `passthrough()` via union keeps validation
 * permissive without demanding a cast at the emit site.
 */
const objectIdLike = z.union([z.string(), z.any()]);

const seedCountsSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  organizationId: objectIdLike.optional(),
});

// ─── Event payload schemas ────────────────────────────────────────────────

const entryCreatedSchema = z.object({
  entryId: objectIdLike,
  journalType: z.string().optional(),
  state: z.string(),
  referenceNumber: z.string().optional(),
  idempotencyKey: z.string().optional(),
  organizationId: objectIdLike.optional(),
});

const entryPostedSchema = z.object({
  entryId: objectIdLike,
  referenceNumber: z.string().optional(),
  postedBy: objectIdLike.optional(),
  totalDebit: z.number(),
  totalCredit: z.number(),
  organizationId: objectIdLike.optional(),
});

const entryUnpostedSchema = z.object({
  entryId: objectIdLike,
  unpostedBy: objectIdLike.optional(),
  organizationId: objectIdLike.optional(),
});

const entryArchivedSchema = z.object({
  entryId: objectIdLike,
  archivedBy: objectIdLike.optional(),
  organizationId: objectIdLike.optional(),
});

const entryDuplicatedSchema = z.object({
  sourceEntryId: objectIdLike,
  duplicateEntryId: objectIdLike,
  organizationId: objectIdLike.optional(),
});

const entryReversedSchema = z.object({
  originalEntryId: objectIdLike,
  reversalEntryId: objectIdLike,
  reversalDate: z.iso.datetime(),
  reversedBy: objectIdLike.optional(),
  organizationId: objectIdLike.optional(),
});

const accountBulkCreatedSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  organizationId: objectIdLike.optional(),
});

const reconciliationMatchedSchema = z.object({
  matchingNumber: z.string(),
  account: objectIdLike,
  itemCount: z.number().int().nonnegative(),
  debitTotal: z.number(),
  creditTotal: z.number(),
  isFullReconcile: z.boolean(),
  currency: z.string().regex(CURRENCY_PATTERN, 'ISO 4217 (3 uppercase letters)').nullable(),
  organizationId: objectIdLike.optional(),
});

const reconciliationUnmatchedSchema = z.object({
  matchingNumber: z.string(),
  itemCount: z.number().int().nonnegative(),
  organizationId: objectIdLike.optional(),
});

// ─── Inferred payload types (re-exported for host subscribers) ───────────

export type EntryCreatedPayloadSchema = z.infer<typeof entryCreatedSchema>;
export type EntryPostedPayloadSchema = z.infer<typeof entryPostedSchema>;
export type EntryUnpostedPayloadSchema = z.infer<typeof entryUnpostedSchema>;
export type EntryArchivedPayloadSchema = z.infer<typeof entryArchivedSchema>;
export type EntryDuplicatedPayloadSchema = z.infer<typeof entryDuplicatedSchema>;
export type EntryReversedPayloadSchema = z.infer<typeof entryReversedSchema>;
export type AccountSeededPayloadSchema = z.infer<typeof seedCountsSchema>;
export type AccountBulkCreatedPayloadSchema = z.infer<typeof accountBulkCreatedSchema>;
export type JournalSeededPayloadSchema = z.infer<typeof seedCountsSchema>;
export type ReconciliationMatchedPayloadSchema = z.infer<typeof reconciliationMatchedSchema>;
export type ReconciliationUnmatchedPayloadSchema = z.infer<typeof reconciliationUnmatchedSchema>;

// ─── Event definitions ────────────────────────────────────────────────────

export const EntryCreated = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_CREATED,
  description: 'A journal entry was created (may be draft or posted depending on service).',
  zodSchema: entryCreatedSchema,
});

export const EntryPosted = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_POSTED,
  description: 'A journal entry was posted — balances are now final.',
  zodSchema: entryPostedSchema,
});

export const EntryUnposted = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_UNPOSTED,
  description: 'A previously posted entry was unposted (reverted to draft).',
  zodSchema: entryUnpostedSchema,
});

export const EntryArchived = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_ARCHIVED,
  description: 'An entry was archived — hidden from default queries, still on disk.',
  zodSchema: entryArchivedSchema,
});

export const EntryDuplicated = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_DUPLICATED,
  description: 'A new draft entry was produced by duplicating an existing one.',
  zodSchema: entryDuplicatedSchema,
});

export const EntryReversed = defineLedgerEvent({
  name: LEDGER_EVENTS.ENTRY_REVERSED,
  description: 'A posted entry was reversed — a new offsetting entry was booked.',
  zodSchema: entryReversedSchema,
});

export const AccountSeeded = defineLedgerEvent({
  name: LEDGER_EVENTS.ACCOUNT_SEEDED,
  description: 'Chart-of-accounts defaults were seeded for an organization.',
  zodSchema: seedCountsSchema,
});

export const AccountBulkCreated = defineLedgerEvent({
  name: LEDGER_EVENTS.ACCOUNT_BULK_CREATED,
  description: 'A bulk import of accounts completed.',
  zodSchema: accountBulkCreatedSchema,
});

export const JournalSeeded = defineLedgerEvent({
  name: LEDGER_EVENTS.JOURNAL_SEEDED,
  description: 'Default journals were seeded for an organization.',
  zodSchema: seedCountsSchema,
});

export const ReconciliationMatched = defineLedgerEvent({
  name: LEDGER_EVENTS.RECONCILIATION_MATCHED,
  description: 'A set of ledger items was matched under a reconciliation number.',
  zodSchema: reconciliationMatchedSchema,
});

export const ReconciliationUnmatched = defineLedgerEvent({
  name: LEDGER_EVENTS.RECONCILIATION_UNMATCHED,
  description: 'A previously matched reconciliation was unmatched.',
  zodSchema: reconciliationUnmatchedSchema,
});

// ─── Aggregate catalog ────────────────────────────────────────────────────

/**
 * Every ledger event defined in the package — pass to Arc's
 * `EventRegistry`. Hosts wire ONE array; the whole `ledger:*` namespace
 * becomes introspectable via OpenAPI and auto-validated at publish time
 * when `eventPlugin({ validateMode: 'reject' })` is set.
 */
export const ledgerEventDefinitions: ReadonlyArray<LedgerEventDefinition> = [
  EntryCreated,
  EntryPosted,
  EntryUnposted,
  EntryArchived,
  EntryDuplicated,
  EntryReversed,
  AccountSeeded,
  AccountBulkCreated,
  JournalSeeded,
  ReconciliationMatched,
  ReconciliationUnmatched,
];
