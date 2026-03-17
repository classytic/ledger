/**
 * @classytic/ledger/constants
 */

export {
  CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  getCategoryMainType,
  getCategoryStatementType,
  isBalanceSheet,
  isIncomeStatement,
  getNormalBalance,
  categoryKey,
  extractMainType,
  extractStatementType,
} from './categories.js';

export {
  JOURNAL_TYPES,
  JOURNAL_CODES,
  getJournalTypeCodes,
  isValidJournalType,
  getJournalType,
} from './journals.js';

export {
  CURRENCIES,
  getCurrency,
  isValidCurrency,
  getMinorUnit,
} from './currencies.js';
