/**
 * Typed error for the accounting package.
 * Carries HTTP status + machine-readable code + structured field errors.
 *
 * The `fields` array lets AI agents and API clients pinpoint exactly
 * what failed in a multi-field validation:
 *
 *   throw Errors.validationWithFields('Journal entry invalid', [
 *     { path: 'journalItems.2.account', issue: 'account does not exist', value: '...' },
 *     { path: 'journalItems', issue: 'debits must equal credits', value: { debit: 500, credit: 450 } },
 *   ]);
 */

/** A single field-level validation error. */
export interface FieldError {
  /** Dot-notation path to the invalid field (e.g. `journalItems.2.account`) */
  readonly path: string;
  /** Human-readable description of what's wrong */
  readonly issue: string;
  /** The offending value (optional — omit for sensitive data) */
  readonly value?: unknown;
}

export class AccountingError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: ReadonlyArray<FieldError>;

  constructor(
    message: string,
    status = 400,
    code = 'ACCOUNTING_ERROR',
    fields?: ReadonlyArray<FieldError>,
  ) {
    super(message);
    this.name = 'AccountingError';
    this.status = status;
    this.code = code;
    if (fields && fields.length > 0) {
      this.fields = Object.freeze([...fields]);
    }
  }

  /** Serialize to a plain object for API responses and logs. */
  toJSON(): {
    name: string;
    message: string;
    status: number;
    code: string;
    fields?: ReadonlyArray<FieldError>;
  } {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      ...(this.fields ? { fields: this.fields } : {}),
    };
  }
}

// Forward-declared factories — implementations patched below after the typed
// subclasses are defined so `Errors.immutable(...)` returns `ImmutableViolationError`.
interface ErrorsFactories {
  validation: (msg: string, fields?: ReadonlyArray<FieldError>) => AccountingError;
  notFound: (msg: string, fields?: ReadonlyArray<FieldError>) => AccountingError;
  conflict: (msg: string, fields?: ReadonlyArray<FieldError>) => AccountingError;
  immutable: (msg: string, fields?: ReadonlyArray<FieldError>) => AccountingError;
  locked: (scope: string, msg: string, fields?: ReadonlyArray<FieldError>) => AccountingError;
}

export const Errors: ErrorsFactories = {
  validation: (msg, fields) => new AccountingError(msg, 400, 'VALIDATION_ERROR', fields),
  notFound: (msg, fields) => new AccountingError(msg, 404, 'NOT_FOUND', fields),
  conflict: (msg, fields) => new AccountingError(msg, 409, 'CONFLICT', fields),
  // Patched below after ImmutableViolationError is declared, so every caller
  // of `Errors.immutable(...)` gets an `instanceof ImmutableViolationError`.
  immutable: (msg, _fields) => new AccountingError(msg, 403, 'IMMUTABLE_ENTRY'),
  locked: (scope, msg, fields) =>
    new AccountingError(msg, 409, `PERIOD_LOCKED_${scope.toUpperCase()}`, fields),
};

// ─── Typed error subclasses (0.9.0) ────────────────────────────────────────
//
// These live alongside the generic `AccountingError` so callers can switch on
// `instanceof` rather than sniff `err.code === 11000` + index-name parsing.

/**
 * Thrown when an idempotent create was attempted with a key that already
 * resolved to a different winner (not the common "same winner, same payload"
 * replay — that returns the existing doc without throwing).
 *
 * Typically surfaces when the host supplies an `idempotencyKey` that collides
 * with a logically-different prior write.
 */
export class IdempotencyConflictError extends AccountingError {
  readonly idempotencyKey: string;
  readonly existingId: unknown;

  constructor(idempotencyKey: string, existingId: unknown, message?: string) {
    super(
      message ??
        `Idempotency key "${idempotencyKey}" already resolved to entry ${String(existingId)}.`,
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
    this.existingId = existingId;
  }
}

/**
 * Thrown when the unique `referenceNumber` index fires. With the new atomic
 * counter this should be effectively impossible — if it ever throws, it
 * indicates either a pre-atomic-counter doc that was hand-inserted OR a bug
 * in the counter partitioning.
 */
export class DuplicateReferenceError extends AccountingError {
  readonly referenceNumber: string;

  constructor(referenceNumber: string, message?: string) {
    super(
      message ?? `Duplicate reference number "${referenceNumber}".`,
      409,
      'DUPLICATE_REFERENCE_NUMBER',
    );
    this.name = 'DuplicateReferenceError';
    this.referenceNumber = referenceNumber;
  }
}

/**
 * Thrown when an optimistic-concurrency FSM transition fails because another
 * writer advanced the state or version between our read and our write.
 *
 * Callers should re-fetch the doc and decide whether to retry or surface.
 */
export class ConcurrencyError extends AccountingError {
  readonly resource: string;
  readonly resourceId: unknown;

  constructor(resource: string, resourceId: unknown, message?: string) {
    super(
      message ??
        `${resource} ${String(resourceId)} was modified by another writer — retry after re-fetch.`,
      409,
      'CONCURRENCY_CONFLICT',
    );
    this.name = 'ConcurrencyError';
    this.resource = resource;
    this.resourceId = resourceId;
  }
}

/**
 * Thrown when a mutation targets an entry that is protected by immutability —
 * either `strictness.immutable` or the double-entry plugin's posted-entry
 * guard. Factory `Errors.immutable(msg)` returns this subclass so callers
 * can `instanceof`-match without sniffing the `code` field.
 */
export class ImmutableViolationError extends AccountingError {
  readonly entryId: unknown;

  constructor(entryId: unknown, message?: string, fields?: ReadonlyArray<FieldError>) {
    super(
      message ?? `Entry ${String(entryId)} is posted and immutable. Use reverse() to correct it.`,
      403,
      'IMMUTABLE_ENTRY',
      fields,
    );
    this.name = 'ImmutableViolationError';
    this.entryId = entryId;
  }
}

// Patch `Errors.immutable` so every call site produces an `ImmutableViolationError`
// subclass — including the doubleEntryPlugin's pre-existing guard. Declared
// down here because the subclass depends on `AccountingError` above.
Errors.immutable = (msg: string, fields?: ReadonlyArray<FieldError>) =>
  new ImmutableViolationError(null, msg, fields);

/**
 * Detect a Mongo duplicate-key error (11000) and return the index name the
 * conflict hit on, so callers can switch on which unique key fired.
 *
 * Handles both driver-style and mongoose-style error shapes. Safe to call
 * with any `unknown` — returns `null` when the error is not a dup-key.
 */
export function classifyDuplicateKey(
  err: unknown,
): { indexName: string; keyPattern?: Record<string, unknown> } | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    code?: number | string;
    status?: number;
    name?: string;
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
    message?: string;
    // bulkWrite errors carry writeErrors[].code
    writeErrors?: Array<{ code?: number; keyPattern?: Record<string, unknown> }>;
  };

  const code =
    typeof e.code === 'number' ? e.code : typeof e.code === 'string' ? Number(e.code) : undefined;

  // Raw driver-level dup-key
  const isDriverDup =
    code === 11000 ||
    (e.name === 'MongoServerError' && code === 11000) ||
    (Array.isArray(e.writeErrors) && e.writeErrors.some((w) => w?.code === 11000));

  // mongokit-wrapped dup-key: status 409 + message prefix `Duplicate value for ...`
  // See `@classytic/mongokit/dist/error-*.mjs` `parseDuplicateKeyError`.
  const wrappedMsgMatch =
    typeof e.message === 'string'
      ? e.message.match(/^Duplicate value for ([a-zA-Z_.0-9,\s]+?)(?:\s*\(|$)/)
      : null;
  const isMongokitDup = e.status === 409 && !!wrappedMsgMatch;

  if (!isDriverDup && !isMongokitDup) return null;

  let keyPattern: Record<string, unknown> | undefined = e.keyPattern;
  if (!keyPattern && Array.isArray(e.writeErrors)) {
    keyPattern = e.writeErrors.find((w) => w?.code === 11000)?.keyPattern;
  }
  if (!keyPattern && wrappedMsgMatch) {
    // Parse field list from the mongokit-wrapped message
    const fields = wrappedMsgMatch[1]!
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    keyPattern = Object.fromEntries(fields.map((f) => [f, 1]));
  }

  // Synthesize an index name from keyPattern when the driver didn't give us one
  const indexName = keyPattern
    ? Object.keys(keyPattern).join('_')
    : typeof e.message === 'string' && e.message.match(/index: ([^\s]+)/)?.[1]
      ? (e.message.match(/index: ([^\s]+)/) as RegExpMatchArray)[1]
      : 'unknown';

  return { indexName, keyPattern };
}
