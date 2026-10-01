// errors.ts — the analytics engines' one error type (plan 01 §4.3 codes via `ffCode`, the mapper's
// convention for domain errors; plan 07 E3 / C-14: no opponent roster → NOT_FOUND with the fixed
// MANUAL_NO_OPPONENT_HINT; a never-loaded dataset → STALE_ONLY with the error table's own hint).

/** Why an engine refused (fixed vocabulary). */
export type AnalyticsErrorCode =
  /** E3 / E2 `pwin` without an opponent roster for the week. */
  | "no_opponent"
  /** E3 / E2 `pwin` when the opponent's listed players leave starting slots empty (QA-1-043). */
  | "incomplete_opponent"
  /** A required dataset was never loaded (no file attached). */
  | "dataset_never_loaded"
  /** The request is outside what the engine accepts (bounds, positions, empty lineup). */
  | "invalid_request";

/**
 * The fixed hint for `no_opponent` — byte-identical to MANUAL_NO_OPPONENT_HINT in
 * src/providers/platform.ts (the domain may not import providers; a test pins the equality so the
 * error mapper's SERVER_HINTS check accepts it).
 */
export const NO_OPPONENT_HINT =
  "No opponent for this week in league.yaml: add - { week: <week>, team: <id> } under opponents (and that team's players under other_teams) to get a win probability, or use objective mean.";

/**
 * The fixed hint for `incomplete_opponent` (QA-1-043). The error mapper honours it once it is one of
 * SERVER_HINTS (src/providers/platform.ts); until then the refusal is a bare NOT_FOUND.
 */
export const INCOMPLETE_OPPONENT_HINT =
  "The opponent's players in league.yaml leave starting slots empty: list his full starting lineup to get a win probability, or use objective mean.";

const FF_CODE = Object.freeze({
  no_opponent: "NOT_FOUND",
  incomplete_opponent: "NOT_FOUND",
  dataset_never_loaded: "STALE_ONLY",
  invalid_request: "VALIDATION",
} as const);

/** A refusal by an analytics engine; `ffCode` is what src/mcp/errors.ts maps. */
export class AnalyticsError extends Error {
  override readonly name = "AnalyticsError";
  readonly code: AnalyticsErrorCode;
  /** The plan 01 §4.3 code the MCP layer answers with. */
  readonly ffCode: (typeof FF_CODE)[AnalyticsErrorCode];
  /** A fixed server hint (`no_opponent`, `incomplete_opponent`), else undefined. */
  readonly ffHint: string | undefined;
  /** Fixed-vocabulary detail (source ids, field names) — never data values. */
  readonly detail: readonly string[];

  constructor(code: AnalyticsErrorCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.code = code;
    this.ffCode = FF_CODE[code];
    this.ffHint =
      code === "no_opponent"
        ? NO_OPPONENT_HINT
        : code === "incomplete_opponent"
          ? INCOMPLETE_OPPONENT_HINT
          : undefined;
    this.detail = Object.freeze(detail.slice(0, 10).map((d) => d.slice(0, 80)));
  }
}
