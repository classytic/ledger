/**
 * Journal Repository Factory (0.6.0)
 *
 * Wires domain methods onto the Journal mongokit repository. Opt-in:
 * consumers that never call `seedDefaults` keep the 0.5.x enum-only
 * flow on journal entries. Consumers that seed get:
 *
 *   - Per-journal reference-number prefix
 *   - Per-journal sequence counter (isolated from other journals)
 *   - A discoverable catalogue for UI pickers
 *
 * The seed reads `countryPack.journalTemplates`. Packs without templates
 * get a lean default set (Sales / Purchase / Bank / Cash / Misc).
 */

import type { Repository } from '@classytic/mongokit';
import type { CountryPack, JournalTemplate } from '../country/index.js';
import type { JournalRepository, SeedResult } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

/**
 * Lean default set used when a country pack doesn't provide
 * `journalTemplates`. Covers the Stripe/QuickBooks/Xero baseline.
 */
const DEFAULT_TEMPLATES: readonly JournalTemplate[] = [
  { code: 'SALES', name: 'Sales', journalType: 'SALES', kind: 'sale', sequencePrefix: 'INV' },
  {
    code: 'PURCHASE',
    name: 'Purchases',
    journalType: 'PURCHASES',
    kind: 'purchase',
    sequencePrefix: 'BILL',
  },
  { code: 'BANK', name: 'Bank', journalType: 'CASH_RECEIPTS', kind: 'bank', sequencePrefix: 'BNK' },
  { code: 'CASH', name: 'Cash', journalType: 'CASH_PAYMENTS', kind: 'cash', sequencePrefix: 'CSH' },
  {
    code: 'MISC',
    name: 'Miscellaneous',
    journalType: 'MISC',
    kind: 'general',
    sequencePrefix: 'JE',
  },
];

export function wireJournalMethods<TDoc = Record<string, unknown>>(
  repository: Repository<TDoc>,
  country: CountryPack,
  orgField?: string,
): JournalRepository<TDoc> {
  const create = repository.create.bind(repository);
  const exists = repository.exists.bind(repository);

  repository.seedDefaults = async (orgId: unknown): Promise<SeedResult> => {
    requireOrgScope(orgField, orgId);

    const templates = country.journalTemplates ?? DEFAULT_TEMPLATES;
    let created = 0;
    let skipped = 0;

    for (const tpl of templates) {
      const existingQuery: Record<string, unknown> = { code: tpl.code };
      if (orgField && orgId != null) existingQuery[orgField] = orgId;

      const already = await exists(existingQuery);
      if (already) {
        skipped += 1;
        continue;
      }

      const data: Record<string, unknown> = {
        code: tpl.code,
        name: tpl.name,
        journalType: tpl.journalType,
        kind: tpl.kind ?? 'general',
        sequencePrefix: tpl.sequencePrefix ?? tpl.code,
        sequenceNextNum: tpl.sequenceStartNum ?? 1,
        active: true,
      };
      if (orgField && orgId != null) data[orgField] = orgId;

      await create(data as Parameters<typeof create>[0]);
      created += 1;
    }

    return { created, skipped };
  };

  repository.nextSequenceNumber = async (journalId: unknown, orgId?: unknown): Promise<string> => {
    requireOrgScope(orgField, orgId);

    const query: Record<string, unknown> = { _id: journalId };
    if (orgField && orgId != null) query[orgField] = orgId;

    // Atomic findOneAndUpdate($inc) — the sequence counter is the single
    // source of truth per journal, no race against concurrent posts.
    const updated = (await repository._executeQuery(async (Model) =>
      Model.findOneAndUpdate(
        query,
        { $inc: { sequenceNextNum: 1 } },
        { returnDocument: 'after' },
      ).lean(),
    )) as { sequenceNextNum?: number; sequencePrefix?: string; code?: string } | null;

    if (!updated) {
      throw Errors.notFound(`Journal ${String(journalId)} not found`);
    }

    const next = (updated.sequenceNextNum ?? 1) - 1; // $inc returned the post-increment value
    const prefix = updated.sequencePrefix ?? updated.code ?? 'JE';
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${prefix}/${year}/${month}/${String(next).padStart(4, '0')}`;
  };

  if (typeof repository.registerMethod === 'function') {
    for (const name of ['seedDefaults', 'nextSequenceNumber'] as const) {
      const fn = repository[name] as (...args: unknown[]) => unknown;
      try {
        delete repository[name];
        repository.registerMethod(name, fn);
      } catch {
        repository[name] = fn;
      }
    }
  }

  return repository as unknown as JournalRepository<TDoc>;
}
