/**
 * Cash Flow Statement — Indirect Method (IAS 7 / ASC 230)
 *
 *   Operating
 *     Net Income                                       (from period P&L aggregate)
 *     + Non-cash adjustments                           (depreciation, amortization, …)
 *     +/- Δ Working Capital                            (ΔA/R, ΔA/P, ΔInventory, …)
 *   Investing
 *     direct movements on fixed/non-current assets
 *   Financing
 *     direct movements on equity (excl. retained earnings) + non-current liabilities
 *   FX cash effect                                     (IAS 7 §28)
 *   Net Change in Cash
 *
 * Comparative analysis of ERPNext / QBO / Xero / Odoo informed the design;
 * see commerce/cashflow-fix.md §1A. Indirect Method is dominant (>98% of US
 * filers per EY's FRD on ASC 230). Section classification derives from the
 * country pack's `cashFlowCategory` taxonomy on Balance-Sheet accounts;
 * Income-Statement accounts are subsumed in Net Income except those tagged
 * as non-cash adjustments via `nonCashAdjustmentTag`. The Xero-style per-account
 * `cashflowSection` override on the Account model handles edge cases.
 *
 * The report supports one-or-many period columns through the same envelope:
 * `params.comparative === 'monthly'` expands a year into 12 monthly columns
 * + a YTD total; 'quarterly' expands into 4 quarterly columns + total. Single-
 * period reports (default) emit a single column keyed 'total'. Consumers
 * iterate `report.periods` and look up `line.amounts[col.key]` — no
 * branching for single- vs multi-period.
 *
 * `cashReconciliation[periodKey].tieOutOk` proves each column ties to the
 * actual cash + bank account balance delta for that column's window. A
 * `false` here means the algorithm has drifted from reality — fail-loud
 * QA signal, not user-facing.
 */

import type { Model, Types } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import type {
  CashFlowColumnReconciliation,
  CashFlowLine,
  CashFlowPeriodColumn,
  CashFlowReport,
  CashFlowSection,
} from '../types/report.js';
import { getDateRange } from '../utils/date-range.js';
import { buildItemFilters } from '../utils/filter-builder.js';
import { buildPeriodColumns, type InternalPeriod, isoDate } from '../utils/period-columns.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface CashFlowOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
}

type ObjectId = Types.ObjectId;

interface AccountRow {
  _id: ObjectId;
  accountTypeCode?: string;
  accountNumber?: string;
  name?: string;
  isCashAccount?: boolean;
  cashflowSection?: 'operating' | 'investing' | 'financing' | 'excluded' | null;
}

type Section = 'operating' | 'investing' | 'financing' | 'cash' | 'excluded';

interface AccountMeta extends AccountRow {
  category: string;
  cashFlowCategory: 'Operating' | 'Investing' | 'Financing' | null;
  nonCashAdjustmentTag: string | null;
  isBalanceSheet: boolean;
  isCash: boolean;
  section: Section;
}

interface PeriodMovement {
  d: number;
  c: number;
}

interface ColumnComputation {
  netIncome: number;
  nonCashByTag: Map<string, { amount: number; labels: string[] }>;
  bsMovements: Map<string, { section: Section; cashEffect: number; meta: AccountMeta }>;
  openingCash: number;
  closingCash: number;
  cashDelta: number;
}

const TAG_DISPLAY_NAMES: Record<string, string> = {
  depreciation: 'Depreciation',
  amortization: 'Amortization',
  impairment: 'Impairment',
  gain_on_disposal: 'Gain on disposal',
  loss_on_disposal: 'Loss on disposal',
  unrealized_fx: 'Unrealized FX',
  stock_based_compensation: 'Stock-based compensation',
};

/**
 * Country-pack convention: account codes 1111-1130 are cash & near-cash.
 * The per-Account `isCashAccount: true` flag is the authoritative override.
 */
function isCashAccount(meta: { isCashAccount?: boolean; accountTypeCode?: string }): boolean {
  if (meta.isCashAccount === true) return true;
  return /^11(1[0-9]|2[0-9]|30)$/.test(meta.accountTypeCode ?? '');
}

function resolveSection(
  meta: Pick<AccountMeta, 'cashflowSection' | 'isBalanceSheet' | 'isCash' | 'cashFlowCategory'>,
): Section {
  if (meta.cashflowSection) return meta.cashflowSection;
  if (!meta.isBalanceSheet) return 'excluded';
  if (meta.isCash) return 'cash';
  switch (meta.cashFlowCategory) {
    case 'Operating':
      return 'operating';
    case 'Investing':
      return 'investing';
    case 'Financing':
      return 'financing';
    default:
      return 'excluded';
  }
}

function tagDisplayName(tag: string): string {
  return TAG_DISPLAY_NAMES[tag] ?? tag.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function generateCashFlow(
  opts: CashFlowOptions,
  params: {
    organizationId?: unknown;
    dateOption: 'month' | 'quarter' | 'year' | 'custom';
    dateValue: unknown;
    /** Expand the outer range into per-month or per-quarter columns + a YTD total. */
    comparative?: 'monthly' | 'quarterly' | null;
    businessName?: string;
    filters?: Record<string, unknown>;
    currency?: string;
  },
): Promise<CashFlowReport> {
  const { AccountModel, JournalEntryModel, country, orgField } = opts;
  requireOrgScope(orgField, params.organizationId);
  const { startDate: outerStart, endDate: outerEnd } = getDateRange(
    params.dateOption,
    params.dateValue,
  );
  const itemFilters = buildItemFilters(params.filters);

  const periods = buildPeriodColumns(outerStart, outerEnd, params.comparative ?? null);

  // ─── Load chart of accounts + country-pack metadata ──────────────────────
  const accountQuery: Record<string, unknown> = { active: true };
  if (orgField && params.organizationId) accountQuery[orgField] = params.organizationId;
  const accounts = (await AccountModel.find(accountQuery).lean()) as AccountRow[];

  const metas = new Map<string, AccountMeta>();
  for (const acc of accounts) {
    const at = country.getAccountType(acc.accountTypeCode ?? '');
    if (!at || at.isGroup || at.isTotal) continue;

    const isBalanceSheet = at.category.startsWith('Balance Sheet-');
    const isCash = isCashAccount(acc);
    const meta: AccountMeta = {
      ...acc,
      category: at.category,
      cashFlowCategory: at.cashFlowCategory ?? null,
      nonCashAdjustmentTag: at.nonCashAdjustmentTag ?? null,
      isBalanceSheet,
      isCash,
      section: 'excluded',
    };
    meta.section = resolveSection(meta);
    metas.set(String(acc._id), meta);
  }

  if (metas.size === 0) return emptyReport(periods, params);

  // Compute one column at a time. Per-column queries trade roundtrips for
  // simplicity + correctness; comparative reports are bounded (≤13 columns
  // for monthly + total) and the aggregations are small. Pass the native
  // `Date` bounds directly (not the ISO strings) so $match in Mongo gets
  // the correct local-time boundaries on every server timezone.
  const columnComputations = new Map<string, ColumnComputation>();
  for (const period of periods) {
    columnComputations.set(
      period.column.key,
      await computeColumn({
        JournalEntryModel,
        metas,
        startDate: period.start,
        endDate: period.end,
        orgField,
        organizationId: params.organizationId,
        itemFilters,
      }),
    );
  }

  return assembleReport({
    periods: periods.map((p) => p.column),
    columnComputations,
    metas,
    outerStart,
    outerEnd,
    params,
  });
}

interface ColumnArgs {
  JournalEntryModel: Model<unknown>;
  metas: Map<string, AccountMeta>;
  startDate: Date;
  endDate: Date;
  orgField?: string;
  organizationId?: unknown;
  itemFilters: Record<string, unknown>;
}

async function computeColumn(args: ColumnArgs): Promise<ColumnComputation> {
  const { JournalEntryModel, metas, startDate, endDate, orgField, organizationId, itemFilters } =
    args;

  const baseMatch: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: startDate, $lte: endDate },
  };
  if (orgField && organizationId) baseMatch[orgField] = organizationId;

  const accountIds = [...metas.values()].map((m) => m._id);
  const periodRows = (await JournalEntryModel.aggregate([
    { $match: baseMatch },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: accountIds }, ...itemFilters } },
    {
      $group: {
        _id: '$journalItems.account',
        d: { $sum: '$journalItems.debit' },
        c: { $sum: '$journalItems.credit' },
      },
    },
  ])) as Array<{ _id: ObjectId; d: number; c: number }>;

  const movements = new Map<string, PeriodMovement>();
  for (const row of periodRows) movements.set(String(row._id), { d: row.d, c: row.c });

  // Net Income — Income credit-normal (c−d), Expense debit-normal (d−c, subtracted).
  let netIncome = 0;
  for (const meta of metas.values()) {
    if (meta.isBalanceSheet) continue;
    const m = movements.get(String(meta._id));
    if (!m) continue;
    if (meta.category === 'Income Statement-Income') netIncome += m.c - m.d;
    else if (meta.category === 'Income Statement-Expense') netIncome -= m.d - m.c;
  }

  // Non-cash adjustments grouped by tag. Add them BACK to Net Income so the
  // expense/income that didn't actually move cash doesn't reduce Operating cash.
  const nonCashByTag = new Map<string, { amount: number; labels: string[] }>();
  for (const meta of metas.values()) {
    if (!meta.nonCashAdjustmentTag) continue;
    const m = movements.get(String(meta._id));
    if (!m) continue;
    const addback = meta.category === 'Income Statement-Expense' ? m.d - m.c : -(m.c - m.d);
    const tag = meta.nonCashAdjustmentTag;
    const bucket = nonCashByTag.get(tag) ?? { amount: 0, labels: [] };
    bucket.amount += addback;
    if (!bucket.labels.includes(meta.name ?? meta.accountTypeCode ?? '')) {
      bucket.labels.push(meta.name ?? meta.accountTypeCode ?? '');
    }
    nonCashByTag.set(tag, bucket);
  }

  // Bucket Balance-Sheet movements into sections. Sign rule: cash effect = -(d − c).
  const bsMovements = new Map<
    string,
    { section: Section; cashEffect: number; meta: AccountMeta }
  >();
  for (const meta of metas.values()) {
    if (!meta.isBalanceSheet) continue;
    if (meta.section === 'cash' || meta.section === 'excluded') continue;
    const m = movements.get(String(meta._id));
    if (!m || (m.d === 0 && m.c === 0)) continue;
    bsMovements.set(String(meta._id), {
      section: meta.section,
      cashEffect: -(m.d - m.c),
      meta,
    });
  }

  // Cash boundary: opening + closing cash balances for this column window.
  const cashIds = [...metas.values()].filter((m) => m.isCash).map((m) => m._id);
  const { openingCash, closingCash } = await computeCashBalances({
    JournalEntryModel,
    cashIds,
    startDate,
    endDate,
    orgField,
    organizationId,
  });

  return {
    netIncome,
    nonCashByTag,
    bsMovements,
    openingCash,
    closingCash,
    cashDelta: closingCash - openingCash,
  };
}

interface AssembleArgs {
  periods: CashFlowPeriodColumn[];
  columnComputations: Map<string, ColumnComputation>;
  metas: Map<string, AccountMeta>;
  outerStart: Date;
  outerEnd: Date;
  params: {
    businessName?: string;
    currency?: string;
    comparative?: 'monthly' | 'quarterly' | null;
  };
}

function assembleReport(args: AssembleArgs): CashFlowReport {
  const { periods, columnComputations, metas, outerStart, outerEnd, params } = args;

  // Discover every line that appears in ANY column. Lines that are zero in
  // some columns still render across the row — same as comparative reports
  // in ERPNext / QBO. Stable iteration order: Net Income, non-cash by tag,
  // BS lines by code.
  const tagsSeen = new Set<string>();
  const tagLabels = new Map<string, string>();
  const bsAccountIds = new Set<string>();

  for (const comp of columnComputations.values()) {
    for (const tag of comp.nonCashByTag.keys()) tagsSeen.add(tag);
    for (const [tag, b] of comp.nonCashByTag.entries()) {
      const label =
        b.labels.length === 1
          ? b.labels[0]
          : `${tagDisplayName(tag)} (${b.labels.length} accounts)`;
      tagLabels.set(tag, label);
    }
    for (const id of comp.bsMovements.keys()) bsAccountIds.add(id);
  }

  const sortedTags = [...tagsSeen].sort((a, b) =>
    tagDisplayName(a).localeCompare(tagDisplayName(b)),
  );
  const sortedBs = [...bsAccountIds]
    .map((id) => ({ id, meta: metas.get(id) }))
    .filter((x): x is { id: string; meta: AccountMeta } => !!x.meta)
    .sort((a, b) => {
      const codeA = a.meta.accountNumber ?? a.meta.accountTypeCode ?? '';
      const codeB = b.meta.accountNumber ?? b.meta.accountTypeCode ?? '';
      return codeA.localeCompare(codeB, undefined, { numeric: true });
    });

  // ─── Build per-column amount maps ───────────────────────────────────────
  const netIncomeAmounts: Record<string, number> = {};
  const nonCashAmounts: Record<string, Record<string, number>> = {}; // tag → period → amount
  const bsAmounts: Record<string, Record<string, number>> = {}; // accountId → period → amount
  const fxByCol: Record<string, number> = {};
  const operatingTotals: Record<string, number> = {};
  const investingTotals: Record<string, number> = {};
  const financingTotals: Record<string, number> = {};
  const netCashByCol: Record<string, number> = {};
  const reconByCol: Record<string, CashFlowColumnReconciliation> = {};

  for (const tag of sortedTags) nonCashAmounts[tag] = {};
  for (const x of sortedBs) bsAmounts[x.id] = {};

  for (const col of periods) {
    const comp = columnComputations.get(col.key);
    if (!comp) continue;

    netIncomeAmounts[col.key] = comp.netIncome;
    fxByCol[col.key] = 0; // Single-currency hosts; multi-currency is a future feature.

    let opTotal = comp.netIncome;
    let invTotal = 0;
    let finTotal = 0;

    for (const tag of sortedTags) {
      const amt = comp.nonCashByTag.get(tag)?.amount ?? 0;
      nonCashAmounts[tag][col.key] = amt;
      opTotal += amt;
    }

    for (const x of sortedBs) {
      const mv = comp.bsMovements.get(x.id);
      const amt = mv?.cashEffect ?? 0;
      bsAmounts[x.id][col.key] = amt;
      if (mv) {
        if (mv.section === 'operating') opTotal += amt;
        else if (mv.section === 'investing') invTotal += amt;
        else if (mv.section === 'financing') finTotal += amt;
      }
    }

    operatingTotals[col.key] = opTotal;
    investingTotals[col.key] = invTotal;
    financingTotals[col.key] = finTotal;
    netCashByCol[col.key] = opTotal + invTotal + finTotal + fxByCol[col.key];

    const calculated = comp.openingCash + netCashByCol[col.key];
    reconByCol[col.key] = {
      openingCash: comp.openingCash,
      closingCash: comp.closingCash,
      calculated,
      tieOutOk: Math.abs(comp.closingCash - calculated) <= 1,
    };
  }

  // ─── Compose section objects ────────────────────────────────────────────
  const operating: CashFlowSection = {
    totals: operatingTotals,
    lines: [
      {
        label: 'Net Income',
        code: '',
        amounts: { ...netIncomeAmounts },
        source: { kind: 'netIncome' },
      },
      ...sortedTags.map<CashFlowLine>((tag) => ({
        label: tagLabels.get(tag) ?? tagDisplayName(tag),
        code: '',
        amounts: { ...nonCashAmounts[tag] },
        source: { kind: 'nonCashAdjustment', tag },
      })),
      ...sortedBs
        .filter((x) => x.meta.section === 'operating')
        .map<CashFlowLine>((x) => ({
          label: x.meta.name ?? x.meta.accountTypeCode ?? '',
          code: x.meta.accountNumber ?? x.meta.accountTypeCode ?? '',
          amounts: { ...bsAmounts[x.id] },
          source: { kind: 'workingCapital', accountId: x.id },
        })),
    ],
  };

  const investing: CashFlowSection = {
    totals: investingTotals,
    lines: sortedBs
      .filter((x) => x.meta.section === 'investing')
      .map<CashFlowLine>((x) => ({
        label: x.meta.name ?? x.meta.accountTypeCode ?? '',
        code: x.meta.accountNumber ?? x.meta.accountTypeCode ?? '',
        amounts: { ...bsAmounts[x.id] },
        source: { kind: 'directMovement', accountId: x.id },
      })),
  };

  const financing: CashFlowSection = {
    totals: financingTotals,
    lines: sortedBs
      .filter((x) => x.meta.section === 'financing')
      .map<CashFlowLine>((x) => ({
        label: x.meta.name ?? x.meta.accountTypeCode ?? '',
        code: x.meta.accountNumber ?? x.meta.accountTypeCode ?? '',
        amounts: { ...bsAmounts[x.id] },
        source: { kind: 'directMovement', accountId: x.id },
      })),
  };

  const periodDisplay = `${outerStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${outerEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;

  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: isoDate(outerStart),
      periodEnd: isoDate(outerEnd),
      displayPeriod: periodDisplay,
      ...(params.currency ? { currency: params.currency } : {}),
      comparative: params.comparative ?? null,
    },
    periods,
    operating,
    investing,
    financing,
    fxEffect: fxByCol,
    netCashFlow: netCashByCol,
    cashReconciliation: reconByCol,
  };
}

interface CashBalanceArgs {
  JournalEntryModel: Model<unknown>;
  cashIds: ObjectId[];
  startDate: Date;
  endDate: Date;
  orgField?: string;
  organizationId?: unknown;
}

async function computeCashBalances(args: CashBalanceArgs): Promise<{
  openingCash: number;
  closingCash: number;
}> {
  const { JournalEntryModel, cashIds, startDate, endDate, orgField, organizationId } = args;
  if (cashIds.length === 0) return { openingCash: 0, closingCash: 0 };

  const match: Record<string, unknown> = { state: 'posted' };
  if (orgField && organizationId) match[orgField] = organizationId;

  const rows = (await JournalEntryModel.aggregate([
    { $match: match },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: cashIds } } },
    {
      $group: {
        _id: null,
        opening: {
          $sum: {
            $cond: [
              { $lt: ['$date', startDate] },
              { $subtract: ['$journalItems.debit', '$journalItems.credit'] },
              0,
            ],
          },
        },
        closing: {
          $sum: {
            $cond: [
              { $lte: ['$date', endDate] },
              { $subtract: ['$journalItems.debit', '$journalItems.credit'] },
              0,
            ],
          },
        },
      },
    },
  ])) as Array<{ opening?: number; closing?: number }>;

  return {
    openingCash: rows[0]?.opening ?? 0,
    closingCash: rows[0]?.closing ?? 0,
  };
}

function emptyReport(
  periods: InternalPeriod[],
  params: {
    businessName?: string;
    currency?: string;
    comparative?: 'monthly' | 'quarterly' | null;
  },
): CashFlowReport {
  const zeros: Record<string, number> = {};
  const recon: Record<string, CashFlowColumnReconciliation> = {};
  for (const p of periods) {
    zeros[p.column.key] = 0;
    recon[p.column.key] = { openingCash: 0, closingCash: 0, calculated: 0, tieOutOk: true };
  }
  const outerStart = periods[0].start;
  const outerEnd = periods[periods.length - 1].end;
  const periodDisplay = `${outerStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${outerEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;
  return {
    metadata: {
      businessName: params.businessName,
      generatedAt: new Date().toISOString(),
      periodStart: isoDate(outerStart),
      periodEnd: isoDate(outerEnd),
      displayPeriod: periodDisplay,
      ...(params.currency ? { currency: params.currency } : {}),
      comparative: params.comparative ?? null,
    },
    periods: periods.map((p) => p.column),
    operating: {
      totals: { ...zeros },
      lines: [
        {
          label: 'Net Income',
          code: '',
          amounts: { ...zeros },
          source: { kind: 'netIncome' },
        },
      ],
    },
    investing: { totals: { ...zeros }, lines: [] },
    financing: { totals: { ...zeros }, lines: [] },
    fxEffect: { ...zeros },
    netCashFlow: { ...zeros },
    cashReconciliation: recon,
  };
}
