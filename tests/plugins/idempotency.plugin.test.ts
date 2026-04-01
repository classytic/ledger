import { describe, it, expect } from 'vitest';
import { idempotencyPlugin } from '../../src/plugins/idempotency.plugin.js';
import { createMockRepository } from '../helpers/mock-repository.js';

/** Mock JournalEntryModel that returns the given result from findOne */
function createMockJEModel(existing: Record<string, unknown> | null = null) {
  return {
    findOne: () => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve(existing),
        }),
      }),
    }),
  };
}

describe('idempotencyPlugin', () => {
  it('has the correct plugin name', () => {
    const plugin = idempotencyPlugin({
      JournalEntryModel: createMockJEModel() as any,
    });
    expect(plugin.name).toBe('accounting:idempotency');
  });

  it('does nothing when no idempotencyKey is provided', async () => {
    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: createMockJEModel() as any,
    }).apply(repo);

    const data = { label: 'Some entry' };
    await expect(repo._emitHook('before:create', { data })).resolves.toBeUndefined();
  });

  it('allows creation when no existing entry has the same idempotency key', async () => {
    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: createMockJEModel(null) as any,
    }).apply(repo);

    const data = { idempotencyKey: 'unique-key-123' };
    await expect(repo._emitHook('before:create', { data })).resolves.toBeUndefined();
  });

  it('throws 409 conflict when a duplicate idempotency key exists', async () => {
    const repo = createMockRepository();
    const existingEntry = { _id: 'existing-entry-id' };
    idempotencyPlugin({
      JournalEntryModel: createMockJEModel(existingEntry) as any,
    }).apply(repo);

    const data = { idempotencyKey: 'duplicate-key' };
    await expect(repo._emitHook('before:create', { data })).rejects.toThrow(
      'Duplicate idempotency key: "duplicate-key"',
    );
  });

  it('throws error with status 409 and CONFLICT code', async () => {
    const repo = createMockRepository();
    const existingEntry = { _id: 'abc123' };
    idempotencyPlugin({
      JournalEntryModel: createMockJEModel(existingEntry) as any,
    }).apply(repo);

    const data = { idempotencyKey: 'dup' };
    try {
      await repo._emitHook('before:create', { data });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(409);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toContain('abc123');
    }
  });

  it('scopes the duplicate check by orgField when provided', async () => {
    const queries: Record<string, unknown>[] = [];
    const mockModel = {
      findOne: (query: Record<string, unknown>) => {
        queries.push(query);
        return {
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve(null),
            }),
          }),
        };
      },
    };

    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: mockModel as any,
      orgField: 'business',
    }).apply(repo);

    const data = { idempotencyKey: 'key-1', business: 'org-42' };
    await repo._emitHook('before:create', { data });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({
      idempotencyKey: 'key-1',
      business: 'org-42',
    });
  });

  it('does not include orgField in query when orgField value is missing from data', async () => {
    const queries: Record<string, unknown>[] = [];
    const mockModel = {
      findOne: (query: Record<string, unknown>) => {
        queries.push(query);
        return {
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve(null),
            }),
          }),
        };
      },
    };

    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: mockModel as any,
      orgField: 'business',
    }).apply(repo);

    const data = { idempotencyKey: 'key-2' }; // no business field
    await repo._emitHook('before:create', { data });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({ idempotencyKey: 'key-2' });
  });

  it('passes session from context to findOne', async () => {
    let receivedSession: unknown = undefined;
    const mockModel = {
      findOne: () => ({
        select: () => ({
          session: (s: unknown) => {
            receivedSession = s;
            return { lean: () => Promise.resolve(null) };
          },
        }),
      }),
    };

    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: mockModel as any,
    }).apply(repo);

    const fakeSession = { id: 'test-session' };
    const data = { idempotencyKey: 'key-3' };
    await repo._emitHook('before:create', { data, session: fakeSession });

    expect(receivedSession).toBe(fakeSession);
  });

  it('passes null session when context has no session', async () => {
    let receivedSession: unknown = 'not-set';
    const mockModel = {
      findOne: () => ({
        select: () => ({
          session: (s: unknown) => {
            receivedSession = s;
            return { lean: () => Promise.resolve(null) };
          },
        }),
      }),
    };

    const repo = createMockRepository();
    idempotencyPlugin({
      JournalEntryModel: mockModel as any,
    }).apply(repo);

    const data = { idempotencyKey: 'key-4' };
    await repo._emitHook('before:create', { data });

    expect(receivedSession).toBeNull();
  });
});
