// rules.ts — the league-rule capability predicates the domain reads (plan 01 §8 "a small set of
// capability predicates the domain needs (hasFaab, waiverProcessingDays, tradeReviewMode);
// enumerations are partly [U] ... unknown values pass through as strings and the domain treats
// them conservatively"; plan 07 A2 `rules`; research 05 §14 items 3 and 6). Pure.
import type { LeagueRules, RuleCapabilities, TradeReviewMode } from "./types.js";

/** How free agents are acquired, reduced to what a recommendation needs. */
export type WaiverKind = "faab" | "priority" | "none" | "unknown";

/** An own-property lookup of a trimmed, lower-cased key (`__proto__`/`toString` never resolve). */
function lookup<T>(table: Readonly<Record<string, T>>, raw: string): T | undefined {
  const k = raw.trim().toLowerCase();
  return Object.hasOwn(table, k) ? table[k] : undefined;
}

/** Raw spellings (lower-cased) of each trade-review mode across platforms and league files. */
const TRADE_REVIEW_SPELLINGS: Readonly<Record<string, TradeReviewMode>> = Object.freeze({
  none: "none",
  no_review: "none",
  commish: "commissioner",
  commissioner: "commissioner",
  vote: "league_vote",
  league_vote: "league_vote",
  votes: "league_vote",
});

/** Maps a raw trade-ratify value to a mode; anything unrecognised is `unknown` (conservative). */
export function tradeReviewMode(raw: string | null): TradeReviewMode {
  if (raw === null) return "unknown";
  return lookup(TRADE_REVIEW_SPELLINGS, raw) ?? "unknown";
}

/** Raw spellings (lower-cased) of waiver systems. */
const WAIVER_SPELLINGS: Readonly<Record<string, WaiverKind>> = Object.freeze({
  faab: "faab",
  fr: "faab",
  rolling: "priority",
  r: "priority",
  reverse_standings: "priority",
  continual: "priority",
  priority: "priority",
  none: "none",
  free_agent: "none",
});

/**
 * The waiver kind: `faab` whenever the league uses FAAB (the flag wins over the type string),
 * otherwise the spelling's kind, otherwise `unknown`.
 */
export function waiverKind(waiverType: string | null, usesFaab: boolean): WaiverKind {
  if (usesFaab) return "faab";
  if (waiverType === null) return "unknown";
  const k = lookup(WAIVER_SPELLINGS, waiverType) ?? "unknown";
  // A type that says FAAB while the flag says otherwise is contradictory: trust neither.
  return k === "faab" ? "unknown" : k;
}

/** Waiver processing days as a predicate: a non-negative integer, else null (unknown). */
export function waiverProcessingDays(days: number | null): number | null {
  return days !== null && Number.isInteger(days) && days >= 0 && days <= 14 ? days : null;
}

/** The inputs the capability predicates are derived from. */
export interface RuleInputs {
  readonly uses_faab: boolean;
  readonly waiver_time_days: number | null;
  readonly trade_ratify_type: string | null;
}

/** Derives the capability predicates from the raw rule fields. */
export function ruleCapabilities(r: RuleInputs): RuleCapabilities {
  return Object.freeze({
    hasFaab: r.uses_faab,
    waiverProcessingDays: waiverProcessingDays(r.waiver_time_days),
    tradeReviewMode: tradeReviewMode(r.trade_ratify_type),
  });
}

/** The league runs FAAB bidding. */
export function hasFaab(rules: LeagueRules): boolean {
  return rules.capabilities.hasFaab;
}

/** Trades can be vetoed by other managers (research 05 §14 item 6: surface as a risk). */
export function tradesCanBeVetoed(rules: LeagueRules): boolean {
  return rules.capabilities.tradeReviewMode === "league_vote";
}

/**
 * Whether a FAAB bid is admissible: an integer 0..budget (and 0..balance when the balance is
 * known). With no FAAB, or an unknown budget, only the balance bounds it; with neither, false.
 */
export function isAdmissibleBid(rules: LeagueRules, bid: number, balance: number | null): boolean {
  if (!rules.capabilities.hasFaab || !Number.isInteger(bid) || bid < 0) return false;
  const cap = balance ?? rules.faab_budget;
  return cap !== null && bid <= cap;
}
