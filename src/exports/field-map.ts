/**
 * Field Map Application — Applies an ExportFieldMap to data rows.
 *
 * @module @classytic/ledger/exports
 */

import { buildCsv } from './csv-serializer.js';
import type { CsvOptions, ExportFieldMap } from './types.js';

/** Extract headers from a field map. */
export function getHeaders<TRow>(fieldMap: ExportFieldMap<TRow>): string[] {
  return fieldMap.fields.map((f) => f.header);
}

/** Apply a field map to a single row, producing an array of cell strings. */
export function extractRow<TRow>(fieldMap: ExportFieldMap<TRow>, row: TRow): string[] {
  return fieldMap.fields.map((f) => f.extract(row));
}

/** Apply a field map to an array of rows, producing a 2D string array. */
export function extractAllRows<TRow>(
  fieldMap: ExportFieldMap<TRow>,
  rows: readonly TRow[],
): string[][] {
  return rows.map((row) => extractRow(fieldMap, row));
}

/** One-shot: map + serialize to CSV string. */
export function exportToCsv<TRow>(
  fieldMap: ExportFieldMap<TRow>,
  rows: readonly TRow[],
  options?: CsvOptions,
): string {
  const headers = getHeaders(fieldMap);
  const dataRows = extractAllRows(fieldMap, rows);
  return buildCsv(headers, dataRows, options);
}
