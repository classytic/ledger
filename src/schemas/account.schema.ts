/**
 * Account Schema Factory
 *
 * Creates a Mongoose schema for Chart of Accounts that is:
 * - Multi-tenant aware (adds org field + compound indexes when configured)
 * - Supports accountNumber (unique per org) and name (user-facing display)
 * - Lean: no cached balances — always computed from journal entries
 *
 * Country-specific validation (accountTypeCode against the country pack) is
 * intentionally NOT done at the schema layer — schema validators are baked in
 * at model-registration time and would bleed across country engines that share
 * the same connection. Validation lives in wireAccountMethods.before:create.
 */

import mongoose from 'mongoose';
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, SchemaOptions } from '../types/engine.js';
import { buildCurrencyField } from './currency-field.js';

export function createAccountSchema(config: AccountingEngineConfig, options: SchemaOptions = {}) {
  const scope = resolveLedgerTenant(config);
  const { indexes = true, extraFields = {}, extraIndexes = [] } = options;

  // ── Base fields ──────────────────────────────────────────────────────────

  const fields: Record<string, unknown> = {
    accountTypeCode: {
      type: String,
      required: true,
      // No country-specific Mongoose validator here. Mongoose schema validators
      // are baked into the schema at model-registration time. When multiple
      // country engines share the same connection, only the first engine's model
      // is registered — subsequent engines reuse it, so a CA validator would
      // fire on AU writes and reject AU-only codes. Country validation lives
      // in wireAccountMethods.before:create, which executes in the context of
      // the calling repository instance and always uses the correct country pack.
    },
    // accountNumber and name are NOT marked `required: true` at the Mongoose
    // layer. The schema's `pre('validate')` hook auto-defaults accountNumber
    // from accountTypeCode when omitted, and wireAccountMethods.before:create
    // auto-defaults name from the country pack. Arc's createMongooseAdapter
    // generates the Fastify body schema from this definition; making them
    // required here would force callers to pass them on every POST and break
    // the kernel's auto-default contract (CreateAccountPayload.{accountNumber, name}?).
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
    /**
     * Optional per-account override for Cash Flow Statement classification.
     * Wins over the country-pack `account_type` taxonomy. Use case: a
     * "Long-term deferred revenue" account whose type would default to
     * Financing but the business intent is Operating. Mirrors Xero's
     * per-account Cash Flow category override; one of:
     *   'operating' | 'investing' | 'financing' | 'excluded'
     * `null` (default) → fall back to country-pack inference.
     */
    cashflowSection: {
      type: String,
      enum: ['operating', 'investing', 'financing', 'excluded'],
      default: null,
    },
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
    // Name auto-default moved to wireAccountMethods.before:create — it needs
    // the live country pack to resolve the human-readable name, and the correct
    // pack is only available at the repository level, not at schema-definition time.
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
