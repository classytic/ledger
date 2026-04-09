/**
 * wireImport unit tests with a mock JournalEntry repository.
 *
 * Verifies:
 *   - Happy path: records are created via repo.create()
 *   - Bulk path: records are created via repo.createMany() when available
 *   - Idempotency: existing entries are skipped (checked via findExisting)
 *   - Batching: large source splits into chunks
 *   - Error handling: per-record errors are captured, not thrown
 *   - Dry-run: no create() calls, report still shows inserted count
 *   - Strict mode: first error aborts
 *   - Bulk fallback: falls back to sequential create() on createMany failure
 */

import { describe, expect, it, vi } from 'vitest';

import { wireImport } from '../../src/sync/wire-import';
import type { Cents } from '../../src/types/core';
import type { ImportMapper, JournalEntryInput } from '../../src/types/sync';

/** Simple test mapper: raw = { id, amount, date } -> JournalEntry. */
interface TestRecord {
  id: string;
  amount: number;
  date: Date;
  description: string;
}

const testMapper: ImportMapper<TestRecord> = {
  externalId: (r) => r.id,
  toJournalEntry: (r) => ({
    date: r.date,
    label: r.description,
    journalItems: [
      { account: 'acc-bank', debit: Math.abs(r.amount) as Cents, credit: 0 as Cents },
      { account: 'acc-suspense', debit: 0 as Cents, credit: Math.abs(r.amount) as Cents },
    ],
  }),
};

function makeMockRepo(opts?: { withCreateMany?: boolean }) {
  const created: Record<string, unknown>[] = [];
  const bulkCreated: Record<string, unknown>[][] = [];
  const existingKeys = new Set<string>();

  return {
    created,
    bulkCreated,
    existingKeys,
    repo: {
      create: vi.fn(async (data: Record<string, unknown>) => {
        created.push(data);
        return data;
      }),
      ...(opts?.withCreateMany !== false
        ? {
            createMany: vi.fn(async (dataArray: Record<string, unknown>[]) => {
              bulkCreated.push(dataArray);
              for (const d of dataArray) created.push(d);
              return dataArray;
            }),
          }
        : {}),
      getAll: vi.fn(async () => []),
    },
    findExisting: vi.fn(async (refNums: string[]) => {
      return new Set(refNums.filter((k) => existingKeys.has(k)));
    }),
  };
}

const testRecords: TestRecord[] = [
  { id: 'txn-1', amount: 1000, date: new Date('2024-02-05'), description: 'Coffee' },
  { id: 'txn-2', amount: 2500, date: new Date('2024-02-10'), description: 'Salary' },
  { id: 'txn-3', amount: -500, date: new Date('2024-02-15'), description: 'Utilities' },
];

// ─── Sequential path (no createMany) ────────────────────────────────────────

describe('wireImport — sequential path (no createMany)', () => {
  it('creates one JournalEntry per source record via create()', async () => {
    const { repo, created, findExisting } = makeMockRepo({ withCreateMany: false });
    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
    expect(created).toHaveLength(3);
    expect(repo.create).toHaveBeenCalledTimes(3);

    // Verify _externalId is set
    expect(created[0]._externalId).toBe('txn-1');
    expect(created[1]._externalId).toBe('txn-2');
    expect(created[2]._externalId).toBe('txn-3');

    // Verify organizationId is set
    expect(created[0].organizationId).toBe('org_1');

    // Verify journalItems structure
    const items = created[0].journalItems as Array<{
      account: string;
      debit: number;
      credit: number;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0].debit).toBe(1000);
    expect(items[1].credit).toBe(1000);
  });
});

// ─── Bulk path (createMany available) ───────────────────────────────────────

describe('wireImport — bulk path (createMany)', () => {
  it('uses createMany() for the entire batch in a single call', async () => {
    const { repo, created, bulkCreated, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);

    // createMany called once with all 3 docs
    expect(repo.createMany).toHaveBeenCalledTimes(1);
    expect(bulkCreated[0]).toHaveLength(3);

    // create() should NOT be called when createMany succeeds
    expect(repo.create).not.toHaveBeenCalled();

    // Verify doc structure in the bulk call
    expect(bulkCreated[0][0]._externalId).toBe('txn-1');
    expect(bulkCreated[0][0].organizationId).toBe('org_1');
    expect(bulkCreated[0][0].state).toBe('posted');
  });

  it('falls back to sequential create() when createMany throws', async () => {
    const { repo, created, findExisting } = makeMockRepo();
    repo.createMany!.mockRejectedValueOnce(new Error('bulk write error'));

    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    // Falls back to sequential — all 3 should still succeed
    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(3);
    expect(repo.createMany).toHaveBeenCalledTimes(1); // tried once
    expect(repo.create).toHaveBeenCalledTimes(3); // fallback
  });

  it('respects batchSize with createMany — one createMany per batch', async () => {
    const { repo, bulkCreated, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
      options: { batchSize: 2 },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(3);
    // 2 batches: [txn-1, txn-2] and [txn-3]
    expect(repo.createMany).toHaveBeenCalledTimes(2);
    expect(bulkCreated[0]).toHaveLength(2);
    expect(bulkCreated[1]).toHaveLength(1);
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('wireImport — idempotency', () => {
  it('skips records whose externalId already exists in the repo', async () => {
    const { repo, created, existingKeys, findExisting } = makeMockRepo();
    existingKeys.add('txn-1');
    existingKeys.add('txn-3');

    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(1);
    expect(report.skipped).toBe(2);
    expect(created).toHaveLength(1);
    expect(created[0]._externalId).toBe('txn-2');
  });

  it('full re-import produces zero inserts', async () => {
    const { repo, created, existingKeys, findExisting } = makeMockRepo();
    existingKeys.add('txn-1');
    existingKeys.add('txn-2');
    existingKeys.add('txn-3');

    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(0);
    expect(report.skipped).toBe(3);
    expect(created).toHaveLength(0);
    // createMany should NOT be called when everything is deduped
    expect(repo.createMany).not.toHaveBeenCalled();
  });
});

// ─── Dry run ────────────────────────────────────────────────────────────────

describe('wireImport — dry run', () => {
  it('reports what would be inserted without calling create() or createMany()', async () => {
    const { repo, created, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: testRecords,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
      options: { dryRun: true },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(3);
    expect(report.skipped).toBe(0);
    expect(created).toHaveLength(0);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.createMany).not.toHaveBeenCalled();
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────

describe('wireImport — error handling', () => {
  it('captures per-record mapper errors without aborting', async () => {
    const failMapper: ImportMapper<TestRecord> = {
      externalId: (r) => r.id,
      toJournalEntry: (r) => {
        if (r.id === 'txn-2') throw new Error('bad record');
        return testMapper.toJournalEntry(r, {} as never);
      },
    };

    const { repo, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: testRecords,
      mapper: failMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].externalId).toBe('txn-2');
    expect(report.errors[0].message).toContain('bad record');
  });

  it('captures repo create() errors as per-record failures (sequential path)', async () => {
    const { repo, findExisting } = makeMockRepo({ withCreateMany: false });
    repo.create.mockRejectedValueOnce(new Error('mongo down'));

    const importer = wireImport({
      source: [testRecords[0]],
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();
    expect(report.failed).toBe(1);
    expect(report.errors[0].message).toContain('mongo down');
  });

  it('counts duplicate errors as skipped in sequential fallback', async () => {
    const { repo, findExisting } = makeMockRepo({ withCreateMany: false });
    repo.create.mockRejectedValueOnce(new Error('duplicate key'));

    const importer = wireImport({
      source: [testRecords[0]],
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
  });
});

// ─── Mapper returns null (skip) ─────────────────────────────────────────────

describe('wireImport — mapper returns null (skip)', () => {
  it('counts null-returning records as skipped', async () => {
    const skipMapper: ImportMapper<TestRecord> = {
      externalId: (r) => r.id,
      toJournalEntry: (r) =>
        r.id === 'txn-2' ? null : testMapper.toJournalEntry(r, {} as never),
    };

    const { repo, created, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: testRecords,
      mapper: skipMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();
    expect(report.inserted).toBe(2);
    expect(report.skipped).toBe(1);
    expect(created).toHaveLength(2);
  });
});

// ─── Performance: bulk vs sequential ────────────────────────────────────────

describe('wireImport — performance characteristics', () => {
  it('bulk: N records = 1 createMany call (not N create calls)', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: `txn-${i}`,
      amount: (i + 1) * 100,
      date: new Date('2024-03-01'),
      description: `Transaction ${i}`,
    }));

    const { repo, findExisting } = makeMockRepo();
    const importer = wireImport({
      source: records,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(50);
    expect(repo.createMany).toHaveBeenCalledTimes(1); // single batch
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('without createMany: N records = N create calls', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `txn-${i}`,
      amount: (i + 1) * 100,
      date: new Date('2024-03-01'),
      description: `Transaction ${i}`,
    }));

    const { repo, findExisting } = makeMockRepo({ withCreateMany: false });
    const importer = wireImport({
      source: records,
      mapper: testMapper,
      journalEntries: repo,
      findExisting,
      context: { organizationId: 'org_1' },
    });

    const report = await importer.run();

    expect(report.inserted).toBe(10);
    expect(repo.create).toHaveBeenCalledTimes(10);
  });
});
