/**
 * Unit tests for `createLockPlugin` — the shared factory.
 *
 * We stub out the resolver (this isolates the factory's pipeline logic
 * from any particular scope shape). Integration coverage lives in
 * `tests/e2e/lock-scopes.test.ts`.
 */

import type { RepositoryContext } from '@classytic/mongokit';
import { describe, expect, it, vi } from 'vitest';
import { createLockPlugin } from '../../../src/plugins/lock/create-lock-plugin.js';
import type { LockHit, LockResolver } from '../../../src/plugins/lock/types.js';
import { createMockRepository } from '../../helpers/mock-repository.js';

function emit(
  repo: ReturnType<typeof createMockRepository>,
  event: 'before:create' | 'before:update',
  ctx: Partial<RepositoryContext>,
) {
  return (repo as unknown as { _emitHook: (e: string, c: unknown) => Promise<void> })._emitHook(
    event,
    ctx,
  );
}

const allowResolver: LockResolver = async () => null;
const blockResolver: LockResolver = async () => ({ scope: 'fiscal', label: 'Q1 2026' });

function stubJEModel(persisted: Record<string, unknown> | null) {
  return {
    findById: () => ({
      select: () => ({
        session: () => ({ lean: () => Promise.resolve(persisted) }),
      }),
    }),
  } as unknown as Parameters<typeof createLockPlugin>[0]['JournalEntryModel'];
}

describe('createLockPlugin — pipeline', () => {
  it('skips draft entries', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', resolve: blockResolver }).apply(repo);
    await expect(
      emit(repo, 'before:create', { data: { state: 'draft', date: new Date() } }),
    ).resolves.toBeUndefined();
  });

  it('does NOT skip on _ledgerInternal="post" — posting into a closed period must still be blocked', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', resolve: blockResolver }).apply(repo);
    await expect(
      emit(repo, 'before:update', {
        data: { state: 'posted', date: new Date('2026-02-15') },
        _ledgerInternal: 'post',
      }),
    ).rejects.toThrow(/Q1 2026/);
  });

  it('skips on _ledgerInternal="reverseMark" so reverse() can mark the original', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', resolve: blockResolver }).apply(repo);
    await expect(
      emit(repo, 'before:update', {
        data: { state: 'posted', date: new Date('2026-02-15'), reversed: true },
        _ledgerInternal: 'reverseMark',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws AccountingError with PERIOD_LOCKED_{SCOPE} code when resolver blocks', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', resolve: blockResolver }).apply(repo);
    try {
      await emit(repo, 'before:create', {
        data: { state: 'posted', date: new Date('2026-02-15') },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { code?: string; status?: number; name?: string };
      expect(e.name).toBe('AccountingError');
      expect(e.code).toBe('PERIOD_LOCKED_FISCAL');
      expect(e.status).toBe(409);
    }
  });

  it('defaults missing create date to now', async () => {
    const repo = createMockRepository();
    let received: Date | undefined;
    const resolver: LockResolver = async (ctx) => {
      received = ctx.entryDate;
      return null;
    };
    createLockPlugin({ scope: 'fiscal', resolve: resolver }).apply(repo);
    await emit(repo, 'before:create', { data: { state: 'posted' } });
    expect(received).toBeInstanceOf(Date);
  });

  it('resolves date from persisted doc on partial update', async () => {
    const repo = createMockRepository();
    let received: Date | undefined;
    createLockPlugin({
      scope: 'fiscal',
      JournalEntryModel: stubJEModel({ date: new Date('2025-12-31') }),
      resolve: async (ctx) => {
        received = ctx.entryDate;
        return null;
      },
    }).apply(repo);
    await emit(repo, 'before:update', {
      id: 'abc',
      data: { state: 'posted' },
    });
    expect(received?.toISOString()).toMatch(/^2025-12-31/);
  });

  it('throws when update has no id and no date', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', resolve: allowResolver }).apply(repo);
    await expect(
      emit(repo, 'before:update', { data: { state: 'posted' } }),
    ).rejects.toThrow(/missing "id"/);
  });

  it('refuses to run unscoped when orgField is configured and unresolved', async () => {
    const repo = createMockRepository();
    createLockPlugin({ scope: 'fiscal', orgField: 'orgId', resolve: allowResolver }).apply(repo);
    await expect(
      emit(repo, 'before:create', {
        data: { state: 'posted', date: new Date('2026-02-15') },
      }),
    ).rejects.toThrow(/orgField "orgId"/);
  });

  it('skips entirely when accountSelector matches no items', async () => {
    const repo = createMockRepository();
    const resolver = vi.fn(allowResolver);
    createLockPlugin({
      scope: 'tax',
      accountSelector: (acc) => acc.taxMetadata != null,
      AccountModel: {
        find: () => ({
          session: () => ({ lean: () => Promise.resolve([{ _id: 'a1' }, { _id: 'a2' }]) }),
        }),
      } as unknown as Parameters<typeof createLockPlugin>[0]['AccountModel'],
      resolve: resolver,
    }).apply(repo);

    await emit(repo, 'before:create', {
      data: {
        state: 'posted',
        date: new Date('2026-02-15'),
        journalItems: [{ account: 'a1' }, { account: 'a2' }],
      },
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('runs resolver when accountSelector matches at least one item', async () => {
    const repo = createMockRepository();
    const resolver = vi.fn(allowResolver);
    createLockPlugin({
      scope: 'tax',
      accountSelector: (acc) => acc.taxMetadata != null,
      AccountModel: {
        find: () => ({
          session: () => ({
            lean: () =>
              Promise.resolve([{ _id: 'a1' }, { _id: 'a2', taxMetadata: { taxType: 'VAT' } }]),
          }),
        }),
      } as unknown as Parameters<typeof createLockPlugin>[0]['AccountModel'],
      resolve: resolver,
    }).apply(repo);

    await emit(repo, 'before:create', {
      data: {
        state: 'posted',
        date: new Date('2026-02-15'),
        journalItems: [{ account: 'a1' }, { account: 'a2' }],
      },
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('throws if accountSelector is provided without AccountModel', () => {
    expect(() =>
      createLockPlugin({
        scope: 'tax',
        accountSelector: () => true,
        resolve: allowResolver,
      }),
    ).toThrow(/requires AccountModel/);
  });

  it('includes subType and externalRef in the error message', async () => {
    const repo = createMockRepository();
    const hit: LockHit = {
      scope: 'tax',
      label: 'BD-DHA',
      subType: 'VAT',
      externalRef: 'NBR-001',
    };
    createLockPlugin({
      scope: 'tax',
      resolve: async () => hit,
    }).apply(repo);
    try {
      await emit(repo, 'before:create', {
        data: { state: 'posted', date: new Date('2026-02-15') },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { message: string };
      expect(e.message).toContain('[VAT]');
      expect(e.message).toContain('BD-DHA');
      expect(e.message).toContain('NBR-001');
    }
  });
});
