/**
 * `periodResolver` — range-based lock resolver.
 *
 * Given a mongoose model whose documents represent closed time windows,
 * returns a resolver that blocks any entry whose date falls inside a
 * closed window.
 *
 * Document shape expected by default:
 *
 *   { [startField]: Date, [endField]: Date, [closedField]: boolean, name?: string }
 *
 * All field names and the "closed" predicate are configurable so the
 * same resolver handles fiscal periods, tax periods, bank recon windows,
 * payroll cycles, etc.
 *
 * The optional `extraQuery` callback lets callers further narrow the
 * match — for example, a tax-period lookup can add
 * `{ taxType: 'VAT', jurisdiction: 'BD-DHA' }`.
 */

import type { ClientSession, Model } from 'mongoose';
import type { LockHit, LockResolver, LockResolverContext } from './types.js';

export interface PeriodResolverOptions {
  /** Scope identifier, passed through to the resulting `LockHit`. */
  scope: string;
  /** Mongoose model holding closed-period rows. */
  PeriodModel: Model<unknown>;
  /** Field name for the start of the window. Default: `'startDate'`. */
  startField?: string;
  /** Field name for the end of the window. Default: `'endDate'`. */
  endField?: string;
  /**
   * Field name that indicates "this window is closed". Default:
   * `'closed'` (matches FiscalPeriod model).
   */
  closedField?: string;
  /** Value of the closed field that counts as closed. Default: `true`. */
  closedValue?: unknown;
  /** Field name to use as the display label in errors. Default: `'name'`. */
  labelField?: string;
  /** Field name to surface as `LockHit.subType`. Default: undefined. */
  subTypeField?: string;
  /** Field name to surface as `LockHit.externalRef`. Default: undefined. */
  externalRefField?: string;
  /** Multi-tenant scope field on the period doc. */
  orgField?: string;
  /**
   * Optional additional query fragment merged into the lookup. Receives
   * the resolver context so callers can derive dynamic filters from the
   * entry payload (e.g. pick `taxType` from `data`).
   */
  extraQuery?: (ctx: LockResolverContext) => Record<string, unknown> | undefined;
}

export function periodResolver(options: PeriodResolverOptions): LockResolver {
  const {
    scope,
    PeriodModel,
    startField = 'startDate',
    endField = 'endDate',
    closedField = 'closed',
    closedValue = true,
    labelField = 'name',
    subTypeField,
    externalRefField,
    orgField,
    extraQuery,
  } = options;

  return async (ctx): Promise<LockHit | null> => {
    const query: Record<string, unknown> = {
      [startField]: { $lte: ctx.entryDate },
      [endField]: { $gte: ctx.entryDate },
      [closedField]: closedValue,
    };

    if (orgField) {
      if (!ctx.orgValue) {
        throw new Error(
          `periodResolver[${scope}]: orgField "${orgField}" set but no orgValue was resolved.`,
        );
      }
      query[orgField] = ctx.orgValue;
    }

    const extra = extraQuery?.(ctx);
    if (extra) Object.assign(query, extra);

    const session = ctx.session as ClientSession | null;
    const doc = (await PeriodModel.findOne(query).session(session).lean()) as Record<
      string,
      unknown
    > | null;

    if (!doc) return null;

    return {
      scope,
      label: String(doc[labelField] ?? '(unnamed)'),
      subType: subTypeField ? (doc[subTypeField] as string | undefined) : undefined,
      externalRef: externalRefField ? (doc[externalRefField] as string | undefined) : undefined,
    };
  };
}
