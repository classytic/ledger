/**
 * wireExport unit tests with a mock JournalEntry repository.
 *
 * Verifies:
 *   - Happy path: entries are mapped through the sink and emitted
 *   - Emitted count accuracy (catches the splice-before-count bug)
 *   - Batching: large result sets are split into chunks
 *   - Error handling: per-entry mapper errors are captured, not thrown
 *   - Empty result set: no emit calls, report is ok
 *   - Flush: sink.flush() is called when provided
 *   - Progress callback: onProgress fires with correct emitted count
 */

import { describe, expect, it, vi } from 'vitest';

import { wireExport } from '../../src/sync/wire-export';
import type { ExportSink } from '../../src/types/sync';

// ─── Test fixtures ─────────────────────────────────────────────────────────

interface TestEntry {
  _id: string;
  label: string;
  journalItems: Array<{ account: string; debit: number; credit: number }>;
}

interface TestOutput {
  id: string;
  label: string;
  total: number;
}

function makeEntries(count: number): TestEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `entry-${i + 1}`,
    label: `Entry ${i + 1}`,
    journalItems: [
      { account: 'acc-bank', debit: (i + 1) * 100, credit: 0 },
      { account: 'acc-revenue', debit: 0, credit: (i + 1) * 100 },
    ],
  }));
}

function makeMockSink(opts?: { failOnId?: string }) {
  const emitted: TestOutput[][] = [];

  const sink: ExportSink<TestOutput> = {
    fromJournalEntry: (entry: unknown) => {
      const e = entry as TestEntry;
      if (opts?.failOnId && e._id === opts.failOnId) {
        throw new Error(`cannot export ${e._id}`);
      }
      return {
        id: e._id,
        label: e.label,
        total: e.journalItems.reduce((s, i) => s + i.debit, 0),
      };
    },
    emit: vi.fn(async (records: TestOutput[]) => {
      emitted.push([...records]);
    }),
    flush: vi.fn(async () => {}),
  };

  return { sink, emitted };
}

function makeMockRepo(entries: TestEntry[]) {
  return {
    getAll: vi.fn(async () => entries),
  };
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('wireExport — happy path', () => {
  it('maps entries through the sink and emits them', async () => {
    const entries = makeEntries(3);
    const repo = makeMockRepo(entries);
    const { sink, emitted } = makeMockSink();

    const exporter = wireExport({
      query: { organizationId: 'org_1' },
      sink,
      journalEntries: repo,
    });

    const report = await exporter.run();

    expect(report.ok).toBe(true);
    expect(report.emitted).toBe(3);
    expect(report.errors).toHaveLength(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    // All 3 entries should have been emitted
    const allEmitted = emitted.flat();
    expect(allEmitted).toHaveLength(3);
    expect(allEmitted[0]).toMatchObject({ id: 'entry-1', label: 'Entry 1', total: 100 });
    expect(allEmitted[2]).toMatchObject({ id: 'entry-3', label: 'Entry 3', total: 300 });
  });

  it('passes the query to repo.getAll()', async () => {
    const repo = makeMockRepo([]);
    const { sink } = makeMockSink();
    const query = { organizationId: 'org_1', state: 'posted' };

    await wireExport({ query, sink, journalEntries: repo }).run();

    expect(repo.getAll).toHaveBeenCalledWith(query);
  });
});

// ─── Emitted count accuracy ────────────────────────────────────────────────

describe('wireExport — emitted count', () => {
  it('reports the correct emitted count (not zero from splice bug)', async () => {
    const entries = makeEntries(5);
    const repo = makeMockRepo(entries);
    const { sink } = makeMockSink();

    const report = await wireExport({
      query: {},
      sink,
      journalEntries: repo,
      options: { batchSize: 2 },
    }).run();

    // 5 entries, batchSize 2 → 3 emits (2 + 2 + 1)
    expect(report.emitted).toBe(5);
    expect(report.ok).toBe(true);
  });

  it('onProgress reports cumulative emitted count per batch', async () => {
    const entries = makeEntries(5);
    const repo = makeMockRepo(entries);
    const { sink } = makeMockSink();
    const progressCalls: number[] = [];

    await wireExport({
      query: {},
      sink,
      journalEntries: repo,
      options: {
        batchSize: 2,
        onProgress: (p) => progressCalls.push(p.emitted),
      },
    }).run();

    // Should report cumulative: 2, 4, 5
    expect(progressCalls).toEqual([2, 4, 5]);
  });
});

// ─── Batching ──────────────────────────────────────────────────────────────

describe('wireExport — batching', () => {
  it('splits entries into batches of batchSize', async () => {
    const entries = makeEntries(7);
    const repo = makeMockRepo(entries);
    const { sink, emitted } = makeMockSink();

    await wireExport({
      query: {},
      sink,
      journalEntries: repo,
      options: { batchSize: 3 },
    }).run();

    // 7 entries, batchSize 3 → 3 emit calls (3 + 3 + 1)
    expect(sink.emit).toHaveBeenCalledTimes(3);
    expect(emitted[0]).toHaveLength(3);
    expect(emitted[1]).toHaveLength(3);
    expect(emitted[2]).toHaveLength(1);
  });

  it('defaults batchSize to 100', async () => {
    const entries = makeEntries(50);
    const repo = makeMockRepo(entries);
    const { sink } = makeMockSink();

    await wireExport({
      query: {},
      sink,
      journalEntries: repo,
    }).run();

    // 50 < 100 → all in one final flush
    expect(sink.emit).toHaveBeenCalledTimes(1);
  });
});

// ─── Error handling ────────────────────────────────────────────────────────

describe('wireExport — error handling', () => {
  it('captures per-entry sink errors without aborting', async () => {
    const entries = makeEntries(3);
    const repo = makeMockRepo(entries);
    const { sink, emitted } = makeMockSink({ failOnId: 'entry-2' });

    const report = await wireExport({
      query: {},
      sink,
      journalEntries: repo,
    }).run();

    expect(report.ok).toBe(false);
    expect(report.emitted).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].entryId).toBe('entry-2');
    expect(report.errors[0].message).toContain('cannot export entry-2');
  });

  it('captures entryId as undefined when entry has no _id', async () => {
    const entries = [{ label: 'No ID entry', journalItems: [] }] as unknown as TestEntry[];
    const repo = makeMockRepo(entries);
    const failSink = makeMockSink();
    failSink.sink.fromJournalEntry = () => { throw new Error('boom'); };

    const report = await wireExport({
      query: {},
      sink: failSink.sink,
      journalEntries: repo,
    }).run();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].entryId).toBeUndefined();
  });
});

// ─── Empty result set ──────────────────────────────────────────────────────

describe('wireExport — empty result set', () => {
  it('returns ok with zero emitted when no entries match', async () => {
    const repo = makeMockRepo([]);
    const { sink } = makeMockSink();

    const report = await wireExport({
      query: { organizationId: 'org_empty' },
      sink,
      journalEntries: repo,
    }).run();

    expect(report.ok).toBe(true);
    expect(report.emitted).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(sink.emit).not.toHaveBeenCalled();
  });
});

// ─── Flush ─────────────────────────────────────────────────────────────────

describe('wireExport — flush', () => {
  it('calls sink.flush() after all batches are emitted', async () => {
    const entries = makeEntries(2);
    const repo = makeMockRepo(entries);
    const { sink } = makeMockSink();

    await wireExport({
      query: {},
      sink,
      journalEntries: repo,
    }).run();

    expect(sink.flush).toHaveBeenCalledTimes(1);
  });

  it('works without flush (optional method)', async () => {
    const entries = makeEntries(2);
    const repo = makeMockRepo(entries);
    const { sink } = makeMockSink();
    delete (sink as Record<string, unknown>).flush;

    const report = await wireExport({
      query: {},
      sink,
      journalEntries: repo,
    }).run();

    expect(report.ok).toBe(true);
    expect(report.emitted).toBe(2);
  });
});
