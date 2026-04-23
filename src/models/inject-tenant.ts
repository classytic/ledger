/**
 * Mongoose-specific adapter around `resolveTenantConfig()` from
 * `@classytic/primitives/tenant`. The pure resolution lives in primitives
 * (zero runtime deps) — this file only handles the Mongoose schema
 * mutations (add field, prepend tenant onto compound indexes) that
 * primitives can't own without a mongoose dependency.
 *
 * Prior to consolidation, each ledger schema (account, budget,
 * fiscal-period, journal, journal-entry, reconciliation) inlined the same
 * `if (multiTenant) { fields[multiTenant.tenantField] = { type: ObjectId,
 * ref, required: true } }` block. That logic now lives here — schemas call
 * `injectTenantField(schema, scope)` where `scope` is a
 * `ResolvedTenantConfig` produced by `resolveLedgerTenant()`.
 */

import { type ResolvedTenantConfig, resolveTenantConfig } from '@classytic/primitives/tenant';
import mongoose, { type Schema } from 'mongoose';
import type { AccountingEngineConfig, MultiTenantConfig } from '../types/engine.js';

/**
 * Translate ledger's `AccountingEngineConfig` into a `ResolvedTenantConfig`.
 *
 * Ledger's `MultiTenantConfig` tightens primitives' optionals (`tenantField`
 * and `ref` are required in ledger — no default org-collection name) and
 * carries a ledger-specific `plugin` knob for `multiTenantPlugin` adoption
 * that primitives doesn't own. We merge those with `config.tenantFieldType`
 * (engine-level field-type override) and produce a pure
 * `ResolvedTenantConfig` suitable for `injectTenantField()`.
 *
 * When `config.multiTenant` is absent, scoping is disabled (strategy =
 * `'none'`) and no tenant field is added to schemas.
 */
export function resolveLedgerTenant(config: AccountingEngineConfig): ResolvedTenantConfig {
  const mt = config.multiTenant;
  if (!mt) {
    return resolveTenantConfig(false);
  }

  return resolveTenantConfig({
    enabled: true,
    strategy: 'field',
    tenantField: mt.tenantField,
    ref: mt.ref,
    fieldType: config.tenantFieldType ?? 'objectId',
    // Schema-level required is always true in ledger when multi-tenant is
    // on — the plugin-level `required` knob (fail-closed on missing ctx)
    // lives on `MultiTenantConfig.required` and is wired into
    // multiTenantPlugin by the repository factory, not by the schema.
    required: true,
  });
}

/**
 * Narrower adapter for callers that already have a `MultiTenantConfig` in
 * hand but not the engine config. Defaults `fieldType` to `'objectId'`
 * because ledger's canonical storage for the tenant reference is an
 * ObjectId with a `ref` to the host's organization collection.
 */
export function resolveLedgerTenantFromMulti(
  mt: MultiTenantConfig | undefined,
  fieldType: 'objectId' | 'string' = 'objectId',
): ResolvedTenantConfig {
  if (!mt) return resolveTenantConfig(false);
  return resolveTenantConfig({
    enabled: true,
    strategy: 'field',
    tenantField: mt.tenantField,
    ref: mt.ref,
    fieldType,
    required: true,
  });
}

/**
 * Inject the tenant field into a Mongoose schema and (when
 * `strategy === 'field'` is active) prepend the tenant field onto every
 * existing compound index so queries are index-efficient under multi-tenant
 * scoping. Matches the order/people/revenue pattern (PACKAGE_RULES §9.2).
 *
 * Schemas should declare their compound indexes WITHOUT a tenant prefix
 * and then call this helper once — the prefix is added here.
 */
export function injectTenantField(schema: Schema, scope: ResolvedTenantConfig): void {
  const isFieldStrategy = scope.strategy === 'field';
  const isObjectId = scope.fieldType === 'objectId';

  if (isFieldStrategy) {
    const fieldDef: Record<string, unknown> = {
      type: isObjectId ? mongoose.Schema.Types.ObjectId : String,
      ...(scope.enabled && scope.required ? { required: true } : {}),
    };
    if (isObjectId && scope.ref) fieldDef.ref = scope.ref;
    schema.add({ [scope.tenantField]: fieldDef });
  }

  if (!scope.enabled || !isFieldStrategy) return;

  const existingIndexes = (
    schema as unknown as {
      _indexes: Array<[Record<string, unknown>, Record<string, unknown>]>;
    }
  )._indexes;
  if (existingIndexes && existingIndexes.length > 0) {
    for (const indexEntry of existingIndexes) {
      const fields = indexEntry[0];
      if (fields[scope.tenantField] !== undefined) continue;
      const newFields: Record<string, unknown> = { [scope.tenantField]: 1 };
      for (const [key, val] of Object.entries(fields)) {
        newFields[key] = val;
      }
      indexEntry[0] = newFields;
    }
  }
}
