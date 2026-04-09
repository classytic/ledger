/**
 * Invoice mapper — converts fin-io CanonicalInvoice (from QBO, Xero, or IIF)
 * into a multi-line JournalEntry:
 *
 *   Sales invoice (type=sales):
 *     DR Receivables (total)
 *     CR Revenue per line item
 *     CR Tax Liability (taxTotal)
 *
 *   Purchase invoice (type=purchase):
 *     DR Expense per line item
 *     DR Tax Receivable (taxTotal)
 *     CR Payables (total)
 */

import type { CanonicalInvoice } from '@classytic/fin-io';
import type { Cents } from '../../types/core';
import type { ImportMapper, JournalEntryInput } from '../../types/sync';

export interface InvoiceMapperConfig {
  /** ObjectId for Accounts Receivable (sales) or Accounts Payable (purchase). */
  receivablesAccountId: unknown;
  payablesAccountId: unknown;
  /** Default revenue account (used when invoice line has no accountCode). */
  defaultRevenueAccountId: unknown;
  /** Default expense account. */
  defaultExpenseAccountId: unknown;
  /** Tax liability account (for sales tax collected). */
  taxLiabilityAccountId?: unknown;
  /** Tax receivable account (for purchase tax paid). */
  taxReceivableAccountId?: unknown;
  /** Map accountCode from the source to a ledger Account ObjectId. */
  resolveAccountCode?: (code: string) => unknown | undefined;
}

export function invoiceMapper(config: InvoiceMapperConfig): ImportMapper<CanonicalInvoice> {
  return {
    externalId: (inv) => inv.externalId,

    toJournalEntry: (inv) => {
      const isSales = inv.type === 'sales';
      const total = Number(inv.total.amount) as Cents;
      const taxTotal = Number(inv.taxTotal.amount) as Cents;
      const items: JournalEntryInput['journalItems'] = [];

      // AR/AP line for the full invoice total
      if (isSales) {
        items.push({
          account: config.receivablesAccountId,
          debit: total,
          credit: 0 as Cents,
        });
      } else {
        items.push({
          account: config.payablesAccountId,
          debit: 0 as Cents,
          credit: total,
        });
      }

      // Revenue/expense lines per invoice line item
      for (const line of inv.lines) {
        const lineAmount = Number(line.amount.amount) as Cents;
        const resolvedAccount = line.accountCode
          ? config.resolveAccountCode?.(line.accountCode)
          : undefined;
        const account =
          resolvedAccount ??
          (isSales ? config.defaultRevenueAccountId : config.defaultExpenseAccountId);

        if (isSales) {
          items.push({
            account,
            debit: 0 as Cents,
            credit: lineAmount,
            label: line.description,
          });
        } else {
          items.push({
            account,
            debit: lineAmount,
            credit: 0 as Cents,
            label: line.description,
          });
        }
      }

      // Tax line (if any)
      if (taxTotal > 0) {
        const taxAccount = isSales ? config.taxLiabilityAccountId : config.taxReceivableAccountId;
        if (taxAccount) {
          if (isSales) {
            items.push({
              account: taxAccount,
              debit: 0 as Cents,
              credit: taxTotal,
            });
          } else {
            items.push({
              account: taxAccount,
              debit: taxTotal,
              credit: 0 as Cents,
            });
          }
        }
      }

      return {
        date: inv.issueDate,
        label: `${isSales ? 'Sales' : 'Purchase'} Invoice — ${inv.contact.name ?? inv.externalId}`,
        referenceNumber: inv.externalId,
        journalItems: items,
        extra: {
          _importSource: 'invoice-import',
          _importContactName: inv.contact.name,
          _importContactRef: inv.contact.reference,
        },
      };
    },
  };
}
