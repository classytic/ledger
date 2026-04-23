/**
 * Journal Entry Schema Factory
 *
 * Creates a Mongoose schema for double-entry journal entries.
 * - Multi-tenant aware
 * - Embedded journal items with account refs
 * - State machine: draft → posted, draft → archived
 * - Auto-generated reference numbers
 * - Double-entry validation on post
 * - Optimized indexes for high-load reporting
 */

import { getNextSequence } from '@classytic/mongokit';
import mongoose from 'mongoose';
import { _freezeJournalTypes, getJournalTypeCodes, JOURNAL_CODES } from '../constants/journals.js';
import { injectTenantField, resolveLedgerTenant } from '../models/inject-tenant.js';
import type { AccountingEngineConfig, JournalSchemaOptions } from '../types/engine.js';
import { buildCurrencyField } from './currency-field.js';

export function createJournalEntrySchema(
  config: AccountingEngineConfig,
  accountModelName: string,
  options: JournalSchemaOptions = {},
) {
  const { multiTenant } = config;
  const scope = resolveLedgerTenant(config);
  const {
    indexes = true,
    autoReference = true,
    textSearch = true,
    extraFields = {},
    extraIndexes = [],
    extraItemFields = {},
  } = options;

  // ── Tax Detail (audit reference only) ────────────────────────────────────

  const TaxDetailSchema = new mongoose.Schema(
    {
      taxCode: { type: String },
      taxName: { type: String },
    },
    { _id: false },
  );

  // ── Journal Item ─────────────────────────────────────────────────────────

  const amountValidator = {
    validator: (v: number) => Number.isInteger(v) && v >= 0,
    message: '{PATH} must be a non-negative integer (cents), got {VALUE}',
  };

  // ── Multi-currency item fields (opt-in) ──────────────────────────────────
  const currencyItemFields: Record<string, unknown> = {};
  const currencyField = buildCurrencyField(config);
  if (currencyField) {
    currencyItemFields.currency = currencyField;
    currencyItemFields.exchangeRate = {
      type: Number,
      default: null,
      validate: {
        validator: (v: number | null) => v === null || v > 0,
        message: 'exchangeRate must be greater than zero when set, got {VALUE}',
      },
    };
    // Allow null — `default: null` means the item may legitimately not
    // carry an original-currency amount. The integer guard only runs
    // when a value is actually provided.
    const originalAmountValidator = {
      validator: (v: number | null) =>
        v === null || v === undefined || (Number.isInteger(v) && v >= 0),
      message: '{PATH} must be a non-negative integer (cents), got {VALUE}',
    };
    currencyItemFields.originalDebit = {
      type: Number,
      default: null,
      validate: originalAmountValidator,
    };
    currencyItemFields.originalCredit = {
      type: Number,
      default: null,
      validate: originalAmountValidator,
    };
  }

  const JournalItemSchema = new mongoose.Schema(
    {
      account: {
        type: mongoose.Schema.Types.ObjectId,
        ref: accountModelName,
        required: true,
      },
      label: { type: String },
      date: { type: Date },
      debit: { type: Number, default: 0, min: 0, validate: amountValidator },
      credit: { type: Number, default: 0, min: 0, validate: amountValidator },
      taxDetails: { type: [TaxDetailSchema], default: [] },
      // Item-level open-item matching (0.6.0). Shared across items regardless
      // of which entry they belong to — one invoice line and one payment line
      // with the same matchingNumber are considered settled against each
      // other. null/absent = open. See `reconciliationRepository.match`.
      matchingNumber: { type: String, default: null },
      // Maturity date for aged-balance bucketing (Odoo `date_maturity`).
      // When absent, defaults to item.date or entry.date in reports.
      maturityDate: { type: Date, default: null },
      ...currencyItemFields,
      ...extraItemFields,
    },
    { _id: false },
  );

  // ── Main fields ──────────────────────────────────────────────────────────

  _freezeJournalTypes(); // lock registry — no more registerJournalType() after this point

  const fields: Record<string, unknown> = {
    journalType: {
      type: String,
      enum: getJournalTypeCodes(),
      default: JOURNAL_CODES.MISC,
      required: true,
    },
    // First-class Journal resource (0.6.0) — optional ref. When set, takes
    // precedence over `journalType` for reference-number generation and
    // flows into posting-contract routing. Nullable so consumers without
    // seeded journals keep the 0.5.x enum-only flow.
    journal: { type: mongoose.Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String },
    label: { type: String },
    date: {
      type: Date,
      default: Date.now,
      required: function (this: { state?: string }) {
        return this.state !== 'draft';
      },
    },
    journalItems: { type: [JournalItemSchema], default: [] },
    totalDebit: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'totalDebit must be an integer (cents)' },
    },
    totalCredit: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'totalCredit must be an integer (cents)' },
    },
    state: {
      type: String,
      enum: ['draft', 'posted', 'archived'],
      default: 'draft',
      required: true,
    },
    stateChangedAt: { type: Date, default: Date.now },
    reversed: { type: Boolean, default: false },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    reversalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    ...extraFields,
  };

  // ── Audit fields (conditional) ─────────────────────────────────────────

  if (config.audit?.trackActor) {
    fields.createdBy = { type: mongoose.Schema.Types.ObjectId, default: null };
    fields.postedBy = { type: mongoose.Schema.Types.ObjectId, default: null };
    fields.reversedByUser = { type: mongoose.Schema.Types.ObjectId, default: null };
  }

  // ── Approval fields (conditional) ──────────────────────────────────────

  if (config.strictness?.requireApproval || config.audit?.trackActor) {
    fields.approvedBy = { type: mongoose.Schema.Types.ObjectId, default: null };
    fields.approvedAt = { type: Date, default: null };
  }

  // ── Idempotency key (conditional) ──────────────────────────────────────

  if (config.idempotency) {
    fields.idempotencyKey = { type: String, default: null };
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  const schema = new mongoose.Schema(fields as mongoose.SchemaDefinition, {
    timestamps: true,
    // 0.9.0: optimistic concurrency guard — every `save()` includes `__v` in
    // the filter and bumps it atomically. Concurrent writers lose with a
    // Mongoose `VersionError`, which the repository layer translates to a
    // typed `ConcurrencyError`. Prevents draft→posted / posted→draft state
    // bounce under contention.
    optimisticConcurrency: true,
  });

  // ── Pre-validate: double-entry enforcement ───────────────────────────────

  interface JournalValidateDoc {
    journalItems: Array<{ date?: Date; debit?: number; credit?: number }>;
    date?: Date;
    state?: string;
    totalDebit: number;
    totalCredit: number;
  }

  schema.pre('validate', function (this: mongoose.Document & JournalValidateDoc) {
    // Propagate entry date to items without a date
    for (const item of this.journalItems) {
      if (!item.date) item.date = this.date;
    }

    // Each line must be debit OR credit (not both), and posted entries cannot have zero-value lines
    for (let i = 0; i < this.journalItems.length; i++) {
      const d = this.journalItems[i].debit ?? 0;
      const c = this.journalItems[i].credit ?? 0;
      if (d > 0 && c > 0) {
        throw new Error(
          `Journal item at index ${i}: cannot have both debit (${d}) and credit (${c}) greater than zero`,
        );
      }
      if (this.state === 'posted' && d === 0 && c === 0) {
        throw new Error(
          `Journal item at index ${i}: posted entries cannot have zero-value lines (both debit and credit are 0)`,
        );
      }
    }

    // Calculate totals
    const totalDebit = this.journalItems.reduce((s, item) => s + (item.debit ?? 0), 0);
    const totalCredit = this.journalItems.reduce((s, item) => s + (item.credit ?? 0), 0);

    // Enforce minimum items and balance for posted entries
    if (this.state === 'posted') {
      if (this.journalItems.length < 2) {
        throw new Error('Posted entries must have at least 2 journal items');
      }
      if (totalDebit !== totalCredit) {
        throw new Error('Total debit must equal total credit for posted entries');
      }
    }

    this.totalDebit = totalDebit;
    this.totalCredit = totalCredit;
  });

  // ── Pre-save: auto-generate reference number ─────────────────────────────

  if (autoReference) {
    // ─── Atomic reference allocator (0.9.0) ──────────────────────────────
    //
    // Replaces the pre-0.9 `aggregate({ $max }) + retry-on-11000` pattern
    // that caused duplicate `referenceNumber` allocation under concurrent
    // post (see the 5-concurrent-posts peer-review test).
    //
    // Delegates to `@classytic/mongokit`'s `getNextSequence(counterKey, 1,
    // connection, session)` which uses `findOneAndUpdate($inc, upsert,
    // returnDocument:'after')` on `_mongokit_counters`. Session-aware —
    // counter bumps commit atomically with caller transactions (requires
    // mongokit >=3.6.2 for the `session` parameter).
    //
    // Same counter collection (`_mongokit_counters`) as @classytic/invoice,
    // order, cart, revenue — one shared store across the monorepo.

    interface JournalSaveDoc {
      referenceNumber?: string;
      journalType?: string;
      date?: Date;
      isModified(path: string): boolean;
      $session?(): mongoose.mongo.ClientSession | null;
      constructor: mongoose.Model<unknown>;
      [key: string]: unknown;
    }

    schema.pre('save', async function (this: mongoose.Document & JournalSaveDoc) {
      // Changing the journal type invalidates the existing reference — the
      // new type needs its own partition and sequence. Clear + regenerate.
      if (this.isModified('journalType')) {
        this.referenceNumber = undefined;
      }

      if (!this.referenceNumber) {
        const session = this.$session?.() ?? null;
        const Model = this.constructor as mongoose.Model<unknown>;
        const connection = Model.db;
        const journalType = (this.journalType as string) || 'MISC';
        const date = this.date
          ? new Date(this.date as unknown as string | number | Date)
          : new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');

        // Multi-tenant partition — include org scope so sequences are per-tenant.
        // Use `.get()` so Mongoose returns the cast value (not the raw input).
        let orgScope = 'global';
        if (multiTenant) {
          const raw = (this as mongoose.Document).get(multiTenant.tenantField);
          if (raw != null) {
            orgScope =
              typeof (raw as { toHexString?: () => string }).toHexString === 'function'
                ? (raw as { toHexString: () => string }).toHexString()
                : String(raw);
          } else {
            orgScope = 'unscoped';
          }
        }

        // Counter key matches the format mongokit's `dateSequentialId`
        // generator produces for `partition: 'monthly'`, with an extra
        // `ledger:{orgScope}:` prefix for tenant isolation.
        const counterKey = `ledger:${orgScope}:${journalType}:${year}-${month}`;
        const seq = await getNextSequence(counterKey, 1, connection, session ?? undefined);
        this.referenceNumber = `${journalType}/${year}/${month}/${String(seq).padStart(4, '0')}`;
      }
    });

    // ─── Legacy retry path removed (0.9.0) ──────────────────────────────
    //
    // Before 0.9 a `post('save')` error handler caught dup-key errors on
    // `referenceNumber` and retried with a fresh aggregate. That allocator
    // was race-prone; 0.9 replaces it with the atomic counter above. Raw
    // E11000 now propagates up to mongokit's `parseDuplicateKeyError`, which
    // wraps it as a 409 error. The repository layer's `raceSafeCreate`
    // catches that and rethrows a typed `DuplicateReferenceError` with the
    // offending reference string, so consumers get an `instanceof`-friendly
    // error without parsing driver internals.
  }

  // ── Indexes ──────────────────────────────────────────────────────────────
  //
  // Compound indexes that want the tenant prefix are declared WITHOUT it
  // first — `injectTenantField()` prepends the tenant field onto each
  // entry below after the fact when multi-tenant is configured. Indexes
  // that should NOT be tenant-scoped (cross-org `'journalItems.account'`
  // probes, global `reversed` flag, TTL) are declared after the helper
  // call further down.

  if (indexes) {
    // Partial filter: unique constraint only applies to docs with a string
    // referenceNumber — allows multiple entries without a ref when autoReference is off.
    const refPartial = {
      partialFilterExpression: { referenceNumber: { $exists: true, $type: 'string' } },
    };

    schema.index({ referenceNumber: 1 }, { unique: true, ...refPartial });
    schema.index({ state: 1, date: 1 });
    schema.index({ date: -1 });
    schema.index({ journalType: 1 });
    // Tenant-scoped variant of the account+date+state compound — declared
    // here so the helper prepends the tenant field. The non-scoped
    // `{ 'journalItems.account': 1, state: 1 }` variant is added AFTER
    // the helper further down.
    if (scope.enabled) {
      schema.index({ 'journalItems.account': 1, date: 1, state: 1 });
    }

    // Open-item matching — tenant-scoped when multi-tenant is on.
    schema.index({ 'journalItems.matchingNumber': 1 });

    // Idempotency key: unique (only when enabled). Tenant prefix is
    // prepended by the helper when multi-tenant is configured.
    if (config.idempotency) {
      schema.index(
        { idempotencyKey: 1 },
        {
          unique: true,
          partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        },
      );
    }
  }

  // Inject tenant field + prepend it onto the compound indexes above.
  injectTenantField(schema, scope);

  // Indexes that must remain un-prefixed — added after the helper so the
  // tenant field is NOT prepended onto them.
  if (indexes) {
    // Cross-org account+state probe (used by reports that sum across all
    // tenants, e.g. consolidated trial balance).
    schema.index({ 'journalItems.account': 1, state: 1 });

    schema.index({ reversed: 1 });

    if (config.idempotency) {
      // TTL index — auto-expire old idempotency rows so stale replay keys
      // don't collide forever. Scoped to rows that carry an idempotencyKey
      // so normal journal entries are never TTL'd. Default: 24h (Stripe /
      // Saleor convention). Override via `config.idempotencyTtlSeconds`.
      const ttlSeconds =
        typeof config.idempotencyTtlSeconds === 'number' && config.idempotencyTtlSeconds > 0
          ? config.idempotencyTtlSeconds
          : 86_400;
      schema.index(
        { createdAt: 1 },
        {
          name: 'idempotency_ttl_idx',
          expireAfterSeconds: ttlSeconds,
          partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        },
      );
    }
  }

  if (textSearch) {
    schema.index(
      { referenceNumber: 'text', label: 'text' },
      { weights: { referenceNumber: 10, label: 5 }, name: 'journal_text_idx' },
    );
  }

  for (const idx of extraIndexes) {
    schema.index(idx.fields, idx.options);
  }

  return schema;
}
