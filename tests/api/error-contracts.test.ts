/**
 * Error Contract Tests
 *
 * Verifies the AccountingError hierarchy and Errors factory.
 * Modeled after @classytic/flow's error hierarchy tests:
 * - Every error extends Error and AccountingError
 * - Each error carries correct status, code, and message
 * - Error properties are machine-readable for API consumers
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { AccountingError, Errors } from '../../src/utils/errors.js';

describe('AccountingError', () => {
  it('extends Error', () => {
    const err = new AccountingError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AccountingError);
  });

  it('has correct name', () => {
    const err = new AccountingError('test');
    expect(err.name).toBe('AccountingError');
  });

  it('carries message', () => {
    const err = new AccountingError('Something went wrong');
    expect(err.message).toBe('Something went wrong');
  });

  it('defaults to status 400 and code ACCOUNTING_ERROR', () => {
    const err = new AccountingError('test');
    expect(err.status).toBe(400);
    expect(err.code).toBe('ACCOUNTING_ERROR');
  });

  it('accepts custom status and code', () => {
    const err = new AccountingError('denied', 403, 'FORBIDDEN');
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('has readonly status and code', () => {
    expectTypeOf<AccountingError>().toHaveProperty('status').toBeNumber();
    expectTypeOf<AccountingError>().toHaveProperty('code').toBeString();
  });

  it('produces a useful stack trace', () => {
    const err = new AccountingError('stack test');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('stack test');
  });
});

describe('Errors factory', () => {
  it('validation() → 400 VALIDATION_ERROR', () => {
    const err = Errors.validation('bad input');
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
  });

  it('notFound() → 404 NOT_FOUND', () => {
    const err = Errors.notFound('Account not found');
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Account not found');
  });

  it('conflict() → 409 CONFLICT', () => {
    const err = Errors.conflict('Duplicate entry');
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('Duplicate entry');
  });

  it('immutable() → 403 IMMUTABLE_ENTRY', () => {
    const err = Errors.immutable('Cannot modify posted entry');
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('IMMUTABLE_ENTRY');
    expect(err.message).toBe('Cannot modify posted entry');
  });

  it('locked() → 409 PERIOD_LOCKED_{SCOPE}', () => {
    const err = Errors.locked('fiscal', 'Period is closed');
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('PERIOD_LOCKED_FISCAL');
    expect(err.message).toBe('Period is closed');
  });

  it('all factory methods return AccountingError instances', () => {
    const factories: Array<(msg: string) => AccountingError> = [
      Errors.validation,
      Errors.notFound,
      Errors.conflict,
      Errors.immutable,
      (msg: string) => Errors.locked('fiscal', msg),
    ];

    for (const factory of factories) {
      const err = factory('test');
      expect(err).toBeInstanceOf(AccountingError);
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.status).toBe('number');
      expect(typeof err.code).toBe('string');
      expect(typeof err.message).toBe('string');
    }
  });

  it('errors are catchable in try/catch as AccountingError', () => {
    try {
      throw Errors.notFound('missing');
    } catch (e) {
      expect(e).toBeInstanceOf(AccountingError);
      if (e instanceof AccountingError) {
        expect(e.status).toBe(404);
        expect(e.code).toBe('NOT_FOUND');
      }
    }
  });

  it('every factory has unique (status, code) pair', () => {
    const pairs = new Set<string>();
    const factories = {
      validation: Errors.validation('x'),
      notFound: Errors.notFound('x'),
      conflict: Errors.conflict('x'),
      immutable: Errors.immutable('x'),
      lockedFiscal: Errors.locked('fiscal', 'x'),
      lockedTax: Errors.locked('tax', 'x'),
      lockedDaily: Errors.locked('daily', 'x'),
    };

    for (const [name, err] of Object.entries(factories)) {
      const key = `${err.status}:${err.code}`;
      expect(pairs.has(key), `Duplicate (status, code) pair for ${name}: ${key}`).toBe(false);
      pairs.add(key);
    }
  });
});
