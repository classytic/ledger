/**
 * Account Resolver — declarative, auditable GL-account resolution.
 *
 * The problem it solves: a bill for "event poster printing" must post to the
 * Printing expense account, a utensils bill to Office Supplies, a stock receipt
 * to Inventory — WITHOUT a non-accountant ever typing a GL code, and without
 * hard-coding those choices into every posting contract.
 *
 * Odoo answers this with a rigid 3-level hierarchy (product → category →
 * company). We do better: a small RULE ENGINE. A rule is
 * `{ purpose, when, use }` — when the resolution context matches `when`, use
 * account `use` for that `purpose`. Rules are pure JSON data, so they:
 *   - live in the country pack (`@classytic/ledger-bd` ships BD defaults),
 *   - are overridable per deployment / per category / per product WITHOUT a
 *     deploy (host merges DB-configured rules on top),
 *   - carry a priority so specific rules beat general ones,
 *   - and every resolution returns a traceable `reason` (auditable: "why did
 *     this line post to 6301?").
 *
 * The matcher is `@classytic/primitives/condition` — the same JSON predicate
 * DSL the approval policies use, so hosts express account rules and approval
 * rules in one vocabulary (`{ field, op, value }`, `all`/`any`/`not`).
 *
 * The resolver is country-AGNOSTIC (no BD codes here). Concrete mappings are
 * data supplied by the country pack + host.
 *
 * @example
 *   const resolver = createAccountResolver({
 *     rules: [
 *       { id: 'print', purpose: 'expense', priority: 10,
 *         when: { field: 'keyword', op: 'in', value: ['printing', 'poster', 'card'] },
 *         use: '6301', label: 'Printing & Stationery' },
 *     ],
 *     defaults: { expense: '5000', revenue: '4111' },
 *   });
 *   resolver.resolve('expense', { keyword: 'poster' });
 *   //=> { code: '6301', ruleId: 'print', reason: 'Printing & Stationery' }
 *   resolver.resolve('expense', { keyword: 'misc' });
 *   //=> { code: '5000', ruleId: null, reason: 'default:expense' }
 */

import { type Condition, evaluate, validateCondition } from '@classytic/primitives/condition';

/**
 * Well-known account purposes. `AccountPurpose` stays an open `string` so a
 * deployment can introduce its own purposes (e.g. `'wip'`, `'landed_cost'`)
 * without patching this package — the resolver never enumerates them.
 */
export const ACCOUNT_PURPOSE = {
  REVENUE: 'revenue',
  EXPENSE: 'expense',
  COGS: 'cogs',
  INVENTORY: 'inventory',
  RECEIVABLE: 'receivable',
  PAYABLE: 'payable',
  CASH: 'cash',
  TAX_INPUT: 'tax_input',
  TAX_OUTPUT: 'tax_output',
  DISCOUNT: 'discount',
  ROUNDING: 'rounding',
  WRITEOFF: 'writeoff',
} as const;

export type AccountPurpose = string;

/**
 * One resolution rule. `when` is matched against the resolution context; a rule
 * with no `when` is an unconditional default for its purpose (still ordered by
 * priority, so it can act as a mid-tier fallback beneath more specific rules).
 */
export interface AccountRule {
  /** Stable id — appears in the resolution `reason` + audit trail. */
  readonly id: string;
  /** The purpose this rule answers (e.g. `'expense'`). */
  readonly purpose: AccountPurpose;
  /** Predicate over the context. Absent = always matches (a priced default). */
  readonly when?: Condition;
  /** GL account CODE to use when this rule wins. */
  readonly use: string;
  /** Higher wins. Ties keep declaration order. Default 0. */
  readonly priority?: number;
  /** Human-readable reason surfaced to auditors / the UI. */
  readonly label?: string;
}

/**
 * The facts about what's being posted. Free-form so hosts pass whatever they
 * have — the rules decide which fields matter. Common keys: `category`,
 * `keyword`, `productType`, `vertical`, `paymentMethod`, `regime`,
 * `partnerType`, `description`.
 */
export type AccountContext = Record<string, unknown>;

export interface ResolvedAccount {
  /** The chosen account code. */
  readonly code: string;
  /** The rule that won, or `null` when a purpose default was used. */
  readonly ruleId: string | null;
  /** Traceable explanation (rule label, `rule:<id>`, or `default:<purpose>`). */
  readonly reason: string;
}

export interface AccountResolverConfig {
  readonly rules?: readonly AccountRule[];
  /** Purpose → account code used when no rule matches. */
  readonly defaults?: Readonly<Record<AccountPurpose, string>>;
}

export interface AccountResolver {
  /**
   * Resolve the account for `purpose` given `ctx`. Returns `null` only when no
   * rule matches AND no default exists for the purpose — callers treat that as
   * a configuration error (the posting contract still has its own hard default
   * as the last line of defence).
   */
  resolve(purpose: AccountPurpose, ctx?: AccountContext): ResolvedAccount | null;
  /** The rules registered for a purpose, priority-sorted — for UI / audit. */
  rulesFor(purpose: AccountPurpose): readonly AccountRule[];
}

/**
 * Build a resolver from a config. Rules are indexed by purpose and sorted by
 * descending priority once, up front; `resolve` is then a linear scan of the
 * (usually tiny) per-purpose list — first match wins.
 */
export function createAccountResolver(config: AccountResolverConfig): AccountResolver {
  const byPurpose = new Map<AccountPurpose, AccountRule[]>();
  for (const rule of config.rules ?? []) {
    const list = byPurpose.get(rule.purpose);
    if (list) list.push(rule);
    else byPurpose.set(rule.purpose, [rule]);
  }
  // Sort priority desc. Array.sort is stable in every supported engine, so
  // equal-priority rules keep declaration order → deterministic resolution.
  for (const list of byPurpose.values()) {
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
  const defaults = config.defaults ?? {};

  return {
    resolve(purpose, ctx = {}) {
      const rules = byPurpose.get(purpose);
      if (rules) {
        for (const rule of rules) {
          if (rule.when === undefined || evaluate(rule.when, ctx)) {
            return {
              code: rule.use,
              ruleId: rule.id,
              reason: rule.label ?? `rule:${rule.id}`,
            };
          }
        }
      }
      const fallback = defaults[purpose];
      return fallback !== undefined
        ? { code: fallback, ruleId: null, reason: `default:${purpose}` }
        : null;
    },
    rulesFor(purpose) {
      return byPurpose.get(purpose) ?? [];
    },
  };
}

/**
 * Merge configs left-to-right: later rules are appended (they compete by
 * priority, so a higher-priority deployment rule beats a base pack rule), and
 * later defaults override earlier ones. Used by the host to layer
 * DB-configured overrides on top of the country pack's shipped ruleset.
 */
export function mergeAccountConfig(
  ...configs: readonly AccountResolverConfig[]
): AccountResolverConfig {
  return {
    rules: configs.flatMap((c) => c.rules ?? []),
    defaults: Object.assign({}, ...configs.map((c) => c.defaults ?? {})),
  };
}

/**
 * Normalize free text (a line description) into lowercase word tokens for
 * keyword rules. Splits on any non-alphanumeric run, drops 1-char noise, and
 * de-duplicates. Pair with rules that match `{ field: 'keywords', op:
 * 'contains', value: 'poster' }`.
 *
 * @example tokenizeKeywords('Event Posters + Invitation Cards')
 *          //=> ['event', 'posters', 'invitation', 'cards']
 */
export function tokenizeKeywords(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length <= 1) continue;
    seen.add(raw);
    // Crude singularization so a "Posters" line still matches a `poster` rule.
    // Cheap and good enough for keyword routing; a rule can always list both
    // forms explicitly when the stem is irregular.
    if (raw.length >= 4 && raw.endsWith('s')) seen.add(raw.slice(0, -1));
  }
  return [...seen];
}

/**
 * Validate every rule's condition + shape before persisting or booting. Throws
 * (via `validateCondition`) with a stable code on the first bad rule. Call this
 * when accepting host-authored rules from an API.
 */
export function validateAccountRules(rules: readonly AccountRule[]): void {
  for (const rule of rules) {
    if (!rule.id) throw new Error('account rule missing id');
    if (!rule.purpose) throw new Error(`account rule '${rule.id}' missing purpose`);
    if (!rule.use) throw new Error(`account rule '${rule.id}' missing 'use' account code`);
    if (rule.when !== undefined) validateCondition(rule.when);
  }
}
