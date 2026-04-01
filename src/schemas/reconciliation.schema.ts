/**
 * Reconciliation Schema Factory
 *
 * Creates a Mongoose schema for reconciliation records that link matched
 * debit/credit journal items. Used to track which journal entries have been
 * reconciled against each other for a given account.
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createReconciliationSchema(
  config: AccountingEngineConfig,
  accountModelName: string,
  journalEntryModelName: string,
  options: SchemaOptions = {},
) {
  const { multiTenant } = config;
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  const fields: Record<string, unknown> = {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: accountModelName,
      required: true,
    },
    journalEntryIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: journalEntryModelName }],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length > 0,
        message: 'journalEntryIds must contain at least one entry.',
      },
    },
    debitTotal: { type: Number, required: true },
    creditTotal: { type: Number, required: true },
    difference: { type: Number, default: 0 },
    note: { type: String },
    reconciledBy: { type: String },
    reconciledAt: { type: Date, default: Date.now },
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

  if (indexes) {
    if (multiTenant) {
      const org = multiTenant.orgField;
      schema.index({ [org]: 1, account: 1, reconciledAt: 1 });
    } else {
      schema.index({ account: 1, reconciledAt: 1 });
    }
    schema.index({ journalEntryIds: 1 });
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
