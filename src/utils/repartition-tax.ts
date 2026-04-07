/**
 * Repartition Tax Generator (0.6.0)
 *
 * Produces `TaxLineGenerator` implementations from a country pack's
 * declarative `TaxCode.repartition` definition. One tax percentage can
 * produce multiple journal items (Odoo-style), e.g.:
 *
 *   CA HST 13% (import reverse-charge):
 *     repartition: [
 *       { factor:  1, accountRole: 'collected',   gridCode: 105 },
 *       { factor: -1, accountRole: 'recoverable', gridCode: 108 },
 *     ]
 *
 *   BD VAT 15% on cash-basis sale:
 *     repartition: [
 *       { factor: 1, accountRole: 'transition', gridCode: 'VAT-OUT' },
 *     ]  (later moved to `'collected'` by cashBasisRealize plugin)
 *
 * The generator is account-resolver agnostic — the caller supplies a
 * function that maps an `accountRole` string to an account ObjectId in
 * the consumer's chart of accounts. The country pack's
 * `resolveTaxRepartitionAccountCode` then maps the role to the *code*;
 * the consumer's account registry handles code → ObjectId.
 */

import type { CountryPack, TaxCode, TaxRepartitionLine } from '../country/index.js';
import type { GeneratedTaxLine, TaxLineGenerator, TaxLineInput } from './tax-hooks.js';

/**
 * Resolves an `accountRole` (e.g. `'collected'`, `'recoverable'`,
 * `'transition'`) into the actual account ObjectId for the consumer's
 * chart of accounts. Implementations typically close over an account
 * cache loaded per organization at engine start.
 */
export type RepartitionAccountResolver = (
  role: string,
  taxCode: TaxCode,
  input: TaxLineInput,
) => unknown;

export interface RepartitionGeneratorOptions {
  /** Country pack — provides tax codes and optional resolver. */
  country: CountryPack;
  /** Required: resolve role → account id in the consumer's chart. */
  resolveAccount: RepartitionAccountResolver;
  /**
   * Document type — determines which repartition lines apply. A line
   * with `documentTypes: ['invoice']` is skipped when this is `'refund'`.
   * Defaults to `'invoice'`.
   */
  documentType?: 'invoice' | 'refund' | 'payment';
}

/**
 * Default role resolver used when the country pack doesn't override.
 * Walks `taxCodes` to find a code whose `direction` matches the role.
 */
function defaultResolveRoleCode(
  role: string,
  _tax: TaxCode,
  country: CountryPack,
): string | undefined {
  const direction =
    role === 'collected' ? 'collected' : role === 'recoverable' ? 'recoverable' : null;
  if (!direction) return undefined;
  for (const tc of Object.values(country.taxCodes)) {
    if (tc.direction === direction) return tc.code;
  }
  return undefined;
}

/**
 * Build a `TaxLineGenerator` that expands each hit `taxCode` into one
 * journal item per repartition line. Taxes without `repartition` fall
 * back to a single-line generator using the direction-implied account.
 */
export function createRepartitionTaxGenerator(
  options: RepartitionGeneratorOptions,
): TaxLineGenerator {
  const { country, resolveAccount, documentType = 'invoice' } = options;

  return {
    generateTaxLines(input: TaxLineInput): GeneratedTaxLine[] {
      const code = input.taxCode;
      if (!code) return [];
      const tax = country.taxCodes[code];
      if (!tax) return [];

      const baseTax = Math.round((input.amount * tax.rate) / 100);
      if (baseTax === 0) return [];

      const lines: TaxRepartitionLine[] =
        tax.repartition && tax.repartition.length > 0
          ? tax.repartition.filter(
              (line) => !line.documentTypes || line.documentTypes.includes(documentType),
            )
          : [
              {
                factor: 1,
                accountRole: tax.direction === 'recoverable' ? 'recoverable' : 'collected',
                gridCode: tax.reportLines?.[0],
              },
            ];

      const generated: GeneratedTaxLine[] = [];
      for (const rep of lines) {
        const signed = Math.round(baseTax * rep.factor);
        if (signed === 0) continue;

        const account = resolveAccount(rep.accountRole, tax, input);
        if (!account) {
          throw new Error(
            `repartitionTax: cannot resolve account for role "${rep.accountRole}" on tax "${tax.code}"`,
          );
        }

        // On the CREDIT side of revenue (sale): tax lands as credit on
        // collected, debit on recoverable. On DEBIT side (expense): tax
        // lands as debit on recoverable, credit on collected. Repartition
        // factor may flip the sign, and we honor that.
        const absAmount = Math.abs(signed);

        // Resolve the natural debit/credit side from the role + factor sign.
        // Roles that map to *liability* accounts (`collected`, `transition`)
        // have a credit normal balance — they grow on the credit side.
        // Roles that map to *asset/expense* accounts (`recoverable`,
        // `expense`) have a debit normal balance.
        //
        // A negative factor inverts the normal side (used for mirror
        // repartitions in reverse-charge scenarios).
        const liabilityRole = rep.accountRole === 'collected' || rep.accountRole === 'transition';
        let onCredit = liabilityRole;
        if (signed < 0) onCredit = !onCredit;

        generated.push({
          account,
          debit: onCredit ? 0 : absAmount,
          credit: onCredit ? absAmount : 0,
          label: rep.label ?? `${tax.name} ${rep.accountRole}`,
          taxDetails: [
            {
              taxCode: tax.code,
              taxName: tax.name,
              ...(rep.gridCode != null ? { gridCode: String(rep.gridCode) } : {}),
            },
          ],
        });
      }

      return generated;
    },
  };
}

/**
 * Helper for packs that want the standard "role → account-type code"
 * mapping without writing their own resolver. Returns the function you
 * stuff into `CountryPackInput.resolveTaxRepartitionAccountCode`.
 */
export function defaultResolveTaxRepartitionAccountCode(country: CountryPack) {
  return (role: string, tax: TaxCode): string | undefined =>
    defaultResolveRoleCode(role, tax, country);
}
