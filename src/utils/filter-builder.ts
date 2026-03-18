/**
 * Filter Builder — Sanitizes user-supplied dimension filters for aggregation pipelines.
 *
 * Prevents injection of dangerous MongoDB operators while allowing
 * standard equality and comparison filters on custom dimension fields.
 */

const BLOCKED_OPERATORS = new Set([
  '$where', '$expr', '$function', '$accumulator',
  '$merge', '$out', '$unionWith',
]);

/**
 * Build a sanitized filter object from user-supplied dimension filters.
 * Blocks dangerous operators ($where, $expr, $function, etc.).
 *
 * @param filters - Key-value filters (e.g. { 'journalItems.departmentId': 'dept-1' })
 * @returns Sanitized filter object safe for $match stages
 * @throws Error if a blocked operator is used
 */
export function buildItemFilters(filters?: Record<string, unknown>): Record<string, unknown> {
  if (!filters || Object.keys(filters).length === 0) return {};

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filters)) {
    // Block operators at top level
    if (key.startsWith('$')) {
      throw new Error(`Filter key "${key}" is not allowed. Use field names, not operators.`);
    }

    // Check nested values for blocked operators
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const opKey of Object.keys(value as Record<string, unknown>)) {
        if (BLOCKED_OPERATORS.has(opKey)) {
          throw new Error(`Filter operator "${opKey}" is not allowed.`);
        }
      }
    }

    result[key] = value;
  }

  return result;
}
