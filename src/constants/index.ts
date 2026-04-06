/**
 * @classytic/ledger/constants
 */

export {
  CATEGORIES,
  CATEGORY_KEYS,
  categoryKey,
  extractMainType,
  extractStatementType,
  getCategoryMainType,
  getCategoryStatementType,
  getNormalBalance,
  isBalanceSheet,
  isIncomeStatement,
  isValidCategory,
} from './categories.js';
export {
  CURRENCIES,
  getCurrency,
  getMinorUnit,
  isValidCurrency,
} from './currencies.js';
export {
  getCustomJournalTypes,
  getJournalType,
  getJournalTypeCodes,
  isValidJournalType,
  JOURNAL_CODES,
  JOURNAL_TYPES,
  registerJournalType,
} from './journals.js';
