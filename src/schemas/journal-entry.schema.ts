/**
 * Journal Entry Schema Factory
 *
 * Creates a Mongoose schema for double-entry journal entries.
 * - Multi-tenant aware
 * - Embedded journal items with account refs
 * - State machine: draft → posted
 * - Auto-generated reference numbers
 * - Double-entry validation on post
 * - Optimized indexes for high-load reporting
 */

import mongoose from 'mongoose';
import type { AccountingEngineConfig, JournalSchemaOptions } from '../types/engine.js';
import { getJournalTypeCodes, JOURNAL_CODES } from '../constants/journals.js';

export function createJournalEntrySchema(
  config: AccountingEngineConfig,
  accountModelName: string,
  options: JournalSchemaOptions = {},
) {
  const { multiTenant } = config;
  const {
    indexes = true,
    autoReference = true,
    textSearch = true,
    extraFields = {},
    extraIndexes = [],
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
    },
    { _id: false },
  );

  // ── Main fields ──────────────────────────────────────────────────────────

  const fields: Record<string, unknown> = {
    journalType: {
      type: String,
      enum: getJournalTypeCodes(),
      default: JOURNAL_CODES['MISC'],
      required: true,
    },
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
    totalDebit: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'totalDebit must be an integer (cents)' } },
    totalCredit: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'totalCredit must be an integer (cents)' } },
    state: {
      type: String,
      enum: ['draft', 'posted'],
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

  // ── Pre-validate: double-entry enforcement ───────────────────────────────

  schema.pre('validate', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = this as any;

    // Propagate entry date to items without a date
    for (const item of doc.journalItems) {
      if (!item.date) item.date = doc.date;
    }

    // Each line must be debit OR credit (not both), and posted entries cannot have zero-value lines
    for (let i = 0; i < doc.journalItems.length; i++) {
      const d = doc.journalItems[i].debit || 0;
      const c = doc.journalItems[i].credit || 0;
      if (d > 0 && c > 0) {
        throw new Error(
          `Journal item at index ${i}: cannot have both debit (${d}) and credit (${c}) greater than zero`,
        );
      }
      if (doc.state === 'posted' && d === 0 && c === 0) {
        throw new Error(
          `Journal item at index ${i}: posted entries cannot have zero-value lines (both debit and credit are 0)`,
        );
      }
    }

    // Calculate totals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalDebit = doc.journalItems.reduce((s: number, i: any) => s + (i.debit || 0), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalCredit = doc.journalItems.reduce((s: number, i: any) => s + (i.credit || 0), 0);

    // Enforce minimum items and balance for posted entries
    if (doc.state === 'posted') {
      if (doc.journalItems.length < 2) {
        throw new Error('Posted entries must have at least 2 journal items');
      }
      if (totalDebit !== totalCredit) {
        throw new Error('Total debit must equal total credit for posted entries');
      }
    }

    doc.totalDebit = totalDebit;
    doc.totalCredit = totalCredit;
  });

  // ── Pre-save: auto-generate reference number ─────────────────────────────

  if (autoReference) {
    // Helper: compute next reference number from DB
    // Uses aggregation pipeline to extract & sort the numeric suffix,
    // avoiding lexicographic sort issues beyond sequence 9999.
    const generateReferenceNumber = async (doc: Record<string, unknown>, Model: mongoose.Model<unknown>, session: unknown) => {
      const jt = (doc.journalType as string) || 'MISC';
      const d = new Date(doc.date as string | number | Date);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const prefix = `${jt}/${year}/${month}/`;

      // Build match filter
      const matchFilter: Record<string, unknown> = {
        referenceNumber: { $regex: `^${prefix.replace(/\//g, '\\/')}` },
      };

      // Add org field to query for multi-tenant
      if (multiTenant) {
        matchFilter[multiTenant.orgField] = doc[multiTenant.orgField];
      }

      // Extract numeric suffix via $split and sort numerically
      const pipeline: mongoose.PipelineStage[] = [
        { $match: matchFilter },
        {
          $addFields: {
            _refSeq: {
              $toInt: {
                $arrayElemAt: [{ $split: ['$referenceNumber', '/'] }, -1],
              },
            },
          },
        },
        { $sort: { _refSeq: -1 as const } },
        { $limit: 1 },
        { $project: { _refSeq: 1 } },
      ];

      const results = await Model.aggregate(pipeline)
        .session(session as mongoose.mongo.ClientSession | null);

      let seq = 1;
      if (results.length > 0 && typeof results[0]._refSeq === 'number') {
        seq = results[0]._refSeq + 1;
      }

      return `${prefix}${String(seq).padStart(4, '0')}`;
    };

    schema.pre('save', async function () {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = this as any;

      if (doc.isModified('journalType')) {
        doc.referenceNumber = undefined;
      }

      if (!doc.referenceNumber) {
        const session = doc.$session?.() ?? null;
        const Model = doc.constructor as mongoose.Model<unknown>;
        doc.referenceNumber = await generateReferenceNumber(doc, Model, session);
      }
    });

    // Retry on duplicate key error (race condition between concurrent inserts)
    const MAX_REF_RETRIES = 3;
    schema.post('save', async function (error: Error, doc: unknown, next: (err?: Error) => void) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mongoError = error as any;
      // 11000 = MongoDB duplicate key error
      if (mongoError.code === 11000 && mongoError.keyPattern?.referenceNumber) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = doc as any;
        const retryCount: number = entry.__refRetries ?? 0;
        if (retryCount >= MAX_REF_RETRIES) {
          next(new Error(
            `Failed to generate unique reference number after ${MAX_REF_RETRIES} retries. ` +
            'Too many concurrent inserts for this period.',
          ));
          return;
        }
        entry.__refRetries = retryCount + 1;
        const session = entry.$session?.() ?? null;
        const Model = entry.constructor as mongoose.Model<unknown>;
        entry.referenceNumber = await generateReferenceNumber(entry, Model, session);
        try {
          await entry.save({ session });
          next();
        } catch (retryError) {
          next(retryError as Error);
        }
      } else {
        next(error);
      }
    });
  }

  // ── Indexes ──────────────────────────────────────────────────────────────

  if (indexes) {
    const org = multiTenant?.orgField;

    // Partial filter: unique constraint only applies to docs with a string
    // referenceNumber — allows multiple entries without a ref when autoReference is off.
    const refPartial = { partialFilterExpression: { referenceNumber: { $exists: true, $type: 'string' } } };

    if (org) {
      schema.index({ [org]: 1, referenceNumber: 1 }, { unique: true, ...refPartial });
      schema.index({ [org]: 1, state: 1, date: 1 });
      schema.index({ [org]: 1, date: -1 });
      schema.index({ [org]: 1, journalType: 1 });
      schema.index({ 'journalItems.account': 1, state: 1 });
      schema.index({ [org]: 1, 'journalItems.account': 1, date: 1, state: 1 });
    } else {
      schema.index({ referenceNumber: 1 }, { unique: true, ...refPartial });
      schema.index({ state: 1, date: 1 });
      schema.index({ date: -1 });
      schema.index({ journalType: 1 });
      schema.index({ 'journalItems.account': 1, state: 1 });
    }

    schema.index({ reversed: 1 });
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
