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
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';
import { buildCurrencyField } from './currency-field.js';

export function createAccountSchema(config: AccountingEngineConfig, options: SchemaOptions = {}) {
  const { country } = config;
  const scope = resolveLedgerTenant(config);
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
    // accountNumber and name are NOT marked `required: true` at the Mongoose
    // layer because the schema's `pre('validate')` hook (below) auto-defaults
    // them from `accountTypeCode` and `country.getAccountType(code).name` when
    // omitted. Arc's createMongooseAdapter generates the Fastify body schema
    // from this definition; making them required here would force callers to
    // pass them on every POST and break the kernel's auto-default contract
    // exposed in the SDK as `CreateAccountPayload.{accountNumber, name}?`.
    accountNumber: {
      type: String,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    active: { type: Boolean, default: true },
    isCashAccount: { type: Boolean, default: false },
  };

  // ── Multi-currency account field (opt-in) ──────────────────────────────
  const currencyField = buildCurrencyField(config);
  if (currencyField) fields.currency = currencyField;

  Object.assign(fields, extraFields);

  // ── Schema ───────────────────────────────────────────────────────────────

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, { timestamps: true });

  // ── Pre-validate: auto-default accountNumber and name ──────────────────

  interface AccountValidateDoc {
    accountNumber?: string;
    accountTypeCode?: string;
    name?: string;
  }

  schema.pre('validate', function (this: mongoose.Document & AccountValidateDoc) {
    if (!this.accountNumber && this.accountTypeCode) {
      this.accountNumber = this.accountTypeCode;
    }
    if (!this.name && this.accountTypeCode) {
      const at = country.getAccountType(this.accountTypeCode);
      this.name = at?.name ?? this.accountTypeCode;
    }
  });

  // ── Indexes ──────────────────────────────────────────────────────────────
  //
  // Compound indexes are declared WITHOUT a tenant prefix — when
  // `multiTenant` is configured, `injectTenantField()` prepends the tenant
  // field onto every entry below so the resulting indexes stay
  // index-efficient under multi-tenant scoping.

  if (indexes) {
    schema.index({ active: 1 });
    // accountNumber is the unique identity (per org when scoped)
    schema.index({ accountNumber: 1 }, { unique: true });
    // accountTypeCode is non-unique — multiple accounts can share a classification
    schema.index({ accountTypeCode: 1 });
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  // Injects the tenant field (type follows `config.tenantFieldType`, default
  // `'objectId'`) and prepends it to the compound indexes above.
  injectTenantField(schema, scope);

  return schema;
}
