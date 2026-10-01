// record.ts — builds and validates a recommendation-log row (plan 07 E12 input bounds; plan 01 §8.2
// `recommendation_log`; plan 02 §5/§6.2 caps; research 05 §12 "what to log"; critics C-01b, C-09, C-21).
// Defence in depth behind src/mcp's zod schema: domain may not import src/mcp, so the grammars are
// mirrored here and a test pins each mirror to the src/mcp original.

import {
  GSIS_ID_RE,
  KEY_MAX_CHARS,
  MANUAL_KEY_RE,
  YAHOO_KEY_RE,
  isLeagueKey,
  isNflTeam,
} from "../../config/schema.js";
import type { Assumption, Driver, InputFreshness, Rec, RecSubject } from "../analytics/types.js";
import { parseIso, type Clock, type Rng } from "../clock.js";
import { SLOT_NAME_RE } from "../league/types.js";
import { at } from "./metrics.js";
import type { Dist } from "../scoring/types.js";
import {
  DECISION_METRIC_RE,
  LOG_ID_RE,
  RECOMMENDATION_KINDS,
  TOOL_NAME_RE,
  type Alternative,
  type RecommendationRecord,
  type RecordRecommendationInput,
  type SourceCall,
} from "./types.js";

/** Bounds of an E12 record (mirrors plan 02 §5 / src/mcp BOUNDS, RECORD_LIMITS, REC_LIMITS). */
export const RECORD_BOUNDS = Object.freeze({
  week: { min: 1, max: 22 },
  season: { min: 2001, max: 2100 },
  /** rec.action, drivers[].name, assumptions[].*, alternatives[].action (TEXT_CAPS.rec_log_text). */
  textChars: 200,
  noteChars: 200,
  alternatives: 10,
  sourceCalls: 25,
  subjects: 20,
  lineup: 30,
  drivers: 20,
  assumptions: 20,
  inputs: 25,
  roleGames: 1000,
  /** Points bound on every point-valued field. */
  points: 1000,
  decisionMetricValue: 1e6,
  /** The serialised input cap (BOUNDS.recordInputChars). */
  inputChars: 20_000,
  isoChars: 40,
  /** How far `rec.as_of` may run ahead of the recording clock (clock skew), ms. */
  asOfSkewMs: 5 * 60 * 1000,
});

/**
 * Mirror of src/mcp/envelope.ts PRINTABLE_RE: no controls, format chars, surrogates, private use or
 * default-ignorable code points (QA-1-074).
 */
export const PRINTABLE_TEXT_RE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}]*$/u;
/** Mirror of src/mcp/envelope.ts REQUEST_ID_RE. */
export const REQUEST_ID_GRAMMAR = /^r-[0-9a-f]{12}$/;
/** Mirror of src/mcp/envelope.ts INPUT_SOURCE_RE. */
export const INPUT_SOURCE_GRAMMAR =
  /^(?:[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,47}|[a-z][a-z0-9_]{0,31}(?:\.[a-z0-9_]{1,31}){0,3})$/;
/** Mirror of src/mcp/bounds.ts clientRefSchema. */
export const CLIENT_REF_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** A settings hash is a code (plan 08: sha256 hex), never prose. */
export const SETTINGS_HASH_RE = /^[A-Za-z0-9:_-]{1,128}$/;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const ROLES: readonly string[] = ["start", "sit", "add", "drop", "stream", "trade_in", "trade_out"];
const FRESHNESS: readonly string[] = ["fresh", "stale", "provisional"];
const BASES: readonly string[] = ["position_cv", "player_sim"];
const HINTS: readonly string[] = ["unknown", "user_said_yes", "user_said_no"];

/** Days in month `mo` (1..12) of year `y` (proleptic Gregorian); 0 for a month outside 1..12. */
export function daysInMonth(y: number, mo: number): number {
  if (mo < 1 || mo > 12) return 0;
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

/** Whether `s` is an ISO-8601 instant with seconds and a zone (`Z` or `±hh:mm`), on a real date. */
export function isIsoInstant(s: unknown): s is string {
  if (typeof s !== "string" || s.length > RECORD_BOUNDS.isoChars) return false;
  const m = ISO_RE.exec(s);
  if (m === null) return false;
  // optional groups (the zone offset) are undefined at run time although typed string
  const n = Array.from(m, (v: string | undefined) => (v === undefined ? 0 : Number(v)));
  const days = daysInMonth(at(n, 1), at(n, 2));
  const d = at(n, 3);
  return (
    d >= 1 &&
    d <= days &&
    at(n, 4) <= 23 &&
    at(n, 5) <= 59 &&
    at(n, 6) <= 59 &&
    at(n, 8) <= 23 &&
    at(n, 9) <= 59
  );
}

/** Whether `s` is a player key of any grammar (Yahoo or manual), within its length cap. */
export function isPlayerKeyString(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length <= KEY_MAX_CHARS.player &&
    (YAHOO_KEY_RE.player.test(s) || MANUAL_KEY_RE.player.test(s))
  );
}

/** One validation problem: a JSON-ish path and a fixed-vocabulary code (never the offending value). */
export interface RecordIssue {
  readonly path: string;
  readonly code: string;
}

/** Thrown by buildRecord when the input fails validation; carries every issue found. */
export class RecordValidationError extends RangeError {
  readonly issues: readonly RecordIssue[];
  constructor(issues: readonly RecordIssue[]) {
    super(
      `reclog: invalid recommendation (${issues.map((i) => `${i.path}: ${i.code}`).join("; ")})`,
    );
    this.name = "RecordValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

type Issues = RecordIssue[];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkText(v: unknown, max: number, path: string, out: Issues): void {
  if (typeof v !== "string") out.push({ path, code: "not_a_string" });
  else if (v.length > max) out.push({ path, code: "too_long" });
  else if (!PRINTABLE_TEXT_RE.test(v)) out.push({ path, code: "unprintable_characters" });
}

function checkNumber(v: unknown, bound: number, path: string, out: Issues): void {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > bound)
    out.push({ path, code: "out_of_range" });
}

function checkInt(v: unknown, min: number, max: number, path: string, out: Issues): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    out.push({ path, code: "out_of_range" });
}

function checkArray(v: unknown, max: number, path: string, out: Issues): v is readonly unknown[] {
  if (!Array.isArray(v)) {
    out.push({ path, code: "not_an_array" });
    return false;
  }
  if (v.length > max) {
    out.push({ path, code: "too_many" });
    return false;
  }
  return true;
}

function checkIso(v: unknown, path: string, out: Issues): void {
  if (!isIsoInstant(v)) out.push({ path, code: "invalid_instant" });
}

function checkDist(v: unknown, path: string, out: Issues): void {
  if (!isObj(v)) {
    out.push({ path, code: "not_an_object" });
    return;
  }
  const before = out.length;
  for (const k of ["mean", "p10", "p25", "p50", "p75", "p90"])
    checkNumber(v[k], RECORD_BOUNDS.points, `${path}.${k}`, out);
  const pz = v.p_zero;
  if (typeof pz !== "number" || !(pz >= 0 && pz <= 1))
    out.push({ path: `${path}.p_zero`, code: "out_of_range" });
  if (typeof v.basis !== "string" || !BASES.includes(v.basis))
    out.push({ path: `${path}.basis`, code: "invalid_enum" });
  if (out.length === before) {
    const d = v as unknown as Dist;
    if (!(d.p10 <= d.p25 && d.p25 <= d.p50 && d.p50 <= d.p75 && d.p75 <= d.p90))
      out.push({ path, code: "quantiles_not_monotone" });
  }
}

function checkSubject(v: unknown, path: string, out: Issues): void {
  if (!isObj(v)) {
    out.push({ path, code: "not_an_object" });
    return;
  }
  const { player_key: pk, gsis_id: gs, nfl_team: tm, role, slot } = v;
  if (pk !== null && !isPlayerKeyString(pk))
    out.push({ path: `${path}.player_key`, code: "invalid_key" });
  if (gs !== null && !(typeof gs === "string" && GSIS_ID_RE.test(gs)))
    out.push({ path: `${path}.gsis_id`, code: "invalid_key" });
  if (tm !== null && !(typeof tm === "string" && isNflTeam(tm)))
    out.push({ path: `${path}.nfl_team`, code: "invalid_key" });
  if (pk === null && gs === null && tm === null) out.push({ path, code: "subject_without_id" });
  if (typeof role !== "string" || !ROLES.includes(role))
    out.push({ path: `${path}.role`, code: "invalid_enum" });
  if (slot !== null && !(typeof slot === "string" && SLOT_NAME_RE.test(slot)))
    out.push({ path: `${path}.slot`, code: "invalid_slot" });
}

function checkSubjects(v: unknown, path: string, out: Issues): void {
  if (checkArray(v, RECORD_BOUNDS.subjects, path, out))
    v.forEach((s, i) => {
      checkSubject(s, `${path}[${String(i)}]`, out);
    });
}

function checkRec(v: unknown, out: Issues): void {
  if (!isObj(v)) {
    out.push({ path: "rec", code: "not_an_object" });
    return;
  }
  const B = RECORD_BOUNDS;
  checkText(v.action, B.textChars, "rec.action", out);
  checkSubjects(v.subjects, "rec.subjects", out);
  if (v.lineup !== null && checkArray(v.lineup, B.lineup, "rec.lineup", out))
    v.lineup.forEach((s, i) => {
      const p = `rec.lineup[${String(i)}]`;
      if (!isObj(s)) out.push({ path: p, code: "not_an_object" });
      else {
        if (!(typeof s.slot === "string" && SLOT_NAME_RE.test(s.slot)))
          out.push({ path: `${p}.slot`, code: "invalid_slot" });
        if (!isPlayerKeyString(s.player_key))
          out.push({ path: `${p}.player_key`, code: "invalid_key" });
      }
    });
  checkNumber(v.point_estimate, B.points, "rec.point_estimate", out);
  checkDist(v.distribution, "rec.distribution", out);
  if (!isObj(v.delta_vs_next)) out.push({ path: "rec.delta_vs_next", code: "not_an_object" });
  else
    for (const k of ["value", "p10", "p90"])
      checkNumber(v.delta_vs_next[k], B.points, `rec.delta_vs_next.${k}`, out);
  if (!(typeof v.decision_metric === "string" && DECISION_METRIC_RE.test(v.decision_metric)))
    out.push({ path: "rec.decision_metric", code: "invalid_metric" });
  if (checkArray(v.drivers, B.drivers, "rec.drivers", out))
    v.drivers.forEach((d, i) => {
      const p = `rec.drivers[${String(i)}]`;
      if (!isObj(d)) out.push({ path: p, code: "not_an_object" });
      else {
        checkText(d.name, B.textChars, `${p}.name`, out);
        checkNumber(d.contribution, B.points, `${p}.contribution`, out);
      }
    });
  if (checkArray(v.assumptions, B.assumptions, "rec.assumptions", out))
    v.assumptions.forEach((a, i) => {
      const p = `rec.assumptions[${String(i)}]`;
      if (!isObj(a)) out.push({ path: p, code: "not_an_object" });
      else {
        checkText(a.text, B.textChars, `${p}.text`, out);
        checkText(a.revisit_trigger, B.textChars, `${p}.revisit_trigger`, out);
      }
    });
  const c = v.confidence;
  if (!isObj(c)) out.push({ path: "rec.confidence", code: "not_an_object" });
  else {
    checkInt(c.role_games, 0, B.roleGames, "rec.confidence.role_games", out);
    if (checkArray(c.inputs, B.inputs, "rec.confidence.inputs", out))
      c.inputs.forEach((inp, i) => {
        const p = `rec.confidence.inputs[${String(i)}]`;
        if (!isObj(inp)) out.push({ path: p, code: "not_an_object" });
        else {
          if (!(typeof inp.source === "string" && INPUT_SOURCE_GRAMMAR.test(inp.source)))
            out.push({ path: `${p}.source`, code: "invalid_source" });
          checkIso(inp.as_of, `${p}.as_of`, out);
          checkInt(inp.age_s, 0, Number.MAX_SAFE_INTEGER, `${p}.age_s`, out);
          if (typeof inp.freshness !== "string" || !FRESHNESS.includes(inp.freshness))
            out.push({ path: `${p}.freshness`, code: "invalid_enum" });
        }
      });
  }
  checkIso(v.as_of, "rec.as_of", out);
  if (v.latest_execution_time !== null)
    checkIso(v.latest_execution_time, "rec.latest_execution_time", out);
  if (typeof v.no_move !== "boolean") out.push({ path: "rec.no_move", code: "not_a_boolean" });
  if (v.log_id !== null) out.push({ path: "rec.log_id", code: "must_be_null" });
}

/**
 * Every problem with an E12 input, as `{path, code}` (empty when valid). `nowMs` bounds `rec.as_of`:
 * a recommendation cannot rest on data newer than the moment it is recorded (+ RECORD_BOUNDS.asOfSkewMs).
 */
export function validateRecordInput(
  input: RecordRecommendationInput,
  nowMs: number,
): RecordIssue[] {
  const out: Issues = [];
  const v = input as unknown;
  if (!isObj(v)) return [{ path: "", code: "not_an_object" }];
  const B = RECORD_BOUNDS;
  if (!(typeof v.league_key === "string" && isLeagueKey(v.league_key)))
    out.push({ path: "league_key", code: "invalid_key" });
  checkInt(v.season, B.season.min, B.season.max, "season", out);
  if (typeof v.kind !== "string" || !(RECOMMENDATION_KINDS as readonly string[]).includes(v.kind))
    out.push({ path: "kind", code: "invalid_enum" });
  checkInt(v.week, B.week.min, B.week.max, "week", out);
  checkRec(v.rec, out);
  if (isObj(v.rec) && isIsoInstant(v.rec.as_of) && parseIso(v.rec.as_of) > nowMs + B.asOfSkewMs)
    out.push({ path: "rec.as_of", code: "in_the_future" });
  if (checkArray(v.alternatives, B.alternatives, "alternatives", out))
    v.alternatives.forEach((a, i) => {
      const p = `alternatives[${String(i)}]`;
      if (!isObj(a)) out.push({ path: p, code: "not_an_object" });
      else {
        checkText(a.action, B.textChars, `${p}.action`, out);
        checkSubjects(a.subjects, `${p}.subjects`, out);
        checkNumber(a.point_estimate, B.points, `${p}.point_estimate`, out);
        checkDist(a.distribution, `${p}.distribution`, out);
        checkNumber(
          a.decision_metric_value,
          B.decisionMetricValue,
          `${p}.decision_metric_value`,
          out,
        );
      }
    });
  if (checkArray(v.source_calls, B.sourceCalls, "source_calls", out))
    v.source_calls.forEach((s, i) => {
      const p = `source_calls[${String(i)}]`;
      if (!isObj(s)) out.push({ path: p, code: "not_an_object" });
      else {
        if (!(typeof s.tool === "string" && TOOL_NAME_RE.test(s.tool)))
          out.push({ path: `${p}.tool`, code: "invalid_tool" });
        if (!(typeof s.request_id === "string" && REQUEST_ID_GRAMMAR.test(s.request_id)))
          out.push({ path: `${p}.request_id`, code: "invalid_request_id" });
      }
    });
  if (typeof v.followed_hint !== "string" || !HINTS.includes(v.followed_hint))
    out.push({ path: "followed_hint", code: "invalid_enum" });
  if (
    v.client_ref !== null &&
    !(typeof v.client_ref === "string" && CLIENT_REF_RE.test(v.client_ref))
  )
    out.push({ path: "client_ref", code: "invalid_client_ref" });
  if (v.note !== null) checkText(v.note, B.noteChars, "note", out);
  if (out.length === 0 && JSON.stringify(v).length > B.inputChars)
    out.push({ path: "", code: "input_too_large" });
  return out;
}

// --- ULID log ids (LOG_ID_RE: `rec-` + 26 Crockford base-32 chars) -------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The largest ULID timestamp: 2^48 − 1 ms. */
export const MAX_ULID_TIME = 2 ** 48 - 1;

/**
 * A new `log_id`: `rec-` + a ULID (48-bit ms timestamp from `clock`, 80 random bits from `rng`), so
 * ids sort by recording time. Throws RangeError when the clock is outside 0..2^48−1.
 */
export function mintLogId(clock: Clock, rng: Rng): string {
  let t = clock.nowMs();
  if (!Number.isInteger(t) || t < 0 || t > MAX_ULID_TIME)
    throw new RangeError("reclog: clock outside the ULID time range");
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD.charAt(Math.min(31, Math.floor(rng.next() * 32)));
  return `rec-${time}${rand}`;
}

/** Whether `s` is a well-formed log id. */
export function isLogId(s: unknown): s is string {
  return typeof s === "string" && LOG_ID_RE.test(s);
}

// --- normalised copies: the stored row has exactly the contract's fields, nothing smuggled ---------

function copyDist(d: Dist): Dist {
  return {
    mean: d.mean,
    p10: d.p10,
    p25: d.p25,
    p50: d.p50,
    p75: d.p75,
    p90: d.p90,
    p_zero: d.p_zero,
    basis: d.basis,
  };
}

function copySubject(s: RecSubject): RecSubject {
  return {
    player_key: s.player_key,
    gsis_id: s.gsis_id,
    nfl_team: s.nfl_team,
    role: s.role,
    slot: s.slot,
  };
}

function copyInput(i: InputFreshness): InputFreshness {
  return { source: i.source, as_of: i.as_of, age_s: i.age_s, freshness: i.freshness };
}

function copyRec(r: Rec): Rec {
  return {
    action: r.action,
    subjects: r.subjects.map(copySubject),
    lineup:
      r.lineup === null ? null : r.lineup.map((s) => ({ slot: s.slot, player_key: s.player_key })),
    point_estimate: r.point_estimate,
    distribution: copyDist(r.distribution),
    delta_vs_next: {
      value: r.delta_vs_next.value,
      p10: r.delta_vs_next.p10,
      p90: r.delta_vs_next.p90,
    },
    decision_metric: r.decision_metric,
    drivers: r.drivers.map((d: Driver) => ({ name: d.name, contribution: d.contribution })),
    assumptions: r.assumptions.map((a: Assumption) => ({
      text: a.text,
      revisit_trigger: a.revisit_trigger,
    })),
    confidence: { role_games: r.confidence.role_games, inputs: r.confidence.inputs.map(copyInput) },
    as_of: r.as_of,
    latest_execution_time: r.latest_execution_time,
    no_move: r.no_move,
    log_id: null,
  };
}

function copyAlternative(a: Alternative): Alternative {
  return {
    action: a.action,
    subjects: a.subjects.map(copySubject),
    point_estimate: a.point_estimate,
    distribution: copyDist(a.distribution),
    decision_metric_value: a.decision_metric_value,
  };
}

/** What buildRecord needs besides the input. */
export interface BuildRecordOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  /** The settings the call was made under (null when unknown). */
  readonly settingsHash: string | null;
}

/**
 * Validates an E12 input and returns the immutable log row: a fresh `log_id`, `recorded_at` from the
 * clock, and a normalised deep copy holding exactly the contract's fields (unknown keys dropped).
 * Throws RecordValidationError listing every issue. `rec.log_id` stays null in the stored row; the
 * tool returns the minted id beside it.
 */
export function buildRecord(
  input: RecordRecommendationInput,
  opts: BuildRecordOptions,
): RecommendationRecord {
  const now = opts.clock.nowMs();
  const issues = validateRecordInput(input, now);
  if (issues.length > 0) throw new RecordValidationError(issues);
  if (
    opts.settingsHash !== null &&
    !(typeof opts.settingsHash === "string" && SETTINGS_HASH_RE.test(opts.settingsHash))
  )
    throw new RecordValidationError([{ path: "settings_hash", code: "invalid_hash" }]);
  const record: RecommendationRecord = {
    league_key: input.league_key,
    season: input.season,
    kind: input.kind,
    week: input.week,
    rec: copyRec(input.rec),
    alternatives: input.alternatives.map(copyAlternative),
    source_calls: input.source_calls.map((s: SourceCall) => ({
      tool: s.tool,
      request_id: s.request_id,
    })),
    followed_hint: input.followed_hint,
    client_ref: input.client_ref,
    note: input.note,
    log_id: mintLogId(opts.clock, opts.rng),
    recorded_at: opts.clock.nowIso(),
    settings_hash: opts.settingsHash,
  };
  return record;
}
