/**
 * Journal Schema Factory (0.6.0 — first-class Journal resource)
 *
 * A Journal is an organization-owned posting channel with its own
 * reference-number sequence, permitted payment methods, optional default
 * accounts, and source configuration for bank/statement imports.
 *
 * Journals are **optional** — a consumer that never seeds journals keeps
 * the 0.5.x enum-only flow on journal entries. Consumers that do seed
 * journals gain:
 *
 *   - Per-journal reference-number prefix (e.g. `INV/2026/03/0042`)
 *   - Per-journal lock wiring (sale-lock on the sales journal, not globally)
 *   - Payment method restrictions
 *   - Bank-statement source binding for automated imports (0.7+)
 *
 * The schema is additive: existing journal entries without a `journal` ref
 * keep working unchanged, and seed-from-pack is opt-in via
 * `engine.repositories.journals.seedDefaults(orgId)`.
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createJournalSchema(
  config: AccountingEngineConfig,
  accountModelName: string,
  options: SchemaOptions = {},
) {
  const { multiTenant } = config;
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  const fields: Record<string, unknown> = {
    /** Short stable identifier — e.g. `'SALES'`, `'BANK'`. */
    code: { type: String, required: true, trim: true },
    /** Display name. */
    name: { type: String, required: true, trim: true },
    /**
     * One of the registered `JOURNAL_TYPES` codes. Connects this journal
     * to the engine's posting contracts and reference-number generator.
     */
    journalType: { type: String, required: true },
    /**
     * Logical source — drives future lock-date buckets (sale-lock-date,
     * purchase-lock-date) and bank-statement import wiring.
     */
    kind: {
      type: String,
      enum: ['general', 'sale', 'purchase', 'bank', 'cash', 'misc'],
      default: 'general',
      required: true,
    },
    /** Reference-number prefix — defaults to `code` when omitted. */
    sequencePrefix: { type: String, default: null },
    /** Next sequence number (monotonic within this journal). */
    sequenceNextNum: { type: Number, default: 1, min: 1 },
    /** Optional default debit/credit account for quick data entry. */
    defaultDebitAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: accountModelName,
      default: null,
    },
    defaultCreditAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: accountModelName,
      default: null,
    },
    /** Free-form payment-method identifiers allowed on entries in this journal. */
    allowedPaymentMethods: { type: [String], default: [] },
    /**
     * Opaque source id — `'manual'`, `'stripe'`, bank connector id, etc.
     * Used by bank-statement and external-integration plugins.
     */
    source: { type: String, default: 'manual' },
    active: { type: Boolean, default: true },
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
    const org = multiTenant?.orgField;
    if (org) {
      schema.index({ [org]: 1, code: 1 }, { unique: true });
      schema.index({ [org]: 1, kind: 1, active: 1 });
    } else {
      schema.index({ code: 1 }, { unique: true });
      schema.index({ kind: 1, active: 1 });
    }
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
