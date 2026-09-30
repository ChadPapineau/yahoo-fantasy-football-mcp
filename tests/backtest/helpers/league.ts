// league.ts — the fixture league (fixtures/manual/league.yaml through ManualLeagueProvider, fixture
// mode) turned into analytics inputs: projection targets, lineup players, the K/DEF universe, and
// realised league-scored points per subject-week from the fixture stat lines (the backtests' truth).
import { NFL_TEAMS, isNflTeam, type NflTeam } from "../../../src/config/schema.js";
import type {
  KdefCandidateInput,
  LineupPlayer,
  ProjectionOutcome,
  ProjectionTarget,
} from "../../../src/domain/analytics/index.js";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import {
  manualPlayerKeyFor,
  type LeagueRef,
  type RosterEntry,
  type RosterSlots,
  type TeamRef,
  type Week,
} from "../../../src/domain/league/types.js";
import { score } from "../../../src/domain/scoring/engine.js";
import type { ProjectionSubject, ScoringSettings } from "../../../src/domain/scoring/types.js";
import { ManualLeagueProvider } from "../../../src/providers/manual/index.js";
import { type FixtureData, LEAGUE_FILE, rosterGsisByName } from "./fixture.js";

export const LEAGUE: LeagueRef = { platform: "manual", league_key: "manual.l.example" };
export const TEAM_A: TeamRef = { ...LEAGUE, team_key: "manual.l.example.t.1" };
export const TEAM_B: TeamRef = { ...LEAGUE, team_key: "manual.l.example.t.2" };

/** The fixture league's settings, slots and a provider over a test clock. */
export interface FixtureLeague {
  readonly provider: ManualLeagueProvider;
  readonly clock: FixedClock;
  readonly settings: ScoringSettings;
  readonly slots: RosterSlots;
}

export async function fixtureLeague(): Promise<FixtureLeague> {
  const clock = fixedClock("2026-09-01T12:00:00Z");
  const provider = new ManualLeagueProvider({ file: LEAGUE_FILE, clock, requirePrivate: false });
  const settings = (await provider.getScoringSettings(LEAGUE)).value;
  const slots = (await provider.getRosterSlots(LEAGUE)).value;
  return { provider, clock, settings, slots };
}

/** One day before the week's first kickoff (nothing locked yet). */
export function beforeWeek(data: FixtureData, week: Week): number {
  const ks = data.games
    .filter((g) => g.season === 2026 && g.week === week && g.kickoff !== null)
    .map((g) => Date.parse(g.kickoff ?? ""));
  return Math.min(...ks) - 24 * 3600 * 1000;
}

const byName = rosterGsisByName();

/** The projection subject of a roster entry (a defence by its team; a player by gsis id). */
export function subjectOf(e: RosterEntry): ProjectionSubject {
  const team = e.player.team_abbr ?? "";
  if (e.player.position === "DEF") {
    if (!isNflTeam(team)) throw new Error(`fixture: unknown defence ${team}`);
    return { kind: "defense", nfl_team: team };
  }
  const gsis =
    e.player.gsis_hint ?? byName.get(`${e.player.name}|${team}|${e.player.position}`) ?? null;
  if (gsis === null) throw new Error(`fixture: no gsis id for ${e.player.name}`);
  return { kind: "player", gsis_id: gsis };
}

export function targetsFor(entries: readonly RosterEntry[]): ProjectionTarget[] {
  return entries.map((e) => {
    const team = e.player.team_abbr ?? "";
    return {
      player_key: e.player.ref.id,
      subject: subjectOf(e),
      name: e.player.name,
      position: e.player.position,
      nfl_team: isNflTeam(team) ? team : null,
      platform_status: e.player.status,
    };
  });
}

/** Lineup players from roster entries + their projections (same order). */
export function lineupPlayersFor(
  entries: readonly RosterEntry[],
  out: ProjectionOutcome,
  week: Week,
): LineupPlayer[] {
  return entries.map((e, i) => {
    const p = out.players[i];
    const w = p?.weeks.find((x) => x.week === week);
    if (p === undefined || w === undefined) throw new Error("fixture: projection missing");
    const subject = subjectOf(e);
    return {
      player_key: e.player.ref.id,
      name: e.player.name,
      positions: [e.player.position],
      status: e.player.status,
      nfl_team: w.team,
      gsis_id: subject.kind === "player" ? subject.gsis_id : null,
      slot: e.slot,
      lock_at: w.kickoff_ms === null ? null : new Date(w.kickoff_ms).toISOString(),
      points: w.dist,
      p_active: w.p_active,
      role_games: p.role_games,
    };
  });
}

/** Realised league points of a subject in a week (0 when it recorded no line — inactive/bye). */
export function realised(
  data: FixtureData,
  settings: ScoringSettings,
  subject: ProjectionSubject,
  week: Week,
): number {
  if (subject.kind === "defense") {
    const d = data.defense.find(
      (x) => x.season === 2026 && x.week === week && x.nfl_team === subject.nfl_team,
    );
    return d === undefined ? 0 : score(d.line, settings).points;
  }
  const l = data.lines.find(
    (x) => x.season === 2026 && x.week === week && x.gsis_id === subject.gsis_id,
  );
  return l === undefined ? 0 : score(l.line, settings).points;
}

/** The K/DEF universe: all 32 defences + every kicker in the fixture stats (latest team). */
export function kdefUniverse(data: FixtureData): KdefCandidateInput[] {
  const kickers = new Map<string, NflTeam>();
  for (const l of [...data.lines].sort((a, b) => a.week - b.week)) {
    if (l.position === "K") kickers.set(l.gsis_id, l.nfl_team);
  }
  return [
    ...NFL_TEAMS.map((t) => ({
      player_key: manualPlayerKeyFor({ kind: "defense", nfl_team: t }),
      subject: { kind: "defense" as const, nfl_team: t },
      name: t,
      position: "DEF" as const,
      nfl_team: t,
      availability: "unknown" as const,
    })),
    ...[...kickers].sort().map(([id, team]) => ({
      player_key: manualPlayerKeyFor({ kind: "player", gsis_id: id }),
      subject: { kind: "player" as const, gsis_id: id },
      name: id,
      position: "K" as const,
      nfl_team: team,
      availability: "unknown" as const,
    })),
  ];
}
