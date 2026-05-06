/**
 * Mock Repository — conforms to Repository<unknown> from @classytic/mongokit.
 *
 * Enforces the same contract that production code uses.
 * All CRUD methods are vi.fn() mocks with sensible defaults.
 */

import type { Repository } from '@classytic/mongokit';
import { vi } from 'vitest';

/**
 * Create a mock Repository<unknown> with all required methods.
 * Override any method by passing it in the overrides object.
 *
 * @example
 * ```ts
 * const repo = mockRepository({ getByQuery: vi.fn().mockResolvedValue(mockEntry) });
 * wireJournalEntryMethods(repo, mockModel);
 * ```
 */
export function mockRepository(overrides: Record<string, unknown> = {}): Repository<unknown> {
  const hooks = new Map<string, Array<(ctx: unknown) => void | Promise<void>>>();

  const base: Record<string, unknown> = {
    // Hook system
    on: vi.fn((event: string, handler: (ctx: unknown) => void | Promise<void>) => {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event)?.push(handler);
      return base;
    }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    emit: vi.fn(),
    emitAsync: vi.fn(),
    use: vi.fn(),

    // CRUD
    create: vi.fn().mockResolvedValue({ _id: 'mock-id' }),
    createMany: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    getByQuery: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue({
      method: 'offset',
      docs: [],
      total: 0,
      page: 1,
      limit: 10,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    }),
    // Echo back the patched doc so journal-entry post/unpost/archive helpers
    // (which route through repository.update so plugins fire) return a value
    // that callers can assert against. Tests overriding `update` keep their
    // own behaviour.
    update: vi.fn().mockImplementation(async (_id: unknown, patch: Record<string, unknown>) => ({
      _id,
      ...patch,
    })),
    // mongokit 3.13's `claim()` — atomic state-machine CAS. The mock
    // mirrors mongokit's auto-injection behaviour: for non-noop
    // transitions (`from !== to`), the state field is automatically
    // applied to `$set` from `transition.to`. State-noop transitions
    // (e.g. reverseMark) leave the state field untouched. The mock also
    // returns null when the from-state on the cached doc doesn't match
    // (basic CAS simulation).
    claim: vi.fn().mockImplementation(
      async (
        id: unknown,
        transition: { field?: string; from?: unknown; to?: unknown; where?: unknown },
        patch: Record<string, unknown> = {},
      ) => {
        const stateField = transition.field ?? 'state';
        const $set = { ...((patch.$set ?? {}) as Record<string, unknown>) };
        const isStateNoop = !Array.isArray(transition.from) && transition.from === transition.to;
        if (!isStateNoop && transition.to !== undefined) {
          $set[stateField] = transition.to;
        }
        return { _id: id, ...$set };
      },
    ),
    // mongokit 3.13's atomic `findOneAndUpdate` — used by the
    // reconciliation matching-number counter so the counter bump goes
    // through the plugin pipeline (multi-tenant, audit, cache).
    findOneAndUpdate: vi
      .fn()
      .mockImplementation(
        async (
          _filter: Record<string, unknown>,
          update: Record<string, unknown>,
        ) => {
          const $inc = (update.$inc ?? {}) as Record<string, number>;
          const seq = ($inc.seq ?? 0) + 1;
          return { seq };
        },
      ),
    delete: vi.fn().mockResolvedValue({ success: true, message: 'deleted' }),
    findAll: vi.fn().mockResolvedValue([]),
    getOne: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(null),
    distinct: vi.fn().mockResolvedValue([]),
    getOrCreate: vi.fn().mockResolvedValue(null),

    // Aggregation
    aggregate: vi.fn().mockResolvedValue([]),
    aggregatePaginate: vi.fn().mockResolvedValue({
      method: 'aggregate',
      docs: [],
      total: 0,
      page: 1,
      limit: 10,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    }),
    lookupPopulate: vi.fn().mockResolvedValue({ data: [], total: 0, limit: 10 }),

    // Transactions
    withTransaction: vi
      .fn()
      .mockImplementation(async (cb: (session: unknown) => Promise<unknown>) => cb(null)),

    // Builders
    buildAggregation: vi.fn(),
    buildLookup: vi.fn(),

    // Model — `reverse()` reaches into `Model.db` to build a session-based
    // `withTransaction` helper for multi-collaborator workflows (the 3.10
    // instance method hands back a tx-bound repo, which doesn't fit).
    // Expose a fake session starter so the helper's `startSession()` returns
    // a stub session that just invokes the callback.
    Model: {
      db: {
        startSession: vi.fn().mockResolvedValue({
          withTransaction: vi.fn(async (cb: () => Promise<unknown>) => cb()),
          endSession: vi.fn(),
        }),
      },
    } as any,
    model: 'MockModel',

    // Internal
    _hooks: hooks,
    _pagination: {} as any,
    _hookMode: 'async',
    _hasTextIndex: null,
    _buildContext: vi.fn(),
    _handleError: vi.fn(),
    _executeQuery: vi.fn(),
    _parseSort: vi.fn(),

    // Hook dispatch — mirrors Repository._emitHook / _emitErrorHook
    _emitHook: vi.fn(async (event: string, data: unknown) => {
      const handlers = hooks.get(event) ?? [];
      for (const handler of handlers) {
        await handler(data);
      }
    }),
    _emitErrorHook: vi.fn(async (event: string, data: unknown) => {
      const handlers = hooks.get(event) ?? [];
      for (const handler of handlers) {
        try {
          await handler(data);
        } catch {
          // swallow — mirrors production behavior
        }
      }
    }),

    // registerMethod — must actually assign the method so wireJournalEntryMethods works
    registerMethod: vi.fn((name: string, fn: unknown) => {
      base[name] = fn;
    }),
    hasMethod: vi.fn().mockReturnValue(false),
  };

  // Apply overrides
  Object.assign(base, overrides);

  return base as unknown as Repository<unknown>;
}

/** Alias for plugin tests that use `createMockRepository()` */
export const createMockRepository = mockRepository;
