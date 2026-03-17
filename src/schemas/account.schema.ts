/**
 * Account Schema Factory
 *
 * Creates a Mongoose schema for Chart of Accounts that is:
 * - Multi-tenant aware (adds org field + compound indexes when configured)
 * - Validates accountTypeCode against the country pack
 * - Supports accountNumber (unique per org) and name (user-facing display)
 * - Lean: no cached balances — always computed from journal entries
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';

export function createAccountSchema(
  config: AccountingEngineConfig,
  options: SchemaOptions = {},
) {
  const { multiTenant, country } = config;
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  // ── Base fields ──────────────────────────────────────────────────────────

  const fields: Record<string, unknown> = {
    accountTypeCode: {
      type: String,
      required: true,
      validate: {
        validator: (code: string) => country.isValidAccountType(code),
        message: (props: { value: string }) =>
          `"${props.value}" is not a valid account type code for ${country.name}.`,
      },
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    active: { type: Boolean, default: true },
    isCashAccount: { type: Boolean, default: false },
    ...extraFields,
  };

  // ── Multi-tenant field ───────────────────────────────────────────────────

  if (multiTenant) {
    fields[multiTenant.orgField] = {
      type: mongoose.Schema.Types.ObjectId,
      ref: multiTenant.orgRef,
      required: true,
    };
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = new mongoose.Schema(fields as any, { timestamps: true });

  // ── Pre-validate: auto-default accountNumber and name ──────────────────

  schema.pre('validate', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = this as any;
    if (!doc.accountNumber && doc.accountTypeCode) {
      doc.accountNumber = doc.accountTypeCode;
    }
    if (!doc.name && doc.accountTypeCode) {
      const at = country.getAccountType(doc.accountTypeCode);
      doc.name = at?.name ?? doc.accountTypeCode;
    }
  });

  // ── Indexes ──────────────────────────────────────────────────────────────

  if (indexes) {
    if (multiTenant) {
      const org = multiTenant.orgField;
      schema.index({ [org]: 1, active: 1 });
      // accountNumber is the unique identity per org
      schema.index({ [org]: 1, accountNumber: 1 }, { unique: true });
      // accountTypeCode is non-unique — multiple accounts can share a classification
      schema.index({ [org]: 1, accountTypeCode: 1 });
    } else {
      schema.index({ active: 1 });
      schema.index({ accountNumber: 1 }, { unique: true });
      schema.index({ accountTypeCode: 1 });
    }
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
