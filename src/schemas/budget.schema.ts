/**
 * Budget Schema Factory
 *
 * Creates a Mongoose schema for budget records.
 * Each record represents a budgeted amount for an account over a specific period.
 * All monetary amounts are in integer cents.
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createBudgetSchema(
  config: AccountingEngineConfig,
  options: SchemaOptions = {},
) {
  const { multiTenant } = config;
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  const fields: Record<string, unknown> = {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: 'amount must be an integer (cents).',
      },
    },
    label: { type: String, default: null },
    ...extraFields,
  };

  if (multiTenant) {
    fields[multiTenant.orgField] = {
      type: mongoose.Schema.Types.ObjectId,
      ref: multiTenant.orgRef,
      required: true,
    };
  }

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, { timestamps: true });

  // ── Validation: periodEnd must be after periodStart ────────────────────
  schema.pre('validate', function () {
    const doc = this as unknown as mongoose.Document & { periodStart: Date; periodEnd: Date };
    if (doc.periodStart && doc.periodEnd && doc.periodEnd <= doc.periodStart) {
      doc.invalidate('periodEnd', 'periodEnd must be after periodStart.', doc.periodEnd, 'periodEnd');
    }
  });

  // ── Indexes ────────────────────────────────────────────────────────────
  if (indexes) {
    if (multiTenant) {
      const org = multiTenant.orgField;
      schema.index({ [org]: 1, account: 1, periodStart: 1, periodEnd: 1 }, { unique: true });
      schema.index({ [org]: 1, periodStart: 1, periodEnd: 1 });
    } else {
      schema.index({ account: 1, periodStart: 1, periodEnd: 1 }, { unique: true });
      schema.index({ periodStart: 1, periodEnd: 1 });
    }
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
