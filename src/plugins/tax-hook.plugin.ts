/**
 * Tax Hook Plugin for @classytic/mongokit
 *
 * Auto-applies tax calculation hooks on `before:create` when the entry
 * is being posted (state === 'posted'). Delegates tax line generation
 * to a user-supplied TaxLineGenerator.
 */

import type { RepositoryInstance, RepositoryContext } from '@classytic/mongokit';
import type { TaxLineGenerator } from '../utils/tax-hooks.js';
import { applyTaxHook } from '../utils/tax-hooks.js';
import type { JournalItem } from '../types/core.js';

export interface TaxHookPluginOptions {
  /** Tax line generator — implements the tax calculation logic */
  generator: TaxLineGenerator;
  /** Only apply tax hooks on posted entries (default: true) */
  onlyOnPost?: boolean;
}

export function taxHookPlugin(options: TaxHookPluginOptions) {
  const { generator, onlyOnPost = true } = options;

  return {
    name: 'accounting:tax-hook',
    apply(repo: RepositoryInstance) {
      repo.on('before:create', (context: RepositoryContext) => {
        const data = context.data;
        if (!data) return;

        // Skip non-posted entries when onlyOnPost is true
        if (onlyOnPost && data.state !== 'posted') return;

        const items = data.journalItems as JournalItem[] | undefined;
        if (!items || items.length === 0) return;

        // Apply the tax hook and replace journal items with augmented list
        data.journalItems = applyTaxHook(items, generator);
      });
    },
  };
}
