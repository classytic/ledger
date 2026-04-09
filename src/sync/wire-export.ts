/**
 * wireExport — symmetric to wireImport.
 *
 * Queries JournalEntry documents, maps each through an ExportSink, and emits
 * batches to the destination (file, stream, API, etc.).
 */

import type { ExportReport, WireExportArgs } from '../types/sync';

export function wireExport<TOut>(args: WireExportArgs<TOut>) {
  const batchSize = args.options?.batchSize ?? 100;
  const onProgress = args.options?.onProgress;

  return {
    async run(): Promise<ExportReport> {
      const start = performance.now();
      let emitted = 0;
      const errors: ExportReport['errors'] = [];

      const entries = await args.journalEntries.getAll(args.query);
      let batch: TOut[] = [];

      for (const entry of entries) {
        try {
          const out = args.sink.fromJournalEntry(entry);
          batch.push(out);
        } catch (err) {
          const id = (entry as Record<string, unknown>)?._id;
          errors.push({
            entryId: id ? String(id) : undefined,
            message: (err as Error).message,
          });
          continue;
        }

        if (batch.length >= batchSize) {
          const count = batch.length;
          await args.sink.emit(batch);
          batch = [];
          emitted += count;
          onProgress?.({ emitted });
        }
      }

      if (batch.length > 0) {
        const count = batch.length;
        await args.sink.emit(batch);
        batch = [];
        emitted += count;
        onProgress?.({ emitted });
      }

      if (args.sink.flush) {
        await args.sink.flush();
      }

      return {
        ok: errors.length === 0,
        emitted,
        errors,
        durationMs: performance.now() - start,
      };
    },
  };
}
