/**
 * Reconciliation Schema Factory (0.6.0 — item-level open-item matching)
 *
 * A reconciliation is a **matching group** of journal items that together
 * settle each other in whole or in part. Each group carries a stable
 * `matchingNumber` string that is stamped onto every referenced journal
 * item. A group is `isFullReconcile = true` iff debit/credit totals
 * balance to zero — partial matches (a cheque paying 2 of 3 invoices) are
 * represented by isFullReconcile=false.
 *
 * This replaces 0.5.x entry-level reconciliation, which could not represent
 * the canonical AR/AP flow where one cheque covers multiple invoices or
 * one invoice is paid by multiple cheques.
 *
 * A dedicated collection exists so that match/unmatch can atomically stamp
 * `journalItems[i].matchingNumber`, update totals, and trigger the
 * fxRealizationPlugin via mongokit hooks — without bumping the entries'
 * `updatedAt` timestamps.
 */

import mongoose from 'mongoose';
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createReconciliationSchema(
  config: AccountingEngineConfig,
  accountModelName: string,
  journalEntryModelName: string,
  options: SchemaOptions = {},
) {
  const scope = resolveLedgerTenant(config);
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  // Reference to a specific item inside an entry: (entryId, itemIndex).
  // We use positional index because journal items are embedded sub-docs
  // declared with `_id: false`.
  const MatchedItemRefSchema = new mongoose.Schema(
    {
      entry: {
        type: mongoose.Schema.Types.ObjectId,
        ref: journalEntryModelName,
        required: true,
      },
      itemIndex: {
        type: Number,
        required: true,
        min: 0,
        validate: {
          validator: Number.isInteger,
          message: 'itemIndex must be a non-negative integer',
        },
      },
      /** Snapshot of the debit side of the item in cents, for audit. */
      debit: { type: Number, default: 0, min: 0 },
      /** Snapshot of the credit side of the item in cents, for audit. */
      credit: { type: Number, default: 0, min: 0 },
      /** Optional snapshot of the item's foreign amount for FX realization. */
      amountCurrency: { type: Number, default: null },
      exchangeRate: { type: Number, default: null },
    },
    { _id: false },
  );

  const fields: Record<string, unknown> = {
    /**
     * Stable identifier shared by every matched item, also stamped onto
     * `journalItems[i].matchingNumber` for cheap open-item lookups.
     */
    matchingNumber: { type: String, required: true },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: accountModelName,
      required: true,
    },
    items: {
      type: [MatchedItemRefSchema],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 2,
        message: 'a reconciliation must reference at least two items',
      },
    },
    debitTotal: { type: Number, required: true, min: 0 },
    creditTotal: { type: Number, required: true, min: 0 },
    /** `debitTotal - creditTotal` in cents — zero ⇒ full reconcile. */
    difference: { type: Number, default: 0 },
    isFullReconcile: { type: Boolean, default: false },
    /**
     * Optional currency stamp — when all matched items share a single
     * foreign currency, this records it so the FX realization plugin can
     * compute realized gain/loss against the base currency rates.
     */
    currency: { type: String, default: null },
    note: { type: String },
    reconciledBy: { type: String },
    reconciledAt: { type: Date, default: Date.now },
    /** Audit ref to the FX realization entry when the plugin fires. */
    fxRealizationEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: journalEntryModelName,
      default: null,
    },
    ...extraFields,
  };

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, { timestamps: true });

  // Compound indexes declared without a tenant prefix — `injectTenantField`
  // prepends it when multi-tenant is configured.
  if (indexes) {
    schema.index({ matchingNumber: 1 }, { unique: true });
    schema.index({ account: 1, isFullReconcile: 1, reconciledAt: 1 });
    schema.index({ 'items.entry': 1 });
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  injectTenantField(schema, scope);

  return schema;
}
