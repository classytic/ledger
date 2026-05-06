/**
 * Budget Schema Factory
 *
 * Creates a Mongoose schema for budget records.
 * Each record represents a budgeted amount for an account over a specific period.
 * All monetary amounts are in integer cents.
 */

import type { ApprovalChain } from '@classytic/primitives/approval';
import mongoose from 'mongoose';
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

/**
 * The Budget document carries an optional `approvals` value object when the
 * host wires the maker-checker workflow. Per `PACKAGE_RULES.md §P7`, every
 * package that supports a review step uses `approvals?: ApprovalChain` from
 * `@classytic/primitives/approval` — no parallel chain shape, no engine
 * opt-in flag. Hosts that don't approve budgets simply leave the field
 * undefined; Mongoose treats it as absent.
 */
export type BudgetApprovals = ApprovalChain;

export function createBudgetSchema(config: AccountingEngineConfig, options: SchemaOptions = {}) {
  const scope = resolveLedgerTenant(config);
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
    // P7 — embedded ApprovalChain VO (primitives owns the shape). Hosts
    // running a maker-checker workflow attach a chain via `createChain()`
    // and gate `approve` on `isApproved(doc.approvals)`. Hosts that don't
    // use approvals leave it undefined — no behavioural impact.
    approvals: { type: mongoose.Schema.Types.Mixed, default: null },
    ...extraFields,
  };

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, { timestamps: true });

  // ── Validation: periodEnd must be after periodStart ────────────────────
  schema.pre('validate', function () {
    const doc = this as unknown as mongoose.Document & { periodStart: Date; periodEnd: Date };
    if (doc.periodStart && doc.periodEnd && doc.periodEnd <= doc.periodStart) {
      doc.invalidate(
        'periodEnd',
        'periodEnd must be after periodStart.',
        doc.periodEnd,
        'periodEnd',
      );
    }
  });

  // ── Indexes ────────────────────────────────────────────────────────────
  // Compound indexes declared without a tenant prefix — `injectTenantField`
  // prepends it when multi-tenant is configured.
  if (indexes) {
    schema.index({ account: 1, periodStart: 1, periodEnd: 1 }, { unique: true });
    schema.index({ periodStart: 1, periodEnd: 1 });
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  injectTenantField(schema, scope);

  return schema;
}
