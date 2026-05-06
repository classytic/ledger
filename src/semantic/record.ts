/**
 * Semantic Record API — high-level accounting operations.
 *
 * Instead of assembling journal items manually (which requires knowing
 * debit/credit rules and account ObjectIds), consumers call domain verbs:
 *
 *   await engine.record.sale(orgId, { amount: 10500, receivableAccount: '1001', revenueAccount: '4010' });
 *   await engine.record.expense(orgId, { amount: 5000, expenseAccount: '6010', paidFromAccount: '1001' });
 *   await engine.record.transfer(orgId, { amount: 10000, fromAccount: '1001', toAccount: '1002' });
 *   await engine.record.payment(orgId, { amount: 5000, fromReceivableAccount: '1200', toCashAccount: '1001' });
 *   await engine.record.adjustment(orgId, { lines: [{ account: '6010', debit: 500 }, { account: '1001', credit: 500 }] });
 *
 * All amounts are **integer cents**. All accounts are referenced by
 * their country-pack account type code (e.g. '1001', not an ObjectId).
 * The engine resolves codes to ObjectIds automatically, scoped by org.
 *
 * Every operation creates a **posted** journal entry and returns it.
 * All plugins (double-entry, fiscal-lock, idempotency) fire as usual.
 */

import type { ClientSession, Model, Types } from 'mongoose';
import { buildOpeningBalanceEntry } from '../builders/opening-balance.js';
import type { LedgerModels } from '../models/factory.js';
import type { LedgerRepositories } from '../repositories/factory.js';
import type { AccountingEngineConfig } from '../types/engine.js';
import { Errors } from '../utils/errors.js';

/**
 * A lightweight shape matching mongokit's UserContext — the actor that
 * performs an operation. Passed through to repository hooks as `context.user`,
 * where the audit-trail plugin picks up `user._id` automatically.
 */
export interface ActorContext {
  readonly _id?: string;
  readonly id?: string;
  readonly roles?: string | readonly string[];
  readonly [key: string]: unknown;
}

// ── Shared Input Types ────────────────────────────────────────────────────

export type AccountCode = string;

/** Integer-cents amount. */
export type Cents = number;

/**
 * Options passed to every record.* operation. Matches mongokit's
 * RepositoryContext shape so audit/observability plugins pick them up
 * with zero glue code.
 *
 * - `user` → surfaced on context.user (audit-trail reads user._id)
 * - `session` → surfaced on context.session (participates in transactions)
 * - `idempotencyKey` → sets journalEntry.idempotencyKey (requires idempotency: true in engine config)
 * - any extra field → spread into context for custom plugins
 */
export interface RecordOptions {
  readonly session?: ClientSession | null;
  /** The actor performing the operation — flows to hook `context.user`. */
  readonly user?: ActorContext;
  /** Short-hand: sets createdBy/postedBy on the journal entry directly. */
  readonly actorId?: string;
  /** Deterministic idempotency key (for at-most-once posting). */
  readonly idempotencyKey?: string;
  /** Extra context fields — picked up by custom plugins via context[key]. */
  readonly [key: string]: unknown;
}

// ── Per-Operation Inputs ──────────────────────────────────────────────────

export interface RecordSaleInput {
  /** Transaction date */
  readonly date: Date;
  /** Sale amount in integer cents. Tax, if any, is the caller's responsibility
   *  — compute it with your tax engine (e.g. `@classytic/bd-tax`,
   *  `@classytic/ca-tax`) and either pre-add it to `amount` + include a
   *  tax journal item via `record.adjustment`, or post the entry directly
   *  via `engine.repositories.journalEntries.create`. */
  readonly amount: Cents;
  /** Account that receives the money — either Cash or Accounts Receivable */
  readonly receivableAccount: AccountCode;
  /** Revenue account */
  readonly revenueAccount: AccountCode;
  /** Free-text label / memo */
  readonly label?: string;
  /** Optional reference number override (otherwise auto-generated) */
  readonly reference?: string;
  /** Extra fields to attach to journal items (e.g. departmentId, projectId) */
  readonly dimensions?: Record<string, unknown>;
  /** Journal type (defaults to 'SALES') */
  readonly journalType?: string;
}

export interface RecordExpenseInput {
  readonly date: Date;
  /** Expense amount in integer cents. Tax is caller's responsibility — see
   *  `RecordSaleInput.amount` comment. */
  readonly amount: Cents;
  /** Expense category account (e.g. '6010' Rent) */
  readonly expenseAccount: AccountCode;
  /** Where the money came from — either Cash or Accounts Payable */
  readonly paidFromAccount: AccountCode;
  readonly label?: string;
  readonly reference?: string;
  readonly dimensions?: Record<string, unknown>;
  readonly journalType?: string;
}

export interface RecordTransferInput {
  readonly date: Date;
  readonly amount: Cents;
  readonly fromAccount: AccountCode;
  readonly toAccount: AccountCode;
  readonly label?: string;
  readonly reference?: string;
  readonly dimensions?: Record<string, unknown>;
  readonly journalType?: string;
}

export interface RecordPaymentInput {
  readonly date: Date;
  readonly amount: Cents;
  /** Customer receivable account being cleared (e.g. '1200' AR) */
  readonly fromReceivableAccount: AccountCode;
  /** Cash account receiving the payment (e.g. '1001' Cash) */
  readonly toCashAccount: AccountCode;
  readonly label?: string;
  readonly reference?: string;
  readonly dimensions?: Record<string, unknown>;
  readonly journalType?: string;
}

export interface RecordAdjustmentLine {
  /** Account type code */
  readonly account: AccountCode;
  readonly debit?: Cents;
  readonly credit?: Cents;
  readonly label?: string;
}

export interface RecordAdjustmentInput {
  readonly date: Date;
  readonly lines: readonly RecordAdjustmentLine[];
  readonly label?: string;
  readonly reference?: string;
  readonly dimensions?: Record<string, unknown>;
  readonly journalType?: string;
}

export interface RecordOpeningBalanceInput {
  /** Cutover date — typically start of fiscal year. */
  readonly cutoverDate: Date;
  /**
   * Account balances in integer cents, signed:
   *   - Positive = normal debit balance (assets)
   *   - Negative = normal credit balance (liabilities, equity)
   *
   * Should only contain balance sheet accounts. P&L cumulative effect
   * belongs in retained earnings (the equity account).
   */
  readonly balances: ReadonlyArray<{
    readonly account: AccountCode;
    readonly balance: Cents;
  }>;
  /**
   * Equity contra account code. Defaults to the country pack's
   * `retainedEarningsAccountCode` (e.g. '3600' for CA, '3310' for BD).
   */
  readonly equityAccount?: AccountCode;
  readonly label?: string;
}

// ── Record API Shape ──────────────────────────────────────────────────────

export interface RecordAPI {
  /**
   * Record a sale. Debits cash/AR, credits revenue. Tax lines — if needed —
   * are the consumer's responsibility (compute via your tax engine and
   * either add to `amount` or use `record.adjustment`).
   *
   * @example
   * ```typescript
   * await engine.record.sale(orgId, {
   *   date: new Date('2025-04-01'),
   *   amount: 10000,                    // $100.00 total
   *   receivableAccount: '1001',        // Cash
   *   revenueAccount: '4010',           // Service Revenue
   *   label: 'Invoice #INV-001',
   * });
   * ```
   */
  sale(organizationId: unknown, input: RecordSaleInput, options?: RecordOptions): Promise<unknown>;

  /**
   * Record an expense. Debits expense, credits cash/AP. Tax is caller's
   * responsibility — see `sale()`.
   */
  expense(
    organizationId: unknown,
    input: RecordExpenseInput,
    options?: RecordOptions,
  ): Promise<unknown>;

  /**
   * Record a transfer between two balance-sheet accounts (e.g. cash → bank).
   */
  transfer(
    organizationId: unknown,
    input: RecordTransferInput,
    options?: RecordOptions,
  ): Promise<unknown>;

  /**
   * Record a customer payment (AR → Cash). Clears the receivable.
   */
  payment(
    organizationId: unknown,
    input: RecordPaymentInput,
    options?: RecordOptions,
  ): Promise<unknown>;

  /**
   * Record a general adjustment with arbitrary line items.
   * Use for corrections, accruals, depreciation — anything that doesn't fit
   * the other verbs. Amounts must balance (debits = credits).
   */
  adjustment(
    organizationId: unknown,
    input: RecordAdjustmentInput,
    options?: RecordOptions,
  ): Promise<unknown>;

  /**
   * Record opening balances for a cutover migration. Creates a single
   * multi-line journal entry with each account's balance, contra'd against
   * an equity account (retained earnings by default).
   *
   * Follows the Odoo convention: regular JE, not a special type. Only
   * balance sheet accounts should be passed — P&L cumulative effect belongs
   * in the equity contra account.
   *
   * Idempotent: uses `_externalId: 'opening-balance:{date}'` so re-calling
   * with the same cutover date fails cleanly (duplicate key error).
   *
   * @example
   * ```typescript
   * await engine.record.openingBalance(orgId, {
   *   cutoverDate: new Date('2025-01-01'),
   *   balances: [
   *     { account: '1000', balance: 5000000 },   // $50k cash
   *     { account: '2620', balance: -1875000 },   // $18.75k AP
   *     { account: '3600', balance: -3125000 },   // $31.25k RE
   *   ],
   * });
   * ```
   */
  openingBalance(
    organizationId: unknown,
    input: RecordOpeningBalanceInput,
    options?: RecordOptions,
  ): Promise<unknown>;
}

// ── Implementation ────────────────────────────────────────────────────────

interface BuildDeps {
  models: LedgerModels;
  repositories: LedgerRepositories;
  config: AccountingEngineConfig;
}

export function buildRecordAPI({ models, repositories, config }: BuildDeps): RecordAPI {
  const AccountModel = models.Account as Model<unknown>;
  // Scope field — used by `resolveAccounts` to filter the chart of accounts
  // (every collection is scoped under multiTenant). Set only when full
  // multi-tenant is enabled.
  const orgField = config.multiTenant?.tenantField;
  // Tag field — used by `postEntry` to stamp the JE doc with the originating
  // organization. Falls back to `journalEntryOrgField` for hosts that want
  // per-branch JE attribution without scoping the chart of accounts.
  const journalTagField = orgField ?? config.journalEntryOrgField;

  // ── Account resolver (code → ObjectId, scoped by org) ──
  const resolveAccounts = async (
    organizationId: unknown,
    codes: readonly AccountCode[],
    path: string,
    session?: ClientSession | null,
  ): Promise<Map<AccountCode, Types.ObjectId>> => {
    const unique = Array.from(new Set(codes));
    const filter: Record<string, unknown> = { accountTypeCode: { $in: unique } };
    if (orgField && organizationId != null) {
      filter[orgField] = organizationId;
    }

    const docs = (await AccountModel.find(filter)
      .select(`_id accountTypeCode`)
      .session(session ?? null)
      .lean()) as unknown as Array<{ _id: Types.ObjectId; accountTypeCode: string }>;

    const map = new Map<AccountCode, Types.ObjectId>();
    for (const d of docs) {
      // First-seen wins (duplicate protection — unique index should prevent this)
      if (!map.has(d.accountTypeCode)) map.set(d.accountTypeCode, d._id);
    }

    const missing: AccountCode[] = unique.filter((c) => !map.has(c));
    if (missing.length > 0) {
      throw Errors.notFound(
        `Account(s) not found in ${orgField && organizationId ? 'org' : 'default'} ` +
          `chart of accounts: ${missing.join(', ')}. ` +
          `Seed them first via engine.repositories.accounts.seedAccounts().`,
        missing.map((code) => ({
          path,
          issue: 'account type code not found in chart of accounts',
          value: code,
        })),
      );
    }

    return map;
  };

  // ── Shared: validate amount + post entry ──
  const validateAmount = (amount: Cents, path = 'amount'): void => {
    if (!Number.isInteger(amount)) {
      throw Errors.validation(`Amount must be an integer (cents), got ${amount}.`, [
        { path, issue: 'must be an integer', value: amount },
      ]);
    }
    if (amount <= 0) {
      throw Errors.validation(`Amount must be positive, got ${amount}.`, [
        { path, issue: 'must be positive', value: amount },
      ]);
    }
  };

  const postEntry = async (
    organizationId: unknown,
    payload: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<unknown> => {
    // Stamp the originating organization on the JE doc whenever we have a
    // tag field configured — covers full multi-tenant (where the field also
    // scopes every collection) and the lighter `journalEntryOrgField` mode
    // (per-branch attribution only).
    if (journalTagField && organizationId != null) {
      payload[journalTagField] = organizationId;
    }

    // Resolve actorId: prefer explicit options.actorId, otherwise derive from user._id/id
    const actorId =
      options?.actorId ??
      (options?.user ? (options.user._id?.toString() ?? options.user.id?.toString()) : undefined);
    if (actorId) {
      payload.createdBy = actorId;
      payload.postedBy = actorId;
    }
    if (options?.idempotencyKey) {
      payload.idempotencyKey = options.idempotencyKey;
    }

    payload.state = 'posted';

    // Build mongokit context — spread any extra options fields (e.g. custom
    // metadata) so audit-trail and observability plugins can read them.
    const ctx: Record<string, unknown> = {
      session: options?.session ?? undefined,
    };
    if (options?.user) ctx.user = options.user;
    // ctx.organizationId only flows when full multi-tenant is on — it's the
    // signal mongokit's multiTenantPlugin reads to filter writes/reads. The
    // lighter `journalEntryOrgField` mode is a doc tag, not a scoping key.
    if (orgField && organizationId != null) ctx.organizationId = organizationId;

    // Forward any unknown keys (e.g. ctx.req, ctx.sourceSubledger) to mongokit.
    if (options) {
      for (const key of Object.keys(options)) {
        if (key !== 'session' && key !== 'user' && key !== 'actorId' && key !== 'idempotencyKey') {
          ctx[key] = options[key];
        }
      }
    }

    return repositories.journalEntries.create(payload, ctx);
  };

  // ── Build a journal item with optional dimensions ──
  const buildItem = (
    account: Types.ObjectId,
    debit: Cents,
    credit: Cents,
    label?: string,
    dimensions?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    account,
    debit,
    credit,
    ...(label ? { label } : {}),
    ...(dimensions ?? {}),
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sale
  // ═══════════════════════════════════════════════════════════════════════

  const sale: RecordAPI['sale'] = async (organizationId, input, options) => {
    validateAmount(input.amount, 'amount');

    const codes: AccountCode[] = [input.receivableAccount, input.revenueAccount];

    const acctMap = await resolveAccounts(
      organizationId,
      codes,
      'receivableAccount',
      options?.session ?? null,
    );

    const items: Record<string, unknown>[] = [
      buildItem(
        acctMap.get(input.receivableAccount)!,
        input.amount,
        0,
        input.label,
        input.dimensions,
      ),
      buildItem(acctMap.get(input.revenueAccount)!, 0, input.amount, input.label, input.dimensions),
    ];

    return postEntry(
      organizationId,
      {
        journalType: input.journalType ?? 'SALES',
        date: input.date,
        label: input.label,
        referenceNumber: input.reference,
        journalItems: items,
      },
      options,
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // expense
  // ═══════════════════════════════════════════════════════════════════════

  const expense: RecordAPI['expense'] = async (organizationId, input, options) => {
    validateAmount(input.amount, 'amount');

    const codes: AccountCode[] = [input.expenseAccount, input.paidFromAccount];

    const acctMap = await resolveAccounts(
      organizationId,
      codes,
      'expenseAccount',
      options?.session ?? null,
    );

    const items: Record<string, unknown>[] = [
      buildItem(acctMap.get(input.expenseAccount)!, input.amount, 0, input.label, input.dimensions),
      buildItem(
        acctMap.get(input.paidFromAccount)!,
        0,
        input.amount,
        input.label,
        input.dimensions,
      ),
    ];

    return postEntry(
      organizationId,
      {
        journalType: input.journalType ?? 'PURCHASES',
        date: input.date,
        label: input.label,
        referenceNumber: input.reference,
        journalItems: items,
      },
      options,
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // transfer
  // ═══════════════════════════════════════════════════════════════════════

  const transfer: RecordAPI['transfer'] = async (organizationId, input, options) => {
    validateAmount(input.amount, 'amount');
    if (input.fromAccount === input.toAccount) {
      throw Errors.validation('Transfer source and destination accounts must be different.', [
        {
          path: 'fromAccount',
          issue: 'must differ from toAccount',
          value: { from: input.fromAccount, to: input.toAccount },
        },
      ]);
    }

    const acctMap = await resolveAccounts(
      organizationId,
      [input.fromAccount, input.toAccount],
      'fromAccount',
      options?.session ?? null,
    );

    const items = [
      buildItem(acctMap.get(input.toAccount)!, input.amount, 0, input.label, input.dimensions),
      buildItem(acctMap.get(input.fromAccount)!, 0, input.amount, input.label, input.dimensions),
    ];

    return postEntry(
      organizationId,
      {
        journalType: input.journalType ?? 'GENERAL',
        date: input.date,
        label: input.label,
        referenceNumber: input.reference,
        journalItems: items,
      },
      options,
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // payment
  // ═══════════════════════════════════════════════════════════════════════

  const payment: RecordAPI['payment'] = async (organizationId, input, options) => {
    validateAmount(input.amount, 'amount');

    const acctMap = await resolveAccounts(
      organizationId,
      [input.fromReceivableAccount, input.toCashAccount],
      'fromReceivableAccount',
      options?.session ?? null,
    );

    const items = [
      buildItem(acctMap.get(input.toCashAccount)!, input.amount, 0, input.label, input.dimensions),
      buildItem(
        acctMap.get(input.fromReceivableAccount)!,
        0,
        input.amount,
        input.label,
        input.dimensions,
      ),
    ];

    return postEntry(
      organizationId,
      {
        journalType: input.journalType ?? 'CASH_RECEIPTS',
        date: input.date,
        label: input.label,
        referenceNumber: input.reference,
        journalItems: items,
      },
      options,
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // adjustment
  // ═══════════════════════════════════════════════════════════════════════

  const adjustment: RecordAPI['adjustment'] = async (organizationId, input, options) => {
    if (!input.lines || input.lines.length < 2) {
      throw Errors.validation('Adjustment requires at least 2 lines.', [
        { path: 'lines', issue: 'must contain at least 2 entries', value: input.lines?.length },
      ]);
    }

    const lineErrors: Array<{ path: string; issue: string; value?: unknown }> = [];
    let totalDebit = 0;
    let totalCredit = 0;

    input.lines.forEach((line, idx) => {
      const d = line.debit ?? 0;
      const c = line.credit ?? 0;
      if (!Number.isInteger(d) || d < 0) {
        lineErrors.push({
          path: `lines.${idx}.debit`,
          issue: 'must be a non-negative integer',
          value: d,
        });
      }
      if (!Number.isInteger(c) || c < 0) {
        lineErrors.push({
          path: `lines.${idx}.credit`,
          issue: 'must be a non-negative integer',
          value: c,
        });
      }
      if (d > 0 && c > 0) {
        lineErrors.push({
          path: `lines.${idx}`,
          issue: 'line cannot have both debit and credit',
          value: { debit: d, credit: c },
        });
      }
      if (d === 0 && c === 0) {
        lineErrors.push({
          path: `lines.${idx}`,
          issue: 'line must have a non-zero debit or credit',
          value: { debit: 0, credit: 0 },
        });
      }
      totalDebit += d;
      totalCredit += c;
    });

    if (lineErrors.length > 0) {
      throw Errors.validation(
        `Invalid adjustment lines: ${lineErrors.length} issue(s).`,
        lineErrors,
      );
    }

    if (totalDebit !== totalCredit) {
      throw Errors.validation(
        `Adjustment not balanced: debits (${totalDebit}) ≠ credits (${totalCredit}).`,
        [
          {
            path: 'lines',
            issue: 'debits must equal credits',
            value: { totalDebit, totalCredit, difference: totalDebit - totalCredit },
          },
        ],
      );
    }

    const codes = input.lines.map((l) => l.account);
    const acctMap = await resolveAccounts(organizationId, codes, 'lines', options?.session ?? null);

    const items = input.lines.map((line) =>
      buildItem(
        acctMap.get(line.account)!,
        line.debit ?? 0,
        line.credit ?? 0,
        line.label ?? input.label,
        input.dimensions,
      ),
    );

    return postEntry(
      organizationId,
      {
        journalType: input.journalType ?? 'GENERAL',
        date: input.date,
        label: input.label,
        referenceNumber: input.reference,
        journalItems: items,
      },
      options,
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // openingBalance
  // ═══════════════════════════════════════════════════════════════════════

  const openingBalance: RecordAPI['openingBalance'] = async (organizationId, input, options) => {
    if (!input.balances || input.balances.length === 0) {
      throw Errors.validation('Opening balance requires at least one account balance.', [
        { path: 'balances', issue: 'must contain at least 1 entry', value: 0 },
      ]);
    }

    // Resolve equity account code — default from country pack
    const equityCode = input.equityAccount ?? config.country?.retainedEarningsAccountCode;

    if (!equityCode) {
      throw Errors.validation(
        'Equity contra account code is required. Pass equityAccount or configure retainedEarningsAccountCode in the country pack.',
        [{ path: 'equityAccount', issue: 'required', value: undefined }],
      );
    }

    // Build the opening balance JE using the pure function
    const result = buildOpeningBalanceEntry({
      cutoverDate: input.cutoverDate,
      balances: input.balances.map((b) => ({
        accountCode: b.account,
        balance: b.balance,
      })),
      equityAccountCode: equityCode,
      label: input.label,
    });

    // Resolve all account codes to ObjectIds
    const allCodes = result.entry.journalItems.map((item) => item.account as string);
    const acctMap = await resolveAccounts(
      organizationId,
      allCodes,
      'balances',
      options?.session ?? null,
    );

    // Replace account codes with ObjectIds in journal items
    const items = result.entry.journalItems.map((item) =>
      buildItem(acctMap.get(item.account as string)!, item.debit, item.credit, item.label),
    );

    return postEntry(
      organizationId,
      {
        journalType: result.entry.journalType ?? 'GENERAL',
        date: result.entry.date,
        label: result.entry.label,
        journalItems: items,
        ...result.entry.extra,
      },
      options,
    );
  };

  return { sale, expense, transfer, payment, adjustment, openingBalance };
}
