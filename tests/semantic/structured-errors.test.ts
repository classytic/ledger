/**
 * Structured Validation Errors — integration tests
 *
 * Verifies that plugins emit field-level errors agents can consume.
 * The double-entry plugin and semantic record API should both populate
 * AccountingError.fields with { path, issue, value }.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { type AccountingEngine, createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';
import { AccountingError, Errors } from '../../src/utils/errors.js';

const accountTypes: readonly AccountType[] = [
  {
    code: '1001',
    name: 'Cash',
    category: 'Balance Sheet-Asset',
    description: 'Cash',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: 'Operating',
  },
  {
    code: '4010',
    name: 'Revenue',
    category: 'Income Statement-Income',
    description: 'Revenue',
    parentCode: null,
    isTotal: false,
    cashFlowCategory: null,
  },
];

const pack = defineCountryPack({
  code: 'TS',
  name: 'Test',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

let mongod: MongoMemoryServer;
let engine: AccountingEngine;

const PREFIX = 'StructErr_';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  for (const n of [`${PREFIX}Acct`, `${PREFIX}JE`, `${PREFIX}FP`, `${PREFIX}B`, `${PREFIX}R`]) {
    if (mongoose.connection.models[n]) delete mongoose.connection.models[n];
  }

  engine = createAccountingEngine({
    mongoose: mongoose.connection,
    country: pack,
    currency: 'USD',
    modelNames: {
      account: `${PREFIX}Acct`,
      journalEntry: `${PREFIX}JE`,
      fiscalPeriod: `${PREFIX}FP`,
      budget: `${PREFIX}B`,
      reconciliation: `${PREFIX}R`,
    },
  });

  await engine.models.Account.createIndexes();
  await engine.models.JournalEntry.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await engine.models.Account.deleteMany({});
  await engine.models.JournalEntry.deleteMany({});
  await engine.repositories.accounts.seedAccounts(undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// AccountingError class
// ═════════════════════════════════════════════════════════════════════════════

describe('AccountingError.fields', () => {
  it('attaches field errors when provided', () => {
    const err = new AccountingError('bad', 400, 'VALIDATION_ERROR', [
      { path: 'amount', issue: 'must be positive', value: -5 },
    ]);
    expect(err.fields).toBeDefined();
    expect(err.fields?.length).toBe(1);
    expect(err.fields?.[0].path).toBe('amount');
  });

  it('omits fields when none provided', () => {
    const err = new AccountingError('bad');
    expect(err.fields).toBeUndefined();
  });

  it('fields array is frozen (immutable)', () => {
    const err = new AccountingError('bad', 400, 'VALIDATION_ERROR', [{ path: 'x', issue: 'y' }]);
    expect(Object.isFrozen(err.fields)).toBe(true);
  });

  it('toJSON serializes fields for API responses', () => {
    const err = Errors.validation('Bad input', [
      { path: 'a.b', issue: 'is required' },
      { path: 'a.c', issue: 'must be integer', value: 1.5 },
    ]);
    const json = err.toJSON();
    expect(json.status).toBe(400);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.fields).toBeDefined();
    expect(json.fields?.length).toBe(2);
  });

  it('toJSON omits fields when absent', () => {
    const err = Errors.notFound('Not found');
    const json = err.toJSON();
    expect(json.fields).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Errors factory
// ═════════════════════════════════════════════════════════════════════════════

describe('Errors factory (all variants accept fields)', () => {
  it.each([
    ['validation', 400, 'VALIDATION_ERROR'],
    ['notFound', 404, 'NOT_FOUND'],
    ['conflict', 409, 'CONFLICT'],
    ['immutable', 403, 'IMMUTABLE_ENTRY'],
  ] as const)('%s produces status=%i code=%s with fields', (name, status, code) => {
    const fn = Errors[name];
    const err = fn('msg', [{ path: 'x', issue: 'y' }]);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.fields?.[0].path).toBe('x');
  });

  it('locked(scope, ...) produces status=409 code=PERIOD_LOCKED_{SCOPE} with fields', () => {
    const err = Errors.locked('fiscal', 'msg', [{ path: 'x', issue: 'y' }]);
    expect(err.status).toBe(409);
    expect(err.code).toBe('PERIOD_LOCKED_FISCAL');
    expect(err.fields?.[0].path).toBe('x');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Double-entry plugin emits field errors
// ═════════════════════════════════════════════════════════════════════════════

describe('double-entry plugin field errors', () => {
  it('unbalanced posted entry → field error on journalItems', async () => {
    const accounts = await engine.introspect.accounts();
    const cash = accounts.find((a) => a.code === '1001')!;
    const revenue = accounts.find((a) => a.code === '4010')!;

    const err = await engine.repositories.journalEntries
      .create({
        journalType: 'SALES',
        state: 'posted',
        date: new Date(),
        journalItems: [
          { account: cash.id, debit: 1000, credit: 0 },
          { account: revenue.id, debit: 0, credit: 999 },
        ],
      } as any)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).fields).toBeDefined();
    const field = (err as AccountingError).fields?.[0];
    expect(field.path).toBe('journalItems');
    expect(field.issue).toContain('debits must equal credits');
    expect((field.value as any).difference).toBe(1);
  });

  it('line with both debit and credit → field error on specific line', async () => {
    const accounts = await engine.introspect.accounts();
    const cash = accounts.find((a) => a.code === '1001')!;
    const revenue = accounts.find((a) => a.code === '4010')!;

    const err = await engine.repositories.journalEntries
      .create({
        journalType: 'SALES',
        state: 'posted',
        date: new Date(),
        journalItems: [
          { account: cash.id, debit: 500, credit: 500 },
          { account: revenue.id, debit: 0, credit: 500 },
        ],
      } as any)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    const fields = (err as AccountingError).fields!;
    expect(fields.some((f) => f.path === 'journalItems.0')).toBe(true);
  });

  it('non-existent account → field error identifying the bad index', async () => {
    const accounts = await engine.introspect.accounts();
    const cash = accounts.find((a) => a.code === '1001')!;
    const fakeId = new mongoose.Types.ObjectId().toString();

    const err = await engine.repositories.journalEntries
      .create({
        journalType: 'SALES',
        state: 'posted',
        date: new Date(),
        journalItems: [
          { account: cash.id, debit: 1000, credit: 0 },
          { account: fakeId, debit: 0, credit: 1000 },
        ],
      } as any)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    const fields = (err as AccountingError).fields!;
    const missing = fields.find((f) => f.issue === 'account does not exist');
    expect(missing).toBeDefined();
    expect(missing?.path).toBe('journalItems.1.account');
    expect(missing?.value).toBe(fakeId);
  });
});
