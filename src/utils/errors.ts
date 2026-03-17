/**
 * Typed error for the accounting package.
 * Carries HTTP status + machine-readable code.
 * Replaces all ad-hoc `(error as ...).status = N` patterns.
 */
export class AccountingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'ACCOUNTING_ERROR') {
    super(message);
    this.name = 'AccountingError';
    this.status = status;
    this.code = code;
  }
}

/** Convenience factory functions */
export const Errors = {
  validation: (msg: string) => new AccountingError(msg, 400, 'VALIDATION_ERROR'),
  notFound: (msg: string) => new AccountingError(msg, 404, 'NOT_FOUND'),
  conflict: (msg: string) => new AccountingError(msg, 409, 'CONFLICT'),
  immutable: (msg: string) => new AccountingError(msg, 403, 'IMMUTABLE_ENTRY'),
  fiscal: (msg: string) => new AccountingError(msg, 400, 'FISCAL_ERROR'),
} as const;
