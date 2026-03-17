import { describe, it, expect } from 'vitest';
import { AccountingError, Errors } from './errors.js';

describe('AccountingError', () => {
  it('creates error with default values', () => {
    const err = new AccountingError('something broke');
    expect(err.message).toBe('something broke');
    expect(err.status).toBe(400);
    expect(err.code).toBe('ACCOUNTING_ERROR');
    expect(err.name).toBe('AccountingError');
    expect(err).toBeInstanceOf(Error);
  });

  it('creates error with custom status and code', () => {
    const err = new AccountingError('not found', 404, 'CUSTOM_CODE');
    expect(err.status).toBe(404);
    expect(err.code).toBe('CUSTOM_CODE');
  });

  it('is an instance of Error', () => {
    const err = new AccountingError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AccountingError).toBe(true);
  });
});

describe('Errors factory', () => {
  it('validation() creates 400 VALIDATION_ERROR', () => {
    const err = Errors.validation('bad input');
    expect(err.message).toBe('bad input');
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('AccountingError');
  });

  it('notFound() creates 404 NOT_FOUND', () => {
    const err = Errors.notFound('entry missing');
    expect(err.message).toBe('entry missing');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('conflict() creates 409 CONFLICT', () => {
    const err = Errors.conflict('duplicate entry');
    expect(err.message).toBe('duplicate entry');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('immutable() creates 403 IMMUTABLE_ENTRY', () => {
    const err = Errors.immutable('cannot modify posted entry');
    expect(err.message).toBe('cannot modify posted entry');
    expect(err.status).toBe(403);
    expect(err.code).toBe('IMMUTABLE_ENTRY');
  });

  it('fiscal() creates 400 FISCAL_ERROR', () => {
    const err = Errors.fiscal('period is closed');
    expect(err.message).toBe('period is closed');
    expect(err.status).toBe(400);
    expect(err.code).toBe('FISCAL_ERROR');
  });
});
