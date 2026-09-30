// matcher.ts — the pure platform-player → gsis_id matcher (research 04 §D steps 1–4; plan 10 §3.1a
// "Crosswalk" + A5a; plan 05 §2 domain/crosswalk; plan 07 G1 `crosswalk` report, C1 { method, confidence }).
// Precedence: team units by team → manual override → exact id → persisted pair → name + team + position.
import type { NflTeam } from "../../config/schema.js";
import { GSIS_ID_RE } from "../../config/schema.js";
import type { IsoInstant, PlatformId, PlatformPlayer, ProjectionSubject } from "../league/types.js";
import {
  canonicalPlayerId,
  gsisFromManualKey,
  nativePlayerId,
  teamFromManualDefKey,
} from "./ids.js";
import { cleanGsisId, cleanId, nameKey } from "./normalize.js";
import { positionFamily } from "./positions.js";
import { normalizeTeam } from "./teams.js";
import {
  TEAM_UNIT_POSITIONS,
  type CrosswalkMethod,
  type CrosswalkOverride,
  type CrosswalkPair,
  type CrosswalkSource,
  type CrosswalkStatus,
  type MatchCandidate,
  type MatchEvidence,
  type NflRosterPlayer,
  type UnmatchedPlayer,
  type UnmatchedReport,
} from "./types.js";

/**
 * Confidence recorded on a pair. Exact (id / override / trusted platform gsis) is 1; a deterministic
 * match is 0.9, nudged by the jersey number, which may only ever break ties (research 04 §D step 2).
 */
export const MATCH_CONFIDENCE = Object.freeze({
  exact: 1,
  jerseyAgrees: 0.95,
  nameTeamPosition: 0.9,
  jerseyDisagrees: 0.85,
  jerseyTieBreak: 0.8,
});

/** Diagnostic weight of each kind of agreement (MatchCandidate.score = the sum, 2 dp). */
export const EVIDENCE_WEIGHTS: Readonly<Record<MatchEvidence, number>> = Object.freeze({
  id: 1,
  name: 0.4,
  team: 0.3,
  position: 0.2,
  jersey: 0.1,
});

/** A player not on a fantasy roster counts as "top owned" at or above this percent owned. */
export const TOP_OWNED_PERCENT = 50;

/** At most this many candidates are carried per unmatched/ambiguous player. */
export const MAX_REPORTED_CANDIDATES = 5;

const METHODS: readonly CrosswalkMethod[] = ["id", "match", "override"];
const SOURCES: readonly CrosswalkSource[] = [
  "nflverse:roster_weekly",
  "dynastyprocess:ids",
  "sleeper:players",
  "platform",
  "overrides",
];

// --- roster index --------------------------------------------------------------------------------

/** The platforms whose ids nflverse `roster_weekly` carries. */
export type RosterIdPlatform = "yahoo" | "sleeper" | "espn";

/** An in-memory index over the latest `roster_weekly` row per gsis id. */
export interface RosterIndex {
  /** Distinct gsis ids indexed. */
  readonly size: number;
  byGsis(gsisId: string): NflRosterPlayer | null;
  /** Rows carrying this platform id (more than one = the id is ambiguous and never used). */
  byPlatformId(platform: RosterIdPlatform, id: string): readonly NflRosterPlayer[];
  /** Rows whose `nameKey(full_name)` equals `key`. */
  byNameKey(key: string): readonly NflRosterPlayer[];
}

const EMPTY: readonly NflRosterPlayer[] = Object.freeze([]);

function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function isLater(a: NflRosterPlayer, b: NflRosterPlayer): boolean {
  return a.season > b.season || (a.season === b.season && a.week > b.week);
}

/**
 * Indexes roster rows: rows without a valid gsis id are dropped (the gsis id is trimmed first), the
 * latest (season, week) row per gsis id wins (ties keep the first), platform ids go through
 * `cleanId` so an empty or `NA` id can never match.
 */
export function buildRosterIndex(rows: readonly NflRosterPlayer[]): RosterIndex {
  const latest = new Map<string, NflRosterPlayer>();
  for (const row of rows) {
    const gsis = cleanGsisId(row.gsis_id);
    if (gsis === null) continue;
    const prev = latest.get(gsis);
    if (prev === undefined || isLater(row, prev)) {
      latest.set(gsis, row.gsis_id === gsis ? row : { ...row, gsis_id: gsis });
    }
  }
  const ids: Record<RosterIdPlatform, Map<string, NflRosterPlayer[]>> = {
    yahoo: new Map(),
    sleeper: new Map(),
    espn: new Map(),
  };
  const names = new Map<string, NflRosterPlayer[]>();
  for (const row of latest.values()) {
    const yahoo = cleanId(row.yahoo_id);
    const sleeper = cleanId(row.sleeper_id);
    const espn = cleanId(row.espn_id);
    if (yahoo !== null) pushTo(ids.yahoo, yahoo, row);
    if (sleeper !== null) pushTo(ids.sleeper, sleeper, row);
    if (espn !== null) pushTo(ids.espn, espn, row);
    const key = nameKey(row.full_name);
    if (key !== null) pushTo(names, key, row);
  }
  return Object.freeze({
    size: latest.size,
    byGsis: (gsisId: string) => latest.get(gsisId) ?? null,
    byPlatformId: (platform: RosterIdPlatform, id: string) => ids[platform].get(id) ?? EMPTY,
    byNameKey: (key: string) => names.get(key) ?? EMPTY,
  });
}

// --- results -------------------------------------------------------------------------------------

/** How one platform player resolved. */
export type CrosswalkResolution =
  | {
      readonly status: "matched";
      readonly pair: CrosswalkPair;
      readonly evidence: readonly MatchEvidence[];
      /** New, or different from the persisted pair in gsis_id/method/source/confidence. */
      readonly changed: boolean;
    }
  | {
      readonly status: "team_unit";
      readonly subject: Extract<ProjectionSubject, { kind: "defense" }>;
    }
  | { readonly status: "ambiguous"; readonly candidates: readonly MatchCandidate[] }
  | {
      readonly status: "unmatched";
      readonly reason: "no_candidate" | "name_only" | "unknown_team";
      readonly candidates: readonly MatchCandidate[];
    };

/** Something the run noticed that a human may need to look at (no third-party text inside). */
export interface CrosswalkDiagnostic {
  readonly code:
    | "override_vs_id"
    | "override_vs_persisted"
    | "id_vs_persisted"
    | "duplicate_gsis"
    | "hint_name_mismatch"
    | "hint_not_in_roster"
    | "ambiguous_platform_id"
    | "stale_override_pair"
    | "invalid_persisted_pair"
    | "invalid_override"
    | "duplicate_override"
    | "invalid_player_id"
    | "platform_mismatch"
    | "duplicate_player";
  readonly platform_player_id: string | null;
  /** The gsis ids involved, when any. */
  readonly gsis_ids: readonly string[];
}

/** The persisted-pair lookup the run reads (CrosswalkRepository satisfies it). */
export interface PersistedPairLookup {
  get(platform: PlatformId, platformPlayerId: string): CrosswalkPair | null;
}

/** Input to one crosswalk run over a platform's players. */
export interface CrosswalkRunInput {
  readonly platform: PlatformId;
  readonly players: readonly PlatformPlayer[];
  readonly roster: RosterIndex;
  readonly overrides: readonly CrosswalkOverride[];
  readonly persisted: PersistedPairLookup;
  /** The Clock instant stamped on new pairs. */
  readonly now: IsoInstant;
  /** Platform player ids on a fantasy roster; default: `ownership.type === "team"`. */
  readonly rostered?: ReadonlySet<string>;
  /** Default TOP_OWNED_PERCENT. */
  readonly topOwnedPercent?: number;
}

/** One player and its resolution. */
export interface ResolvedPlayer {
  readonly player: PlatformPlayer;
  readonly resolution: CrosswalkResolution;
}

/** A team defence resolved by its team. */
export interface ResolvedTeamUnit {
  readonly platform_player_id: string;
  readonly nfl_team: NflTeam;
}

/** The result of one run. */
export interface CrosswalkRun {
  readonly platform: PlatformId;
  /** Input order, first occurrence of each player id only. */
  readonly resolved: readonly ResolvedPlayer[];
  /** Every matched pair. */
  readonly pairs: readonly CrosswalkPair[];
  /** The pairs to hand to `CrosswalkRepository.upsertDelta` (new or changed). */
  readonly changed: readonly CrosswalkPair[];
  /** Player ids whose persisted pair was kept unchanged (for `CrosswalkRepository.touch`). */
  readonly unchanged_ids: readonly string[];
  readonly team_units: readonly ResolvedTeamUnit[];
  /** Team units whose team could not be resolved (never counted in `unmatched_rostered`). */
  readonly unresolved_team_units: readonly PlatformPlayer[];
  readonly report: UnmatchedReport;
  readonly diagnostics: readonly CrosswalkDiagnostic[];
}

// --- the run -------------------------------------------------------------------------------------

type Stage = "override" | "id" | "persisted" | "match";

interface Internal {
  readonly resolution: CrosswalkResolution;
  readonly stage: Stage | null;
  /** The accepted candidate, for a deterministic match. */
  readonly candidate: MatchCandidate | null;
}

interface Work {
  readonly player: PlatformPlayer;
  result: Internal;
}

interface Ctx {
  readonly platform: PlatformId;
  readonly roster: RosterIndex;
  readonly overrides: ReadonlyMap<string, CrosswalkOverride>;
  readonly persisted: PersistedPairLookup;
  readonly now: IsoInstant;
  readonly diag: (d: CrosswalkDiagnostic) => void;
}

/** Whether a platform player is a team unit (DEF/DST/D/ST, or a `manual.p.def-*` key). */
export function isTeamUnit(player: PlatformPlayer): boolean {
  const pos = typeof player.position === "string" ? player.position.trim().toUpperCase() : "";
  return TEAM_UNIT_POSITIONS.includes(pos) || teamFromManualDefKey(player.ref.id) !== null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function candidateOf(
  row: NflRosterPlayer,
  team: NflTeam | null,
  families: ReadonlySet<string>,
  jersey: number | null,
): MatchCandidate {
  const evidence: MatchEvidence[] = ["name"];
  if (team !== null && row.team === team) evidence.push("team");
  const fam = positionFamily(row.position);
  if (fam !== null && families.has(fam)) evidence.push("position");
  if (jersey !== null && row.jersey_number !== null && row.jersey_number === jersey) {
    evidence.push("jersey");
  }
  const score = round2(evidence.reduce((s, e) => s + EVIDENCE_WEIGHTS[e], 0));
  return {
    gsis_id: row.gsis_id,
    full_name: row.full_name,
    team: row.team,
    position: row.position,
    jersey_number: row.jersey_number,
    evidence,
    score,
  };
}

function topCandidates(list: readonly MatchCandidate[]): readonly MatchCandidate[] {
  return [...list]
    .sort((a, b) => b.score - a.score || (a.gsis_id < b.gsis_id ? -1 : 1))
    .slice(0, MAX_REPORTED_CANDIDATES);
}

function platformFamilies(player: PlatformPlayer): ReadonlySet<string> {
  const out = new Set<string>();
  const eligible: readonly unknown[] = Array.isArray(player.eligible_positions)
    ? (player.eligible_positions as readonly unknown[])
    : [];
  for (const p of [player.position, ...eligible]) {
    const fam = positionFamily(p);
    if (fam !== null) out.add(fam);
  }
  return out;
}

function validPersisted(
  pair: CrosswalkPair | null,
  platform: PlatformId,
  id: string,
  ctx: Ctx,
): CrosswalkPair | null {
  if (pair === null) return null;
  const ok =
    pair.platform === platform &&
    pair.platform_player_id === id &&
    typeof pair.gsis_id === "string" &&
    GSIS_ID_RE.test(pair.gsis_id) &&
    METHODS.includes(pair.method) &&
    SOURCES.includes(pair.source) &&
    Number.isFinite(pair.confidence) &&
    pair.confidence >= 0 &&
    pair.confidence <= 1 &&
    typeof pair.first_seen === "string" &&
    typeof pair.last_seen === "string";
  if (!ok) ctx.diag({ code: "invalid_persisted_pair", platform_player_id: id, gsis_ids: [] });
  return ok ? pair : null;
}

function makePair(
  ctx: Ctx,
  id: string,
  gsis: string,
  method: Exclude<CrosswalkMethod, "none">,
  source: CrosswalkSource,
  confidence: number,
  prev: CrosswalkPair | null,
): { pair: CrosswalkPair; changed: boolean } {
  const same = prev?.gsis_id === gsis;
  const pair: CrosswalkPair = {
    platform: ctx.platform,
    platform_player_id: id,
    gsis_id: gsis,
    method,
    source,
    confidence,
    first_seen: same ? prev.first_seen : ctx.now,
    last_seen: same ? prev.last_seen : ctx.now,
  };
  const changed =
    !same || prev.method !== method || prev.source !== source || prev.confidence !== confidence;
  return { pair, changed };
}

interface IdHit {
  readonly gsis: string;
  readonly source: CrosswalkSource;
}

function idEvidence(player: PlatformPlayer, ctx: Ctx): IdHit | null {
  const id = player.ref.id;
  const hint =
    cleanGsisId(player.gsis_hint) ?? (ctx.platform === "manual" ? gsisFromManualKey(id) : null);
  if (hint !== null) {
    const row = ctx.roster.byGsis(hint);
    if (row !== null) {
      if (nameKey(row.full_name) !== nameKey(player.name)) {
        ctx.diag({ code: "hint_name_mismatch", platform_player_id: id, gsis_ids: [hint] });
      }
      return { gsis: hint, source: "platform" };
    }
    if (ctx.roster.size === 0) return { gsis: hint, source: "platform" };
    ctx.diag({ code: "hint_not_in_roster", platform_player_id: id, gsis_ids: [hint] });
  }
  if (ctx.platform === "manual") return null;
  const native = nativePlayerId(ctx.platform, id);
  if (native === null) return null;
  const rows = ctx.roster.byPlatformId(ctx.platform, native);
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only !== undefined) return { gsis: only.gsis_id, source: "nflverse:roster_weekly" };
  if (rows.length > 1) {
    ctx.diag({
      code: "ambiguous_platform_id",
      platform_player_id: id,
      gsis_ids: rows.map((r) => r.gsis_id).sort(),
    });
  }
  return null;
}

function matched(
  ctx: Ctx,
  id: string,
  stage: Stage,
  gsis: string,
  method: Exclude<CrosswalkMethod, "none">,
  source: CrosswalkSource,
  confidence: number,
  prev: CrosswalkPair | null,
  evidence: readonly MatchEvidence[],
  candidate: MatchCandidate | null = null,
): Internal {
  const { pair, changed } = makePair(ctx, id, gsis, method, source, confidence, prev);
  return { resolution: { status: "matched", pair, evidence, changed }, stage, candidate };
}

function unmatched(
  reason: "no_candidate" | "name_only" | "unknown_team",
  candidates: readonly MatchCandidate[] = [],
): Internal {
  return { resolution: { status: "unmatched", reason, candidates }, stage: null, candidate: null };
}

function deterministic(
  player: PlatformPlayer,
  id: string,
  prev: CrosswalkPair | null,
  ctx: Ctx,
): Internal {
  const key = nameKey(player.name);
  if (key === null) return unmatched("no_candidate");
  const team = player.team_abbr === null ? null : normalizeTeam(player.team_abbr);
  if (player.team_abbr !== null && team === null) return unmatched("unknown_team");
  const named = ctx.roster.byNameKey(key);
  if (named.length === 0) return unmatched("no_candidate");
  const families = platformFamilies(player);
  const jersey =
    typeof player.uniform_number === "number" && Number.isInteger(player.uniform_number)
      ? player.uniform_number
      : null;
  const all = named.map((row) => candidateOf(row, team, families, jersey));
  const full = all.filter((c) => c.evidence.includes("team") && c.evidence.includes("position"));
  const accept = (c: MatchCandidate, confidence: number): Internal =>
    matched(
      ctx,
      id,
      "match",
      c.gsis_id,
      "match",
      "nflverse:roster_weekly",
      confidence,
      prev,
      c.evidence,
      c,
    );
  const [first] = full;
  if (first === undefined) return unmatched("name_only", topCandidates(all));
  if (full.length === 1) {
    const disagrees =
      jersey !== null && first.jersey_number !== null && first.jersey_number !== jersey;
    const confidence = first.evidence.includes("jersey")
      ? MATCH_CONFIDENCE.jerseyAgrees
      : disagrees
        ? MATCH_CONFIDENCE.jerseyDisagrees
        : MATCH_CONFIDENCE.nameTeamPosition;
    return accept(first, confidence);
  }
  const byJersey = full.filter((c) => c.evidence.includes("jersey"));
  const [tie] = byJersey;
  if (byJersey.length === 1 && tie !== undefined)
    return accept(tie, MATCH_CONFIDENCE.jerseyTieBreak);
  return {
    resolution: { status: "ambiguous", candidates: topCandidates(full) },
    stage: null,
    candidate: null,
  };
}

function resolveOne(player: PlatformPlayer, ctx: Ctx): Internal {
  const id = player.ref.id;
  if (isTeamUnit(player)) {
    const team = normalizeTeam(player.team_abbr) ?? teamFromManualDefKey(id);
    if (team === null) return unmatched("unknown_team");
    return {
      resolution: { status: "team_unit", subject: { kind: "defense", nfl_team: team } },
      stage: null,
      candidate: null,
    };
  }
  const canon = canonicalPlayerId(ctx.platform, id);
  if (canon === null) {
    ctx.diag({ code: "invalid_player_id", platform_player_id: null, gsis_ids: [] });
    return unmatched("no_candidate");
  }
  const prev = validPersisted(ctx.persisted.get(ctx.platform, id), ctx.platform, id, ctx);
  const hit = idEvidence(player, ctx);
  const override = ctx.overrides.get(canon);
  if (override !== undefined) {
    const gsis = override.gsis_id;
    if (hit !== null && hit.gsis !== gsis) {
      ctx.diag({ code: "override_vs_id", platform_player_id: id, gsis_ids: [gsis, hit.gsis] });
    }
    if (prev !== null && prev.gsis_id !== gsis) {
      ctx.diag({
        code: "override_vs_persisted",
        platform_player_id: id,
        gsis_ids: [gsis, prev.gsis_id],
      });
    }
    return matched(
      ctx,
      id,
      "override",
      gsis,
      "override",
      "overrides",
      MATCH_CONFIDENCE.exact,
      prev,
      ["id"],
    );
  }
  if (hit !== null) {
    if (prev !== null && prev.gsis_id !== hit.gsis) {
      ctx.diag({
        code: "id_vs_persisted",
        platform_player_id: id,
        gsis_ids: [hit.gsis, prev.gsis_id],
      });
    }
    return matched(ctx, id, "id", hit.gsis, "id", hit.source, MATCH_CONFIDENCE.exact, prev, ["id"]);
  }
  if (prev !== null && prev.method !== "override") {
    return {
      resolution: {
        status: "matched",
        pair: prev,
        evidence: prev.method === "id" ? ["id"] : ["name", "team", "position"],
        changed: false,
      },
      stage: "persisted",
      candidate: null,
    };
  }
  if (prev !== null) {
    ctx.diag({ code: "stale_override_pair", platform_player_id: id, gsis_ids: [prev.gsis_id] });
  }
  return deterministic(player, id, prev, ctx);
}

function indexOverrides(
  platform: PlatformId,
  overrides: readonly CrosswalkOverride[],
  diag: (d: CrosswalkDiagnostic) => void,
): ReadonlyMap<string, CrosswalkOverride> {
  const out = new Map<string, CrosswalkOverride>();
  for (const o of overrides) {
    if (o.platform !== platform) continue;
    const canon = canonicalPlayerId(platform, o.platform_player_id);
    if (canon === null || typeof o.gsis_id !== "string" || !GSIS_ID_RE.test(o.gsis_id)) {
      diag({ code: "invalid_override", platform_player_id: null, gsis_ids: [] });
      continue;
    }
    if (out.has(canon)) {
      diag({
        code: "duplicate_override",
        platform_player_id: o.platform_player_id,
        gsis_ids: [o.gsis_id],
      });
      continue;
    }
    out.set(canon, o);
  }
  return out;
}

/**
 * A new deterministic match may not take a gsis id another player in the same run also holds:
 * it is demoted to ambiguous (never two platform keys silently sharing one NFL player). Any
 * remaining shared claim (two overrides, two persisted pairs) is kept and reported.
 */
function enforceUniqueGsis(work: Work[], diag: (d: CrosswalkDiagnostic) => void): void {
  const claims = new Map<string, Work[]>();
  for (const w of work) {
    if (w.result.resolution.status === "matched")
      pushTo(claims, w.result.resolution.pair.gsis_id, w);
  }
  for (const [gsis, claimants] of claims) {
    if (claimants.length < 2) continue;
    const keep: Work[] = [];
    for (const w of claimants) {
      const r = w.result;
      if (r.stage === "match" && r.candidate !== null) {
        w.result = {
          resolution: { status: "ambiguous", candidates: [r.candidate] },
          stage: null,
          candidate: null,
        };
      } else keep.push(w);
    }
    if (keep.length > 1) {
      for (const w of keep) {
        diag({ code: "duplicate_gsis", platform_player_id: w.player.ref.id, gsis_ids: [gsis] });
      }
    }
  }
}

/**
 * Resolves every player of one platform (pure; the caller persists `changed` via
 * `CrosswalkRepository.upsertDelta` and refreshes `unchanged_ids` via `touch`).
 */
export function resolveCrosswalk(input: CrosswalkRunInput): CrosswalkRun {
  if (typeof input.now !== "string" || input.now.length === 0) {
    throw new TypeError("crosswalk: `now` must be an ISO instant");
  }
  const diagnostics: CrosswalkDiagnostic[] = [];
  const diag = (d: CrosswalkDiagnostic): void => {
    diagnostics.push(d);
  };
  const ctx: Ctx = {
    platform: input.platform,
    roster: input.roster,
    overrides: indexOverrides(input.platform, input.overrides, diag),
    persisted: input.persisted,
    now: input.now,
    diag,
  };
  const players: PlatformPlayer[] = [];
  const seen = new Set<string>();
  for (const p of input.players) {
    if (p.ref.platform !== input.platform) {
      diag({ code: "platform_mismatch", platform_player_id: null, gsis_ids: [] });
      continue;
    }
    if (seen.has(p.ref.id)) {
      diag({ code: "duplicate_player", platform_player_id: null, gsis_ids: [] });
      continue;
    }
    seen.add(p.ref.id);
    players.push(p);
  }
  const work: Work[] = players.map((player) => ({ player, result: resolveOne(player, ctx) }));
  enforceUniqueGsis(work, diag);

  const threshold = input.topOwnedPercent ?? TOP_OWNED_PERCENT;
  const isRostered = (p: PlatformPlayer): boolean =>
    input.rostered !== undefined ? input.rostered.has(p.ref.id) : p.ownership?.type === "team";

  const resolved: ResolvedPlayer[] = [];
  const pairs: CrosswalkPair[] = [];
  const changed: CrosswalkPair[] = [];
  const unchanged: string[] = [];
  const teamUnits: ResolvedTeamUnit[] = [];
  const unresolvedUnits: PlatformPlayer[] = [];
  const rosteredOut: UnmatchedPlayer[] = [];
  const topOut: UnmatchedPlayer[] = [];
  let matchedCount = 0;

  work.forEach(({ player, result }) => {
    const { resolution } = result;
    resolved.push({ player, resolution });
    if (resolution.status === "matched") {
      matchedCount += 1;
      pairs.push(resolution.pair);
      if (resolution.changed) changed.push(resolution.pair);
      else unchanged.push(player.ref.id);
      return;
    }
    if (resolution.status === "team_unit") {
      teamUnits.push({ platform_player_id: player.ref.id, nfl_team: resolution.subject.nfl_team });
      return;
    }
    if (isTeamUnit(player)) {
      unresolvedUnits.push(player);
      return;
    }
    const entry: UnmatchedPlayer = {
      player,
      reason: resolution.status === "ambiguous" ? "ambiguous" : resolution.reason,
      candidates: resolution.candidates,
    };
    if (isRostered(player)) rosteredOut.push(entry);
    else if (typeof player.percent_owned === "number" && player.percent_owned >= threshold) {
      topOut.push(entry);
    }
  });

  const byId = (a: UnmatchedPlayer, b: UnmatchedPlayer): number =>
    a.player.ref.id < b.player.ref.id ? -1 : a.player.ref.id > b.player.ref.id ? 1 : 0;
  return {
    platform: input.platform,
    resolved,
    pairs,
    changed,
    unchanged_ids: unchanged,
    team_units: teamUnits,
    unresolved_team_units: unresolvedUnits,
    report: {
      matched: matchedCount,
      unmatched_rostered: rosteredOut.sort(byId),
      unmatched_top_owned: topOut.sort(byId),
    },
    diagnostics,
  };
}

/** The `crosswalk` block a tool shows (plan 07 C1). A resolved team unit is exact by its team. */
export function crosswalkStatus(resolution: CrosswalkResolution): CrosswalkStatus {
  if (resolution.status === "matched") {
    return { method: resolution.pair.method, confidence: resolution.pair.confidence };
  }
  if (resolution.status === "team_unit")
    return { method: "id", confidence: MATCH_CONFIDENCE.exact };
  return { method: "none", confidence: 0 };
}

/** The projection subject a resolution identifies, or null when unresolved. */
export function subjectOf(resolution: CrosswalkResolution): ProjectionSubject | null {
  if (resolution.status === "matched") return { kind: "player", gsis_id: resolution.pair.gsis_id };
  return resolution.status === "team_unit" ? resolution.subject : null;
}
