/**
 * wireImport — the core import helper.
 *
 * Ties a source of raw records + a mapper + a JournalEntry repository into
 * a runnable import pipeline with:
 *   - Idempotent re-imports (checks idempotencyKey before creating)
 *   - Configurable batch size
 *   - Dry-run mode (parse + dedup-check without persisting)
 *   - Per-record error capture (no single failure aborts the run)
 *   - Progress callback
 *   - **Bulk inserts** via `createMany` when available — single DB round-trip
 *     per batch instead of N sequential `create()` calls.
 */

import type {
  ImportContext,
  ImportError,
  ImportReport,
  JournalEntryInput,
  WireImportArgs,
} from '../types/sync';

export function wireImport<TRaw>(args: WireImportArgs<TRaw>) {
  const batchSize = args.options?.batchSize ?? 100;
  const strict = args.options?.strict ?? false;
  const dryRun = args.options?.dryRun ?? false;
  const journalType = args.options?.journalType ?? 'GENERAL';
  const onProgress = args.options?.onProgress;
  const useBulk = !dryRun && typeof args.journalEntries.createMany === 'function';

  return {
    async run(): Promise<ImportReport> {
      const start = performance.now();
      const ctx: ImportContext = {
        organizationId: args.context.organizationId,
        importedAt: new Date(),
        importRunId: args.context.importRunId,
      };

      let inserted = 0;
      let skipped = 0;
      let failed = 0;
      const errors: ImportError[] = [];
      let processed = 0;

      // Collect raw records into batches
      const batch: TRaw[] = [];

      for await (const raw of toAsyncIterable(args.source)) {
        batch.push(raw);
        if (batch.length >= batchSize) {
          const result = await processBatch(batch.splice(0));
          inserted += result.inserted;
          skipped += result.skipped;
          failed += result.failed;
          errors.push(...result.errors);
          processed += result.processed;
          if (strict && result.failed > 0) break;
          onProgress?.({ processed });
        }
      }

      // Flush remaining
      if (batch.length > 0) {
        const result = await processBatch(batch);
        inserted += result.inserted;
        skipped += result.skipped;
        failed += result.failed;
        errors.push(...result.errors);
        processed += result.processed;
        onProgress?.({ processed });
      }

      return {
        ok: failed === 0,
        inserted,
        skipped,
        failed,
        errors,
        durationMs: performance.now() - start,
      };

      async function processBatch(records: TRaw[]) {
        let batchInserted = 0;
        let batchSkipped = 0;
        let batchFailed = 0;
        const batchErrors: ImportError[] = [];

        // ── 1. Extract externalIds ──────────────────────────────────────
        const externalIds: string[] = [];
        for (const raw of records) {
          try {
            externalIds.push(args.mapper.externalId(raw));
          } catch (err) {
            externalIds.push('');
            batchErrors.push({
              externalId: undefined,
              message: `externalId() threw: ${(err as Error).message}`,
              cause: err,
            });
            batchFailed += 1;
          }
        }

        // ── 2. Batch dedup lookup ───────────────────────────────────────
        const existingSet = new Set<string>();
        const validIds = externalIds.filter((id) => id.length > 0);
        if (validIds.length > 0 && args.findExisting) {
          try {
            const found = await args.findExisting(validIds, ctx.organizationId);
            for (const id of found) existingSet.add(id);
          } catch {
            // If the lookup fails, fall through — create() will handle it.
          }
        }

        // ── 3. Map records → JournalEntry payloads ──────────────────────
        // Collect valid docs for bulk insert, track per-record outcomes.
        const pendingDocs: Array<{ externalId: string; doc: Record<string, unknown> }> = [];

        for (let i = 0; i < records.length; i++) {
          const raw = records[i];
          const externalId = externalIds[i];
          if (!externalId) continue; // already counted as failed above

          // Idempotency check
          if (existingSet.has(externalId)) {
            batchSkipped += 1;
            continue;
          }

          // Map to JournalEntry input
          let inputs: JournalEntryInput | JournalEntryInput[] | null;
          try {
            inputs = args.mapper.toJournalEntry(raw, ctx);
          } catch (err) {
            batchErrors.push({
              externalId,
              message: `toJournalEntry() threw: ${(err as Error).message}`,
              cause: err,
            });
            batchFailed += 1;
            continue;
          }

          if (inputs === null) {
            batchSkipped += 1;
            continue;
          }

          const inputArray = Array.isArray(inputs) ? inputs : [inputs];
          for (const input of inputArray) {
            if (dryRun) {
              batchInserted += 1;
              continue;
            }

            const doc: Record<string, unknown> = {
              journalType: input.journalType ?? journalType,
              journal: input.journal,
              label: input.label ?? 'Import',
              date: input.date,
              journalItems: input.journalItems.map((item) => ({
                account: item.account,
                debit: item.debit,
                credit: item.credit,
                label: item.label,
                currency: item.currency,
                exchangeRate: item.exchangeRate,
                originalDebit: item.originalDebit,
                originalCredit: item.originalCredit,
                matchingNumber: item.matchingNumber,
                maturityDate: item.maturityDate,
              })),
              _externalId: externalId,
              state: 'posted',
              ...(ctx.organizationId !== undefined ? { organizationId: ctx.organizationId } : {}),
              ...(ctx.importRunId ? { _importRunId: ctx.importRunId } : {}),
              ...input.extra,
            };

            pendingDocs.push({ externalId, doc });
          }
        }

        if (dryRun || pendingDocs.length === 0) {
          return {
            inserted: batchInserted,
            skipped: batchSkipped,
            failed: batchFailed,
            errors: batchErrors,
            processed: records.length,
          };
        }

        // ── 4. Persist: bulk or sequential ──────────────────────────────
        if (useBulk) {
          try {
            await args.journalEntries.createMany!(pendingDocs.map((p) => p.doc));
            batchInserted += pendingDocs.length;
          } catch (_err) {
            // If bulk fails, fall back to sequential for per-record isolation
            for (const { externalId, doc } of pendingDocs) {
              try {
                await args.journalEntries.create(doc);
                batchInserted += 1;
              } catch (innerErr) {
                const innerMsg = (innerErr as Error).message;
                if (innerMsg.includes('idempotency') || innerMsg.includes('duplicate')) {
                  batchSkipped += 1;
                } else {
                  batchErrors.push({ externalId, message: innerMsg, cause: innerErr });
                  batchFailed += 1;
                }
              }
            }
          }
        } else {
          // Sequential path (no createMany available)
          for (const { externalId, doc } of pendingDocs) {
            try {
              await args.journalEntries.create(doc);
              batchInserted += 1;
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes('idempotency') || msg.includes('duplicate')) {
                batchSkipped += 1;
              } else {
                batchErrors.push({ externalId, message: msg, cause: err });
                batchFailed += 1;
              }
            }
          }
        }

        return {
          inserted: batchInserted,
          skipped: batchSkipped,
          failed: batchFailed,
          errors: batchErrors,
          processed: records.length,
        };
      }
    },
  };
}

function toAsyncIterable<T>(source: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in Object(source)) {
    return source as AsyncIterable<T>;
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of source as Iterable<T>) {
        yield item;
      }
    },
  };
}
