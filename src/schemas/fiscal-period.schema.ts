/**
 * Fiscal Period Schema Factory
 *
 * Creates a Mongoose schema for tracking fiscal periods (months, quarters, years).
 * Supports closing periods to lock entries.
 */

import mongoose from 'mongoose';
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createFiscalPeriodSchema(
  config: AccountingEngineConfig,
  options: SchemaOptions = {},
) {
  const { multiTenant } = config;
  const scope = resolveLedgerTenant(config);
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

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, { timestamps: true });

  // Compound indexes declared without a tenant prefix — `injectTenantField`
  // prepends it when multi-tenant is configured.
  if (indexes) {
    schema.index({ startDate: 1, endDate: 1 }, { unique: true });
    schema.index({ closed: 1 });
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  injectTenantField(schema, scope);

  // ── Overlap guard: prevent overlapping date ranges within a tenant ─────
  schema.pre('validate', async function () {
    const doc = this as unknown as mongoose.Document & {
      startDate: Date;
      endDate: Date;
      [key: string]: unknown;
    };
    if (!doc.startDate || !doc.endDate) return;

    // A period overlaps if: existing.startDate < this.endDate AND existing.endDate > this.startDate
    const overlapQuery: Record<string, unknown> = {
      _id: { $ne: doc._id },
      startDate: { $lt: doc.endDate },
      endDate: { $gt: doc.startDate },
    };

    if (multiTenant) {
      overlapQuery[multiTenant.tenantField] = doc[multiTenant.tenantField];
    }

    const overlap = await doc.collection.findOne(overlapQuery);
    if (overlap) {
      const msg = `Fiscal period overlaps with existing period "${overlap.name}" (${new Date(overlap.startDate).toISOString().split('T')[0]} – ${new Date(overlap.endDate).toISOString().split('T')[0]}).`;
      doc.invalidate('startDate', msg, doc.startDate, 'overlap');
    }
  });

  return schema;
}
