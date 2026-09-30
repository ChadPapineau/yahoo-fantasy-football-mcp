// errors.ts — the scoring engine's one error type: plan 08 §3.1 ("fail loudly" normaliser errors),
// §4.1 (bracket bounds / exclusivity → INTERNAL with the family named), §4.5 (no NaN reaches score).

/** Why the engine refused (a fixed vocabulary; `detail` names the offending ids/families). */
export type ScoringErrorCode =
  /** A settings field is malformed or out of range (the normaliser/compiler refused it). */
  | "invalid_settings"
  /** A canonical name does not match CANONICAL_NAME_RE. */
  | "invalid_canonical"
  /** Two rules map to one canonical name in one position type (plan 08 §3.1). */
  | "duplicate_canonical"
  /** One display name resolves to two different canonical names across a rule's position types. */
  | "ambiguous_canonical"
  /** A bracket family has a gap, an overlap or an inverted range (plan 08 §4.1). */
  | "bracket_bounds"
  /** An indicator family's members sum to more than 1, or a member is not 0/1 (plan 08 §4.1). */
  | "bracket_exclusivity"
  /** A stat line (or a sample batch) is malformed: non-finite / absurd value, bad position type. */
  | "invalid_line";

/** The most `detail` entries kept, and the longest one — hostile names can never bloat an error. */
const MAX_DETAIL = 10;
const MAX_DETAIL_LEN = 80;

/** A refusal by the scoring engine. The MCP layer classifies it as INTERNAL (plan 01 §4.3). */
export class ScoringError extends Error {
  override readonly name = "ScoringError";
  /** Fixed-vocabulary reason. */
  readonly code: ScoringErrorCode;
  /** The offending canonical names, platform ids or family names (truncated, at most 10). */
  readonly detail: readonly string[];

  constructor(code: ScoringErrorCode, message: string, detail: readonly string[] = []) {
    const kept = detail.slice(0, MAX_DETAIL).map((d) => d.slice(0, MAX_DETAIL_LEN));
    super(kept.length > 0 ? `${message}: ${kept.join(", ")}` : message);
    this.code = code;
    this.detail = Object.freeze(kept);
  }
}
