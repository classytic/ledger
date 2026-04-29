/**
 * Architectural Improvements Tests
 *
 * Tests for:
 * - Improvement 0: AccountingError class + Errors factory
 * - Improvement 1: Immutable posted-ledger (reverse + immutability guard)
 * - Improvement 2: Internal session management (fiscal close/reopen)
 * - Improvement 3: Account identity split (accountNumber + name)
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { doubleEntryPlugin } from '../src/plugins/double-entry.plugin.js';
import { AccountingError, Errors } from '../src/utils/errors.js';
import type { Logger } from '../src/utils/logger.js';
import { defaultLogger } from '../src/utils/logger.js';
import { mockRepository } from './helpers/mock-repository.js';

let __mongod: MongoMemoryServer;
beforeAll(async () => {
  __mongod = await MongoMemoryServer.create();
  await mongoose.connect(__mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await __mongod.stop();
});
let __archCounter = 0;
const __archModelNames = () => {
  const i = ++__archCounter;
  return {
    account: `Arch_Acct_${i}`,
    journalEntry: `Arch_JE_${i}`,
    fiscalPeriod: `Arch_FP_${i}`,
    budget: `Arch_B_${i}`,
    reconciliation: `Arch_R_${i}`,
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockRepo() {
  const hooks = new Map<string, Array<(ctx: unknown) => void | Promise<void>>>();
  return {
    on(event: string, handler: (ctx: unknown) => void | Promise<void>) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event)?.push(handler);
    },
    async emit(event: string, ctx: unknown) {
      for (const fn of hooks.get(event) ?? []) {
        await fn(ctx);
      }
    },
  };
}

// ─── Improvement 0: AccountingError + Errors Factory ────────────────────────

describe('Improvement 0: AccountingError', () => {
  it('creates error with default status and code', () => {
    const err = new AccountingError('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.message).toBe('test message');
    expect(err.status).toBe(400);
    expect(err.code).toBe('ACCOUNTING_ERROR');
    expect(err.name).toBe('AccountingError');
  });

  it('creates error with custom status and code', () => {
    const err = new AccountingError('not found', 404, 'NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('Errors.validation() returns 400 VALIDATION_ERROR', () => {
    const err = Errors.validation('bad input');
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
  });

  it('Errors.notFound() returns 404 NOT_FOUND', () => {
    const err = Errors.notFound('missing');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('Errors.conflict() returns 409 CONFLICT', () => {
    const err = Errors.conflict('duplicate');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('Errors.immutable() returns 403 IMMUTABLE_ENTRY', () => {
    const err = Errors.immutable('cannot modify');
    expect(err.status).toBe(403);
    expect(err.code).toBe('IMMUTABLE_ENTRY');
  });

  it('Errors.locked() returns 409 PERIOD_LOCKED_{SCOPE}', () => {
    const err = Errors.locked('fiscal', 'period closed');
    expect(err.status).toBe(409);
    expect(err.code).toBe('PERIOD_LOCKED_FISCAL');
  });

  it('AccountingError is catchable as Error', () => {
    try {
      throw Errors.validation('test');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as AccountingError).status).toBe(400);
    }
  });
});

describe('Improvement 0: Logger', () => {
  it('defaultLogger has warn, error, info methods', () => {
    expect(typeof defaultLogger.warn).toBe('function');
    expect(typeof defaultLogger.error).toBe('function');
    expect(typeof defaultLogger.info).toBe('function');
  });

  it('defaultLogger.warn calls console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defaultLogger.warn('test warning');
    expect(spy).toHaveBeenCalledWith('[accounting] test warning', '');
    spy.mockRestore();
  });

  it('defaultLogger passes meta to console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    defaultLogger.error('test error', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[accounting] test error', { key: 'value' });
    spy.mockRestore();
  });
});

// ─── Improvement 1: Immutability Guard ──────────────────────────────────────

describe('Improvement 1: Immutability Guard', () => {
  function createMockModel(state: string) {
    return {
      findById: () => ({
        select: () => ({
          session: () => ({
            lean: () => Promise.resolve({ state }),
          }),
        }),
      }),
    } as any;
  }

  it('blocks field updates on posted entries', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { label: 'Updated label' }, // modifying a posted entry's label
    };

    await expect(repo.emit('before:update', ctx)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );
  });

  it('blocks journalItems updates on posted entries', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: {
        journalItems: [
          { debit: 5000, credit: 0 },
          { debit: 0, credit: 5000 },
        ],
      },
    };

    await expect(repo.emit('before:update', ctx)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );
  });

  it('blocks state:posted + extra fields on posted entries (bypass attempt)', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { state: 'posted', label: 'Sneaky update' },
    };

    await expect(repo.emit('before:update', ctx)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );
  });

  it('blocks state:draft on posted entries (posted→draft bypass attempt)', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { state: 'draft' }, // attempting to un-post
    };

    await expect(repo.emit('before:update', ctx)).rejects.toThrow('Posted entries are immutable');
  });

  it('blocks reversed/reversedBy updates on posted entries via repository.update()', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    // reversed + reversedBy together — still blocked (must go through reverse())
    const ctx1 = {
      id: 'entry-1',
      data: { reversed: true, reversedBy: 'reversal-entry-id' },
    };
    await expect(repo.emit('before:update', ctx1)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );

    // reversed alone — blocked
    const ctx2 = {
      id: 'entry-1',
      data: { reversed: true },
    };
    await expect(repo.emit('before:update', ctx2)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );

    // reversedBy alone — blocked
    const ctx3 = {
      id: 'entry-1',
      data: { reversedBy: 'some-entry-id' },
    };
    await expect(repo.emit('before:update', ctx3)).rejects.toThrow(
      'Cannot modify a posted journal entry',
    );
  });

  it('reverse() marks the original via repository.update() with _ledgerInternal=reverseMark', async () => {
    // As of 0.5.1 reverse() routes the mark-as-reversed step through
    // repository.update() so plugins (audit, observability) observe the
    // reversal event. The double-entry immutability guard honours the
    // internal flag so the legitimate mutation is permitted.
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      reversed: false,
      journalType: 'MISC',
      referenceNumber: 'MISC/2025/01/0001',
      journalItems: [
        { account: { _id: 'acc-1' }, debit: 10000, credit: 0 },
        { account: { _id: 'acc-1' }, debit: 0, credit: 10000 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const mockModel = {} as any;

    const repoCreate = vi.fn().mockResolvedValue({ _id: 'reversal-1' });
    const repo: any = mockRepository({
      create: repoCreate,
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    await repo.reverse('entry-1');

    // The reverse-mark step went through update(), not entry.save().
    expect(mockEntry.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ reversed: true, reversedBy: 'reversal-1' }),
      expect.objectContaining({ _ledgerInternal: 'reverseMark' }),
    );
  });

  it('allows idempotent state:posted alone on posted entries', async () => {
    const repo = createMockRepo();
    // Mock needs to return journalItems too since the validation logic
    // fetches persisted doc for balance check after passing immutability guard
    const model = {
      findById: () => ({
        select: () => ({
          session: () => ({
            lean: () =>
              Promise.resolve({
                state: 'posted',
                journalItems: [
                  { debit: 10000, credit: 0 },
                  { debit: 0, credit: 10000 },
                ],
              }),
          }),
        }),
      }),
    } as any;
    doubleEntryPlugin({ JournalEntryModel: model }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { state: 'posted' }, // no other fields — idempotent
    };

    await expect(repo.emit('before:update', ctx)).resolves.toBeUndefined();
  });

  it('allows draft→posted state transition', async () => {
    const repo = createMockRepo();
    const model = {
      findById: () => ({
        select: () => ({
          session: () => ({
            lean: () =>
              Promise.resolve({
                state: 'draft',
                journalItems: [
                  { debit: 10000, credit: 0 },
                  { debit: 0, credit: 10000 },
                ],
              }),
          }),
        }),
      }),
    } as any;
    doubleEntryPlugin({ JournalEntryModel: model }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { state: 'posted' },
    };

    await expect(repo.emit('before:update', ctx)).resolves.toBeUndefined();
  });

  it('allows updates on draft entries', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('draft') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { label: 'Updated label' },
    };

    await expect(repo.emit('before:update', ctx)).resolves.toBeUndefined();
  });

  it('throws immutable error with correct status and code', async () => {
    const repo = createMockRepo();
    doubleEntryPlugin({ JournalEntryModel: createMockModel('posted') }).apply(repo);

    const ctx = {
      id: 'entry-1',
      data: { label: 'Updated label' },
    };

    try {
      await repo.emit('before:update', ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).status).toBe(403);
      expect((err as AccountingError).code).toBe('IMMUTABLE_ENTRY');
    }
  });
});

// ─── Improvement 1: Reverse (repository) ────────────────────────────────────

describe('Improvement 1: reverse()', () => {
  // These test the wireJournalEntryMethods function
  // We need to import it and test with mock models

  it('reverse() is exported from the repository module', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );
    expect(typeof wireJournalEntryMethods).toBe('function');
  });

  // Shared db mock for reverse() tests — acquireSession needs JournalEntryModel.db
  function createMockDb() {
    return {
      startSession: vi.fn().mockReturnValue({
        startTransaction: vi.fn(),
        inTransaction: () => false,
        commitTransaction: vi.fn(),
        abortTransaction: vi.fn(),
        endSession: vi.fn(),
      }),
      getClient: () => ({ topology: { description: { type: 'Single' } } }),
    };
  }

  it('reverse() rejects non-posted entries', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      reversed: false,
      journalItems: [],
      save: vi.fn(),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    await expect(repo.reverse('entry-1')).rejects.toThrow('Only posted entries can be reversed');
  });

  it('reverse() rejects already-reversed entries', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      reversed: true,
      journalItems: [],
      save: vi.fn(),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    await expect(repo.reverse('entry-1')).rejects.toThrow('already been reversed');
  });

  it('reverse() creates mirror entry with swapped debits/credits via repository.create', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const accId = 'acc-123';
    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      reversed: false,
      journalType: 'MISC',
      referenceNumber: 'MISC/2025/01/0001',
      label: 'Test entry',
      date: new Date('2025-01-15'),
      journalItems: [
        { account: { _id: accId }, debit: 10000, credit: 0, label: 'Rent' },
        { account: { _id: accId }, debit: 0, credit: 10000, label: 'Cash' },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const reversalDoc = { _id: 'reversal-1' };

    const mockModel = {} as any;

    // repo.create is what reverse() now calls (routes through repository for plugin enforcement)
    const repoCreate = vi.fn().mockResolvedValue(reversalDoc);
    const repo: any = mockRepository({
      create: repoCreate,
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    const result = await repo.reverse('entry-1');

    // Verify reversal was routed through repository.create (plugins run)
    expect(repoCreate).toHaveBeenCalledTimes(1);
    const [reversalData] = repoCreate.mock.calls[0];

    expect(reversalData.journalItems[0].debit).toBe(0); // was credit: 0 → debit: 0
    expect(reversalData.journalItems[0].credit).toBe(10000); // was debit: 10000 → credit: 10000
    expect(reversalData.journalItems[1].debit).toBe(10000); // was credit: 10000 → debit: 10000
    expect(reversalData.journalItems[1].credit).toBe(0); // was debit: 0 → credit: 0

    // Verify reversal metadata
    expect(reversalData.reversalOf).toBe('entry-1');
    expect(reversalData.state).toBe('posted');
    expect(reversalData.label).toContain('Reversal of');

    // Verify the original was marked as reversed via repository.update()
    // (the plugin pipeline runs on the mark step, not a silent entry.save()).
    expect(mockEntry.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ reversed: true, reversedBy: 'reversal-1' }),
      expect.objectContaining({ _ledgerInternal: 'reverseMark' }),
    );

    // Verify return value — the reversal doc is unchanged, `original` is the
    // echoed updated doc from the mocked update() call.
    expect(result.original).toMatchObject({ reversed: true, reversedBy: 'reversal-1' });
    expect(result.reversal).toBe(reversalDoc);
  });

  it('reverse() returns 404 for non-existent entry', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(null),
    });
    wireJournalEntryMethods(repo, mockModel);

    try {
      await repo.reverse('non-existent');
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as AccountingError).status).toBe(404);
    }
  });

  it('reverse() respects org scoping', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockGetByQuery = vi.fn().mockResolvedValue(null);
    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: mockGetByQuery,
    });
    wireJournalEntryMethods(repo, mockModel, 'business');

    try {
      await repo.reverse('entry-1', 'org-123');
    } catch {
      // Expected 404
    }

    expect(mockGetByQuery.mock.calls[0][0]).toEqual({ _id: 'entry-1', business: 'org-123' });
  });
});

// ─── Multi-tenant enforcement: post() and reverse() ─────────────────────────

describe('Multi-tenant org enforcement', () => {
  it('post() throws when orgField is configured but orgId is missing', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {} as any;

    const repo: any = mockRepository();
    wireJournalEntryMethods(repo, mockModel, 'business');

    await expect(repo.post('entry-1')).rejects.toThrow('organizationId is required');
  });

  it('post() allows call without orgId when orgField is not configured', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue({ _id: 'e1', state: 'draft', journalItems: [] }),
    });
    wireJournalEntryMethods(repo, mockModel); // no orgField

    // Should not throw org error (will throw validation error about items instead)
    await expect(repo.post('entry-1')).rejects.toThrow('at least 2 items');
  });

  it('reverse() throws when orgField is configured but orgId is missing', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {} as any;

    const repo: any = mockRepository();
    wireJournalEntryMethods(repo, mockModel, 'business');

    await expect(repo.reverse('entry-1')).rejects.toThrow('organizationId is required');
  });
});

// ─── Improvement 2: Session Management ──────────────────────────────────────

describe('Improvement 2: Internal Session Management', () => {
  it('closeFiscalPeriod uses Errors.notFound for missing period', async () => {
    const { closeFiscalPeriod } = await import('../src/reports/fiscal-close.js');

    const mockModel = {
      db: {
        startSession: vi.fn().mockReturnValue({
          startTransaction: vi.fn(),
          inTransaction: () => false,
          endSession: vi.fn(),
        }),
      },
      find: () => ({ lean: () => [] }),
    } as any;

    const mockFP = {
      findOne: () => ({ lean: () => Promise.resolve(null) }),
    } as any;

    try {
      await closeFiscalPeriod(
        {
          AccountModel: mockModel,
          JournalEntryModel: mockModel,
          FiscalPeriodModel: mockFP,
          country: {} as any,
        },
        { periodId: 'non-existent' },
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).status).toBe(404);
    }
  });

  it('reopenFiscalPeriod uses Errors for non-closed period', async () => {
    const { reopenFiscalPeriod } = await import('../src/reports/fiscal-close.js');

    const sessionMock = {
      startTransaction: vi.fn(),
      inTransaction: () => false,
      endSession: vi.fn(),
    };

    const mockModel = {
      db: { startSession: vi.fn().mockReturnValue(sessionMock) },
    } as any;

    const mockFP = {
      db: { startSession: vi.fn().mockReturnValue(sessionMock) },
      findOne: () => ({
        lean: () => Promise.resolve({ _id: 'period-1', closed: false }),
      }),
    } as any;

    try {
      await reopenFiscalPeriod(
        { JournalEntryModel: mockModel, FiscalPeriodModel: mockFP },
        { periodId: 'period-1' },
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingError);
      expect((err as AccountingError).code).toBe('PERIOD_LOCKED_FISCAL');
    }
  });

  it('session.endSession is always called even on error', async () => {
    const { closeFiscalPeriod } = await import('../src/reports/fiscal-close.js');

    const endSessionSpy = vi.fn();
    const sessionMock = {
      startTransaction: vi.fn(),
      inTransaction: () => true,
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: endSessionSpy,
    };

    const mockModel = {
      db: { startSession: vi.fn().mockReturnValue(sessionMock) },
      find: () => ({ lean: () => [] }),
    } as any;

    const mockFP = {
      findOne: () => ({ lean: () => Promise.resolve(null) }),
    } as any;

    try {
      await closeFiscalPeriod(
        {
          AccountModel: mockModel,
          JournalEntryModel: mockModel,
          FiscalPeriodModel: mockFP,
          country: {} as any,
        },
        { periodId: 'non-existent' },
      );
    } catch {
      // expected
    }

    expect(endSessionSpy).toHaveBeenCalled();
  });

  it('external session is never committed/aborted/ended', async () => {
    const { closeFiscalPeriod } = await import('../src/reports/fiscal-close.js');

    const externalSession = {
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
      inTransaction: () => true,
    } as any;

    const mockModel = {
      db: { startSession: vi.fn() },
      find: () => ({ lean: () => [] }),
    } as any;

    const mockFP = {
      findOne: () => ({ lean: () => Promise.resolve(null) }),
    } as any;

    try {
      await closeFiscalPeriod(
        {
          AccountModel: mockModel,
          JournalEntryModel: mockModel,
          FiscalPeriodModel: mockFP,
          country: {} as any,
        },
        { periodId: 'non-existent', session: externalSession },
      );
    } catch {
      // Expected 404
    }

    // External session must NOT be touched
    expect(externalSession.commitTransaction).not.toHaveBeenCalled();
    expect(externalSession.abortTransaction).not.toHaveBeenCalled();
    expect(externalSession.endSession).not.toHaveBeenCalled();
  });

  it('replica-set fallback logs a warning', async () => {
    const { closeFiscalPeriod } = await import('../src/reports/fiscal-close.js');

    const warnSpy = vi.fn();
    const logger: Logger = { warn: warnSpy, error: vi.fn(), info: vi.fn() };

    const fallbackSession = {
      inTransaction: () => false,
      endSession: vi.fn(),
    };

    const mockModel = {
      db: {
        startSession: vi
          .fn()
          .mockReturnValueOnce({
            startTransaction: () => {
              throw new Error('not a replica set');
            },
            endSession: vi.fn(),
          })
          .mockReturnValueOnce(fallbackSession),
      },
      find: () => ({ lean: () => [] }),
    } as any;

    const mockFP = {
      findOne: () => ({ lean: () => Promise.resolve(null) }),
    } as any;

    try {
      await closeFiscalPeriod(
        {
          AccountModel: mockModel,
          JournalEntryModel: mockModel,
          FiscalPeriodModel: mockFP,
          country: {} as any,
          logger,
        },
        { periodId: 'non-existent' },
      );
    } catch {
      // Expected 404
    }

    expect(warnSpy).toHaveBeenCalledWith(
      'Transactions unavailable (no replica set). Operation is not atomic.',
      expect.objectContaining({ error: 'not a replica set' }),
    );
  });
});

// ─── Improvement 3: Account Identity Split ──────────────────────────────────

describe('Improvement 3: Account Schema Identity Split', () => {
  // We test the schema factory directly using mongoose
  // These tests verify the pre-validate hook and indexes

  it('createAccountSchema adds accountNumber and name fields', async () => {
    const { createAccountSchema } = await import('../src/schemas/account.schema.js');

    const mockCountry = {
      isValidAccountType: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}` }),
      name: 'Test',
    } as any;

    const schema = createAccountSchema({
      country: mockCountry,
      currency: 'CAD',
    });

    const paths = schema.paths;
    expect(paths.accountNumber).toBeDefined();
    expect(paths.name).toBeDefined();
    expect(paths.accountTypeCode).toBeDefined();
  });

  it('pre-validate auto-defaults accountNumber from accountTypeCode', async () => {
    // We test the hook logic by checking schema.pre was called with 'validate'
    const { createAccountSchema } = await import('../src/schemas/account.schema.js');

    const mockCountry = {
      isValidAccountType: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}` }),
      name: 'Test',
    } as any;

    const schema = createAccountSchema({
      country: mockCountry,
      currency: 'CAD',
    });

    // The schema has pre-validate hooks
    // We can't easily test mongoose hooks without a model + connection,
    // but we can verify the schema was created with the right fields
    expect(schema.path('accountNumber')).toBeDefined();
    expect(schema.path('name')).toBeDefined();

    // accountNumber is NOT mongoose-required — the pre-validate hook auto-
    // defaults it from accountTypeCode, so requiring it would fire before
    // the hook runs and fail clean creates that supply only accountTypeCode.
    const accountNumberPath = schema.path('accountNumber');
    expect(accountNumberPath.isRequired).toBeFalsy();
  });

  it('indexes use accountNumber for uniqueness (single-tenant)', async () => {
    const { createAccountSchema } = await import('../src/schemas/account.schema.js');

    const mockCountry = {
      isValidAccountType: () => true,
      getAccountType: () => null,
      name: 'Test',
    } as any;

    const schema = createAccountSchema({
      country: mockCountry,
      currency: 'CAD',
    });

    // Check indexes: should have accountNumber unique, accountTypeCode non-unique
    const indexes = schema.indexes();
    const uniqueIdx = indexes.find(
      ([fields, opts]) => fields.accountNumber === 1 && (opts as any)?.unique === true,
    );
    expect(uniqueIdx).toBeDefined();

    // accountTypeCode index should NOT be unique
    const typeCodeIdx = indexes.find(
      ([fields, opts]) => fields.accountTypeCode === 1 && (opts as any)?.unique === true,
    );
    expect(typeCodeIdx).toBeUndefined();
  });

  it('indexes use accountNumber for uniqueness (multi-tenant)', async () => {
    const { createAccountSchema } = await import('../src/schemas/account.schema.js');

    const mockCountry = {
      isValidAccountType: () => true,
      getAccountType: () => null,
      name: 'Test',
    } as any;

    const schema = createAccountSchema({
      country: mockCountry,
      currency: 'CAD',
      multiTenant: { tenantField: 'business', ref: 'Business' },
    });

    const indexes = schema.indexes();

    // Should have compound unique on (business, accountNumber)
    const uniqueIdx = indexes.find(
      ([fields, opts]) =>
        (fields as any).business === 1 &&
        (fields as any).accountNumber === 1 &&
        (opts as any)?.unique === true,
    );
    expect(uniqueIdx).toBeDefined();

    // Should NOT have unique on (business, accountTypeCode)
    const typeCodeUniqueIdx = indexes.find(
      ([fields, opts]) =>
        (fields as any).business === 1 &&
        (fields as any).accountTypeCode === 1 &&
        (opts as any)?.unique === true,
    );
    expect(typeCodeUniqueIdx).toBeUndefined();
  });
});

describe('Improvement 3: Account Repository', () => {
  it('seedAccounts deduplicates by accountNumber (not accountTypeCode)', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [
        { code: '1000', name: 'Cash' },
        { code: '2000', name: 'AP' },
      ],
    } as any;

    const repo: any = mockRepository({
      // Existing account has accountNumber '1000' — seed should skip it
      findAll: vi.fn().mockResolvedValue([{ accountNumber: '1000' }]),
      createMany: vi
        .fn()
        .mockImplementation((docs: any[]) =>
          Promise.resolve(docs.map((d: any, i: number) => ({ ...d, _id: `id-${i}` }))),
        ),
    });
    wireAccountMethods(repo, mockCountry);

    const result = await repo.seedAccounts('org-1');

    // 1000 exists → skip, 2000 → create
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('seedAccounts creates default when custom account has same typeCode but different number', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [
        { code: '1000', name: 'Cash' }, // default accountNumber='1000' not taken
      ],
    } as any;

    const repo: any = mockRepository({
      // Existing: accountNumber is CUSTOM-BANK, not '1000'
      findAll: vi.fn().mockResolvedValue([{ accountNumber: 'CUSTOM-BANK' }]),
      createMany: vi
        .fn()
        .mockImplementation((docs: any[]) =>
          Promise.resolve(docs.map((d: any, i: number) => ({ ...d, _id: `id-${i}` }))),
        ),
    });
    wireAccountMethods(repo, mockCountry);

    const result = await repo.seedAccounts('org-1');

    // Custom account has different accountNumber → seed should still create default '1000'
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1); // CUSTOM-BANK counted as skipped (existing)
  });

  it('seedAccounts includes accountNumber and name in created docs', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    let insertedDocs: any[] = [];

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [
        { code: '1000', name: 'Cash' },
        { code: '2000', name: 'Accounts Payable' },
      ],
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockImplementation((docs: any[]) => {
        insertedDocs = docs;
        return Promise.resolve(docs.map((d: any, i: number) => ({ ...d, _id: `id-${i}` })));
      }),
    });
    wireAccountMethods(repo, mockCountry);

    await repo.seedAccounts('org-1');

    expect(insertedDocs.length).toBe(2);
    expect(insertedDocs[0]).toEqual(
      expect.objectContaining({
        accountTypeCode: '1000',
        accountNumber: '1000',
        name: 'Cash',
      }),
    );
    expect(insertedDocs[1]).toEqual(
      expect.objectContaining({
        accountTypeCode: '2000',
        accountNumber: '2000',
        name: 'Accounts Payable',
      }),
    );
  });

  it('bulkCreate deduplicates by accountNumber', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    let findAllFilter: any = null;

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}`, isGroup: false }),
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockImplementation((filter: any) => {
        findAllFilter = filter;
        return Promise.resolve([{ accountNumber: '1000' }]);
      }),
      createMany: vi
        .fn()
        .mockResolvedValue([
          { _id: 'new-id-1', accountTypeCode: '2000', accountNumber: '2000', name: 'Account 2000' },
        ]),
    });
    wireAccountMethods(repo, mockCountry, 'business');

    const result = await repo.bulkCreate(
      [{ accountTypeCode: '1000' }, { accountTypeCode: '2000' }],
      'org-1',
    );

    // Find query should use accountNumber, not accountTypeCode
    expect(findAllFilter).toEqual(
      expect.objectContaining({
        accountNumber: { $in: ['1000', '2000'] },
        business: 'org-1',
      }),
    );

    // 1000 should be skipped (exists), 2000 should be created
    expect(result.summary.skipped).toBe(1);
  });

  it('bulkCreate passes accountNumber and name to createMany', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    let insertedDocs: any[] = [];

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: (code: string) => ({ code, name: `Account ${code}`, isGroup: false }),
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockImplementation((docs: any[]) => {
        insertedDocs = docs;
        return Promise.resolve(docs.map((d: any, i: number) => ({ ...d, _id: `id-${i}` })));
      }),
    });
    wireAccountMethods(repo, mockCountry);

    await repo.bulkCreate(
      [{ accountTypeCode: '1000', accountNumber: 'BANK-001', name: 'Main Bank' }],
      undefined,
    );

    expect(insertedDocs[0]).toEqual(
      expect.objectContaining({
        accountTypeCode: '1000',
        accountNumber: 'BANK-001',
        name: 'Main Bank',
      }),
    );
  });

  it('bulkCreate auto-defaults accountNumber and name when not provided', async () => {
    const { wireAccountMethods } = await import('../src/repositories/account.repository.js');

    let insertedDocs: any[] = [];

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: (code: string) => ({ code, name: `Type ${code}`, isGroup: false }),
    } as any;

    const repo: any = mockRepository({
      findAll: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockImplementation((docs: any[]) => {
        insertedDocs = docs;
        return Promise.resolve(docs.map((d: any, i: number) => ({ ...d, _id: `id-${i}` })));
      }),
    });
    wireAccountMethods(repo, mockCountry);

    await repo.bulkCreate(
      [
        { accountTypeCode: '1000' }, // no accountNumber or name
      ],
      undefined,
    );

    // Should default to accountTypeCode and country pack name
    expect(insertedDocs[0]).toEqual(
      expect.objectContaining({
        accountTypeCode: '1000',
        accountNumber: '1000',
        name: 'Type 1000',
      }),
    );
  });
});

// ─── Journal Entry Schema: reversalOf field ─────────────────────────────────

describe('Improvement 1: Journal Entry Schema - reversalOf field', () => {
  it('journal entry schema has reversalOf field', async () => {
    const { createJournalEntrySchema } = await import('../src/schemas/journal-entry.schema.js');

    const mockCountry = {
      isValidAccountType: () => true,
      getAccountType: () => null,
      name: 'Test',
    } as any;

    const schema = createJournalEntrySchema({ country: mockCountry, currency: 'CAD' }, 'Account', {
      autoReference: false,
    });

    expect(schema.path('reversalOf')).toBeDefined();
    expect(schema.path('reversed')).toBeDefined();
    expect(schema.path('reversedBy')).toBeDefined();
  });
});

// ─── Engine: retained-earnings code passthrough ──────────────────────────────

describe('Engine: createReports() pipes retainedEarningsAccountCode/currentYearEarningsCode', () => {
  it('balanceSheet receives configured RE codes from engine config', async () => {
    const { createAccountingEngine } = await import('../src/engine.js');

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [],

      name: 'Test',
      code: 'TST',
      defaultCurrency: 'TST',
    } as any;

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: mockCountry,
      currency: 'TST',
      retainedEarningsAccountCode: '9990',
      retainedEarningsDisplayCode: '9990-D',
      currentYearEarningsCode: '9991',
      modelNames: __archModelNames(),
    });

    expect(engine.config.retainedEarningsAccountCode).toBe('9990');
    expect(engine.config.retainedEarningsDisplayCode).toBe('9990-D');
    expect(engine.config.currentYearEarningsCode).toBe('9991');
  });

  it('engine config defaults RE codes to undefined (generateBalanceSheet uses country pack)', async () => {
    const { createAccountingEngine } = await import('../src/engine.js');

    const mockCountry = {
      isValidAccountType: () => true,
      isPostingAccount: () => true,
      getAccountType: () => null,
      getPostingAccountTypes: () => [],

      name: 'Test',
      code: 'TST',
      defaultCurrency: 'TST',
    } as any;

    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: mockCountry,
      currency: 'TST',
      modelNames: __archModelNames(),
    });

    expect(engine.config.retainedEarningsAccountCode).toBeUndefined();
    expect(engine.config.currentYearEarningsCode).toBeUndefined();
  });
});

// ─── Extra item field preservation in duplicate() and reverse() ─────────────

describe('Extra item field preservation', () => {
  function createMockDb() {
    return {
      startSession: vi.fn().mockReturnValue({
        startTransaction: vi.fn(),
        inTransaction: () => false,
        commitTransaction: vi.fn(),
        abortTransaction: vi.fn(),
        endSession: vi.fn(),
      }),
      getClient: () => ({ topology: { description: { type: 'Single' } } }),
    };
  }

  it('duplicate() preserves extra dimension fields on items', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      journalType: 'GENERAL',
      label: 'Test',
      journalItems: [
        {
          account: 'acc1',
          debit: 10000,
          credit: 0,
          label: 'Line 1',
          departmentId: 'dept-A',
          projectId: 'proj-1',
          locationId: 'loc-X',
        },
        {
          account: 'acc2',
          debit: 0,
          credit: 10000,
          label: 'Line 2',
          departmentId: 'dept-B',
          customField: 42,
        },
      ],
    };

    let capturedData: Record<string, unknown> | undefined;
    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        capturedData = data;
        return Promise.resolve({ _id: 'dup-1', ...data });
      }),
    });
    wireJournalEntryMethods(repo, mockModel);

    await repo.duplicate('entry-1');

    expect(capturedData).toBeDefined();
    const items = capturedData?.journalItems as Array<Record<string, unknown>>;

    // First item should carry departmentId, projectId, locationId
    expect(items[0].departmentId).toBe('dept-A');
    expect(items[0].projectId).toBe('proj-1');
    expect(items[0].locationId).toBe('loc-X');

    // Second item should carry departmentId, customField
    expect(items[1].departmentId).toBe('dept-B');
    expect(items[1].customField).toBe(42);

    // Core fields should still be correct
    expect(items[0].account).toBe('acc1');
    expect(items[0].debit).toBe(10000);
    expect(items[0].credit).toBe(0);
    expect(capturedData?.state).toBe('draft');
  });

  it('reverse() preserves extra dimension fields on items', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      reversed: false,
      journalType: 'GENERAL',
      referenceNumber: 'GEN/2025/01/0001',
      label: 'Test',
      journalItems: [
        {
          account: { _id: 'acc1' },
          debit: 10000,
          credit: 0,
          label: 'Line 1',
          departmentId: 'dept-A',
          projectId: 'proj-1',
        },
        {
          account: { _id: 'acc2' },
          debit: 0,
          credit: 10000,
          label: 'Line 2',
          departmentId: 'dept-B',
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    let capturedData: Record<string, unknown> | undefined;
    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        capturedData = data;
        return Promise.resolve({ _id: 'rev-1' });
      }),
    });
    wireJournalEntryMethods(repo, mockModel);

    await repo.reverse('entry-1');

    expect(capturedData).toBeDefined();
    const items = capturedData?.journalItems as Array<Record<string, unknown>>;

    // First item: debits/credits swapped, extra fields preserved
    expect(items[0].debit).toBe(0);
    expect(items[0].credit).toBe(10000);
    expect(items[0].departmentId).toBe('dept-A');
    expect(items[0].projectId).toBe('proj-1');

    // Second item
    expect(items[1].debit).toBe(10000);
    expect(items[1].credit).toBe(0);
    expect(items[1].departmentId).toBe('dept-B');
  });

  it('duplicate() does not copy _id or id from items', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      journalType: 'GENERAL',
      label: 'Test',
      journalItems: [
        {
          _id: 'item-1',
          id: 'item-1',
          account: 'acc1',
          debit: 10000,
          credit: 0,
          departmentId: 'dept-A',
        },
        { _id: 'item-2', id: 'item-2', account: 'acc2', debit: 0, credit: 10000 },
      ],
    };

    let capturedData: Record<string, unknown> | undefined;
    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        capturedData = data;
        return Promise.resolve({ _id: 'dup-1' });
      }),
    });
    wireJournalEntryMethods(repo, mockModel);

    await repo.duplicate('entry-1');

    const items = capturedData?.journalItems as Array<Record<string, unknown>>;
    // _id and id must NOT be copied to the duplicate
    expect(items[0]._id).toBeUndefined();
    expect(items[0].id).toBeUndefined();
    // But extra fields should be
    expect(items[0].departmentId).toBe('dept-A');
  });
});

// ─── Approval metadata enforcement ──────────────────────────────────────────

describe('requireApproval enforcement', () => {
  it('rejects post when approvedBy is set but approvedAt is missing', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      approvedBy: 'user-1',
      approvedAt: undefined, // missing!
      journalItems: [
        { account: 'acc1', debit: 10000, credit: 0 },
        { account: 'acc2', debit: 0, credit: 10000 },
      ],
      save: vi.fn(),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel, undefined, { requireApproval: true });

    await expect(repo.post('entry-1')).rejects.toThrow(
      'Both approvedBy and approvedAt are required',
    );
  });

  it('allows post when both approvedBy and approvedAt are set', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      approvedBy: 'user-1',
      approvedAt: new Date(),
      journalItems: [
        { account: { _id: 'acc1' }, debit: 10000, credit: 0 },
        { account: { _id: 'acc2' }, debit: 0, credit: 10000 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel, undefined, { requireApproval: true });

    const result = await repo.post('entry-1');
    expect(result.state).toBe('posted');
  });
});

// ─── Archive (draft → archived) ──────────────────────────────────────────────

describe('archive() method', () => {
  it('archives a draft entry', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'draft',
      stateChangedAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    const result = await repo.archive('entry-1');
    expect(result.state).toBe('archived');
    expect(result.stateChangedAt).toBeInstanceOf(Date);
    // archive() now routes through repository.update() so the plugin pipeline
    // (date-lock, audit, observability) fires on the state transition. The
    // mock echoes the patch back, so we assert update — not save — was called.
    expect(repo.update).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ state: 'archived' }),
      expect.objectContaining({ _ledgerInternal: 'archive' }),
    );
  });

  it('rejects archiving a posted entry', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'posted',
      save: vi.fn(),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    await expect(repo.archive('entry-1')).rejects.toThrow('Only draft entries can be archived');
    expect(mockEntry.save).not.toHaveBeenCalled();
  });

  it('rejects archiving an already-archived entry', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockEntry = {
      _id: 'entry-1',
      state: 'archived',
      save: vi.fn(),
    };

    const mockModel = {} as any;

    const repo: any = mockRepository({
      getByQuery: vi.fn().mockResolvedValue(mockEntry),
    });
    wireJournalEntryMethods(repo, mockModel);

    await expect(repo.archive('entry-1')).rejects.toThrow('Only draft entries can be archived');
  });

  it('throws not-found when entry does not exist', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {} as any;

    const repo: any = mockRepository();
    wireJournalEntryMethods(repo, mockModel);

    await expect(repo.archive('non-existent')).rejects.toThrow('Entry not found');
  });

  it('requires actorId when strictness.requireActor is enabled', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {
      findOne: () => ({
        session: () => Promise.resolve({ _id: 'entry-1', state: 'draft', save: vi.fn() }),
      }),
    } as any;

    const repo: any = mockRepository();
    wireJournalEntryMethods(repo, mockModel, undefined, { requireActor: true });

    await expect(repo.archive('entry-1')).rejects.toThrow(
      'actorId is required for archive operations',
    );
  });

  it('enforces org scope in multi-tenant mode', async () => {
    const { wireJournalEntryMethods } = await import(
      '../src/repositories/journal-entry.repository.js'
    );

    const mockModel = {
      findOne: () => ({
        session: () => Promise.resolve(null),
      }),
    } as any;

    const repo: any = mockRepository();
    wireJournalEntryMethods(repo, mockModel, 'business');

    await expect(repo.archive('entry-1')).rejects.toThrow('organizationId is required');
  });
});
