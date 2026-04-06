/**
 * CSV Serializer — RFC 4180 compliant CSV string builder.
 *
 * Pure function. No I/O, no side effects.
 *
 * @module @classytic/ledger/exports
 */

import type { CsvOptions } from './types.js';

const NEEDS_QUOTING = /[",\r\n]/;

/** Escape a single CSV cell value per RFC 4180. */
export function escapeCell(value: string): string {
  if (NEEDS_QUOTING.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize a 2D array of strings into a CSV string. */
export function serializeCsv(
  rows: readonly (readonly string[])[],
  options: CsvOptions = {},
): string {
  const { delimiter = ',', lineTerminator = '\r\n' } = options;

  return rows.map((row) => row.map(escapeCell).join(delimiter)).join(lineTerminator);
}

/** Build a CSV string with optional header row. */
export function buildCsv(
  headers: readonly string[],
  dataRows: readonly (readonly string[])[],
  options: CsvOptions = {},
): string {
  const { includeHeaders = true } = options;
  const allRows = includeHeaders ? [headers, ...dataRows] : [...dataRows];
  return serializeCsv(allRows, options);
}
