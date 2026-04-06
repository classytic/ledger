/**
 * Analytic Dimensions — Helpers for defining analytic dimensions
 * (department, project, cost center) on journal items.
 *
 * Generates Mongoose schema fields and indexes for dimension queries.
 */

import { Schema } from 'mongoose';

export interface DimensionDefinition {
  /** Field name on the journal item, e.g. 'departmentId' */
  field: string;
  /** Human-readable label, e.g. 'Department' */
  label: string;
  /** Mongoose model ref for population, e.g. 'Department' */
  ref?: string;
  /** Whether the field is required (default: false) */
  required?: boolean;
}

/**
 * Build extraItemFields schema definition for a set of dimensions.
 *
 * Returns a Mongoose schema-compatible object suitable for spreading into
 * `extraItemFields` in JournalSchemaOptions.
 *
 * @example
 * ```typescript
 * const fields = buildDimensionFields([
 *   { field: 'departmentId', label: 'Department', ref: 'Department' },
 *   { field: 'projectId', label: 'Project', ref: 'Project' },
 * ]);
 * // => { departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: false, default: null }, ... }
 * ```
 */
export function buildDimensionFields(dimensions: DimensionDefinition[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const dim of dimensions) {
    const fieldDef: Record<string, unknown> = {
      type: Schema.Types.ObjectId,
      required: dim.required ?? false,
      default: null,
    };

    if (dim.ref) {
      fieldDef.ref = dim.ref;
    }

    fields[dim.field] = fieldDef;
  }

  return fields;
}

/**
 * Build extra indexes for dimension queries.
 *
 * Each dimension gets a compound index on `journalItems.{field}` + `date`
 * for efficient filtered reporting. When `orgField` is provided, it is
 * prepended to each index for multi-tenant scoping.
 *
 * @param dimensions - Array of dimension definitions
 * @param orgField - Optional org-scoping field name (e.g. 'business')
 * @returns Array of index specifications compatible with `extraIndexes` in JournalSchemaOptions
 */
export function buildDimensionIndexes(
  dimensions: DimensionDefinition[],
  orgField?: string,
): Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> {
  return dimensions.map((dim) => {
    const fields: Record<string, 1 | -1> = {};

    if (orgField) {
      fields[orgField] = 1;
    }

    fields[`journalItems.${dim.field}`] = 1;
    fields.date = -1;

    return { fields, options: {} };
  });
}
