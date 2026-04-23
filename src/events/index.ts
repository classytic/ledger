// Transport shapes come from @classytic/primitives/events — structurally
// identical to @classytic/arc. Re-exported here for consumers of
// `@classytic/ledger/events`.
export type {
  DomainEvent,
  EventHandler,
  EventTransport,
  PublishManyResult,
} from '@classytic/primitives/events';
export type { LedgerEventName } from './event-constants.js';
export { LEDGER_EVENTS } from './event-constants.js';
export type {
  AccountBulkCreatedPayload,
  AccountSeededPayload,
  EntryArchivedPayload,
  EntryCreatedPayload,
  EntryDuplicatedPayload,
  EntryPostedPayload,
  EntryReversedPayload,
  EntryUnpostedPayload,
  JournalSeededPayload,
  ReconciliationMatchedPayload,
  ReconciliationUnmatchedPayload,
} from './event-payloads.js';
export type { EventContext } from './helpers.js';
export { createEvent } from './helpers.js';
// Ledger-specific logger contract lives with the in-process bus.
export type { EventLogger, InProcessLedgerBusOptions } from './in-process-bus.js';
export { InProcessLedgerBus } from './in-process-bus.js';
export type {
  AccountBulkCreatedPayloadSchema,
  AccountSeededPayloadSchema,
  EntryArchivedPayloadSchema,
  EntryCreatedPayloadSchema,
  EntryDuplicatedPayloadSchema,
  EntryPostedPayloadSchema,
  EntryReversedPayloadSchema,
  EntryUnpostedPayloadSchema,
  JournalSeededPayloadSchema,
  LedgerEventDefinition,
  LedgerEventPayloadOf,
  LedgerEventSchema,
  ReconciliationMatchedPayloadSchema,
  ReconciliationUnmatchedPayloadSchema,
} from './ledger-event-catalog.js';
// Arc 2.10 EventRegistry catalog — Zod-backed definitions with JSON Schema
// derived via `z.toJSONSchema()`. See PACKAGE_RULES §18.5. Hosts register
// `ledgerEventDefinitions` directly with Arc's registry.
export {
  AccountBulkCreated,
  AccountSeeded,
  EntryArchived,
  EntryCreated,
  EntryDuplicated,
  EntryPosted,
  EntryReversed,
  EntryUnposted,
  JournalSeeded,
  ledgerEventDefinitions,
  ReconciliationMatched,
  ReconciliationUnmatched,
} from './ledger-event-catalog.js';
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
} from './outbox-store.js';
export { InvalidOutboxEventError, OutboxOwnershipError } from './outbox-store.js';
