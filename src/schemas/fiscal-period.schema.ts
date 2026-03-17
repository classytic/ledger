/**
 * Fiscal Period Schema Factory
 *
 * Creates a Mongoose schema for tracking fiscal periods (months, quarters, years).
 * Supports closing periods to lock entries.
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createFiscalPeriodSchema(
  config: AccountingEngineConfig,
  options: SchemaOptions = {},
) {
  const { multiTenant } = config;
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  const fields: Record<string, unknown> = {
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    closed: { type: Boolean, default: false },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: null },
    closingEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: String, default: null },
    ...extraFields,
  };

  if (multiTenant) {
    fields[multiTenant.orgField] = {
      type: mongoose.Schema.Types.ObjectId,
      ref: multiTenant.orgRef,
      required: true,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = new mongoose.Schema(fields as any, { timestamps: true });

  if (indexes) {
    if (multiTenant) {
      const org = multiTenant.orgField;
      schema.index({ [org]: 1, startDate: 1, endDate: 1 }, { unique: true });
      schema.index({ [org]: 1, closed: 1 });
    } else {
      schema.index({ startDate: 1, endDate: 1 }, { unique: true });
      schema.index({ closed: 1 });
    }
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
