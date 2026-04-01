export {
  getDateRange,
  getFiscalYearStart,
} from './date-range.js';

export {
  isVirtualTaxAccount,
  isBalanceSheetAccountType,
  isIncomeStatementAccountType,
  calculateTotal,
  computeEndingBalance,
  buildAccountTypeMap,
} from './account-helpers.js';

export { buildItemFilters } from './filter-builder.js';

export { applyTaxHook } from './tax-hooks.js';
export type { TaxLineInput, GeneratedTaxLine, TaxLineGenerator } from './tax-hooks.js';

export {
  buildDimensionFields,
  buildDimensionIndexes,
} from './dimensions.js';
export type { DimensionDefinition } from './dimensions.js';
