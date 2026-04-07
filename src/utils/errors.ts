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

/** Convenience factory functions. */
export const Errors = {
  validation: (msg: string, fields?: ReadonlyArray<FieldError>) =>
    new AccountingError(msg, 400, 'VALIDATION_ERROR', fields),
  notFound: (msg: string, fields?: ReadonlyArray<FieldError>) =>
    new AccountingError(msg, 404, 'NOT_FOUND', fields),
  conflict: (msg: string, fields?: ReadonlyArray<FieldError>) =>
    new AccountingError(msg, 409, 'CONFLICT', fields),
  immutable: (msg: string, fields?: ReadonlyArray<FieldError>) =>
    new AccountingError(msg, 403, 'IMMUTABLE_ENTRY', fields),
  /**
   * Period/scope lock violation. Replaces the old `fiscal` factory — use the
   * `scope` argument to distinguish fiscal / tax / daily / bank / etc. The
   * resulting error code is `PERIOD_LOCKED_{SCOPE}` (e.g. `PERIOD_LOCKED_FISCAL`).
   */
  locked: (scope: string, msg: string, fields?: ReadonlyArray<FieldError>) =>
    new AccountingError(msg, 409, `PERIOD_LOCKED_${scope.toUpperCase()}`, fields),
} as const;
