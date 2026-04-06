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
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ success: true, message: 'deleted' }),
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

    // Model
    Model: {} as any,
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
