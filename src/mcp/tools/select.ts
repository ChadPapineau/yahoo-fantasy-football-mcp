// select.ts — resolves the plan 07 legend `PlayerSelector` (and E1's `pool`) to concrete subjects
// (plan 02 §5: never a key list over 25 — `team_key`, `nfl_team` and `pool` are the sanctioned ways
// past it), through the crosswalk (research 04 §D) so every row has a gsis id or a team defence.
import { isNflTeam, type NflTeam } from "../../config/schema.js";
import { PROJECTABLE_POSITIONS } from "../../domain/analytics/constants.js";
import {
  manualPlayerKeyFor,
  type PlatformPlayer,
  type RosterEntry,
  type Week,
} from "../../domain/league/types.js";
import type { ProjectionSubject } from "../../domain/scoring/types.js";
import { MANUAL_POOL_WARNING } from "../../providers/platform.js";
import type { ProjectionSelector } from "../bounds.js";
import type { ToolContext } from "../define.js";
import type { InputStamp } from "../envelope.js";
import { FfError } from "../errors.js";
import {
  crosswalkRun,
  leagueUniverse,
  nflTeamOf,
  optionalDataset,
  platformInput,
  rosterRows,
  subjectFromKey,
  teamOf,
  textSource,
  type LeagueContext,
} from "./common.js";

/** One resolved subject a tool reports on. */
export interface Target {
  readonly player_key: string | null;
  readonly subject: ProjectionSubject;
  /** Raw name (bare, path-listed with `name_source`). */
  readonly name: string;
  readonly name_source: string;
  readonly position: string;
  readonly nfl_team: NflTeam | null;
  readonly platform: PlatformPlayer | null;
  /** The roster entry, for `team_key` selections. */
  readonly entry: RosterEntry | null;
}

/** The most rows an `nfl_team` selection yields (fantasy positions only, then the defence). */
export const NFL_TEAM_SELECTION_MAX = 40;

const FANTASY_POSITIONS: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE", "K"]);

function fromPlatform(
  p: PlatformPlayer,
  subject: ProjectionSubject,
  nameSource: string,
  entry: RosterEntry | null,
): Target {
  return {
    player_key: p.ref.id,
    subject,
    name: p.name,
    name_source: nameSource,
    position: subject.kind === "defense" ? "DEF" : p.position,
    nfl_team: subject.kind === "defense" ? subject.nfl_team : nflTeamOf(p),
    platform: p,
    entry,
  };
}

function defenseTarget(team: NflTeam, platform: string): Target {
  const subject: ProjectionSubject = { kind: "defense", nfl_team: team };
  return {
    player_key: platform === "manual" ? manualPlayerKeyFor(subject) : null,
    subject,
    name: team,
    name_source: textSource(platform, "player.name"),
    position: "DEF",
    nfl_team: team,
    platform: null,
    entry: null,
  };
}

/** A roster's entries resolved to targets; unmatched players are counted in `warnings`. */
export async function rosterTargets(
  ctx: ToolContext,
  lc: LeagueContext,
  teamKey: string | undefined,
  week: Week,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Target[]> {
  const team = teamOf(lc, teamKey);
  const got = await ctx.services.platform.getRoster(team, week);
  inputs.push(platformInput(got.stamp, ctx.nowMs, lc.allowStale));
  const { byKey } = crosswalkRun(
    ctx,
    lc.league.season,
    got.value.entries.map((e) => e.player),
  );
  const nameSrc = textSource(lc.ref.platform, "player.name");
  const out: Target[] = [];
  let unmatched = 0;
  for (const e of got.value.entries) {
    const r = byKey.get(e.player.ref.id);
    if (r?.subject === null || r === undefined) {
      unmatched++;
      continue;
    }
    out.push(fromPlatform(e.player, r.subject, nameSrc, e));
  }
  if (unmatched > 0)
    warnings.push(
      `${String(unmatched)} rostered players are unmatched in the crosswalk and are omitted (ff_get_status lists them)`,
    );
  return out;
}

/** Resolves a PlayerSelector or pool (plan 07 legend; E1 `pool`) to targets. */
export async function selectTargets(
  ctx: ToolContext,
  lc: LeagueContext,
  selector: ProjectionSelector,
  week: Week,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Target[]> {
  const season = lc.league.season;
  const nameSrc = textSource(lc.ref.platform, "player.name");
  const rr = rosterRows(ctx, season);
  const rrIn = optionalDataset(rr, ctx.nowMs, lc.allowStale);
  if (rrIn !== null) inputs.push(rrIn);
  const byGsis = new Map(rr.rows.map((r) => [r.gsis_id, r]));
  const fromRosterRow = (gsis: string, key: string | null): Target | null => {
    const r = byGsis.get(gsis);
    if (r === undefined) return null;
    return {
      player_key: key,
      subject: { kind: "player", gsis_id: gsis },
      name: r.full_name,
      name_source: "nflverse.roster_weekly.name",
      position: r.position,
      nfl_team: r.team,
      platform: null,
      entry: null,
    };
  };
  let out: Target[] = [];
  let missing = 0;
  if ("team_key" in selector) {
    out = await rosterTargets(ctx, lc, selector.team_key, week, inputs, warnings);
    if (out.length === 0) throw new FfError("NOT_FOUND");
    return out;
  }
  if ("player_keys" in selector) {
    const universe = await leagueUniverse(ctx, lc, inputs);
    for (const key of selector.player_keys) {
      const u = universe.byKey.get(key);
      if (u?.subject !== null && u !== undefined) {
        out.push(fromPlatform(u.player, u.subject, nameSrc, null));
        continue;
      }
      const s = subjectFromKey(key);
      const t =
        s === null
          ? null
          : s.kind === "defense"
            ? defenseTarget(s.nfl_team, lc.ref.platform)
            : fromRosterRow(s.gsis_id, key);
      if (t === null) missing++;
      else out.push(t);
    }
  } else if ("gsis_ids" in selector) {
    const universe = await leagueUniverse(ctx, lc, inputs);
    const keyOf = new Map<string, PlatformPlayer>();
    for (const e of universe.byKey.values()) if (e.gsis_id !== null) keyOf.set(e.gsis_id, e.player);
    for (const g of selector.gsis_ids) {
      const p = keyOf.get(g);
      if (p !== undefined) {
        out.push(fromPlatform(p, { kind: "player", gsis_id: g }, nameSrc, null));
        continue;
      }
      const t = fromRosterRow(
        g,
        lc.ref.platform === "manual" ? manualPlayerKeyFor({ kind: "player", gsis_id: g }) : null,
      );
      if (t === null) missing++;
      else out.push(t);
    }
  } else if ("nfl_team" in selector) {
    const team = selector.nfl_team;
    const rows = rr.rows
      .filter((r) => r.team === team && FANTASY_POSITIONS.has(r.position))
      .sort((a, b) =>
        a.position === b.position
          ? a.full_name < b.full_name
            ? -1
            : 1
          : a.position < b.position
            ? -1
            : 1,
      )
      .slice(0, NFL_TEAM_SELECTION_MAX - 1);
    for (const r of rows) {
      const t = fromRosterRow(
        r.gsis_id,
        lc.ref.platform === "manual"
          ? manualPlayerKeyFor({ kind: "player", gsis_id: r.gsis_id })
          : null,
      );
      if (t !== null) out.push(t);
    }
    if (isNflTeam(team)) out.push(defenseTarget(team, lc.ref.platform));
  } else {
    const { status, position, top } = selector.pool;
    const got = await ctx.services.platform.listPlayers(
      lc.ref,
      { status, position, search: null, sort: null, sort_type: null, sort_week: null },
      { limit: top, offset: 0 },
    );
    inputs.push(platformInput(got.stamp, ctx.nowMs, lc.allowStale));
    if (lc.ref.platform === "manual" && position !== "K" && position !== "DEF")
      warnings.push(MANUAL_POOL_WARNING);
    const { byKey } = crosswalkRun(ctx, season, got.value.items);
    for (const p of got.value.items) {
      const r = byKey.get(p.ref.id);
      if (r?.subject === null || r === undefined) missing++;
      else out.push(fromPlatform(p, r.subject, nameSrc, null));
    }
  }
  if (missing > 0)
    warnings.push(`${String(missing)} selected players could not be resolved and are omitted`);
  if (out.length === 0) throw new FfError("NOT_FOUND");
  return out;
}

/** Whether the v1 projection can project a target's position. */
export function projectable(t: Target): boolean {
  return (PROJECTABLE_POSITIONS as readonly string[]).includes(t.position);
}
