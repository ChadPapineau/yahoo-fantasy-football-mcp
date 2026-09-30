// helpers.ts — builders for the crosswalk tests over the shared fixture roster (fixtures/players).
import { readFileSync } from "node:fs";
import type { NflTeam } from "../../../src/config/schema.js";
import type { PersistedPairLookup } from "../../../src/domain/crosswalk/matcher.js";
import type { CrosswalkPair, NflRosterPlayer } from "../../../src/domain/crosswalk/types.js";
import type { PlatformId, PlatformPlayer } from "../../../src/domain/league/types.js";

/** One player row of fixtures/players/fixture-roster.json. */
export interface FixturePlayer {
  readonly kind: "player";
  readonly gsis_id: string;
  readonly name: string;
  readonly position: string;
  readonly team: NflTeam;
  readonly jersey: number | null;
  readonly yahoo_id: string | null;
  readonly sleeper_id: string | null;
  readonly espn_id: string | null;
  readonly pfr_id: string | null;
  readonly team_2025: string | null;
  readonly tags: readonly string[];
}

/** One defence row of the fixture roster. */
export interface FixtureDefense {
  readonly kind: "defense";
  readonly team: NflTeam;
  readonly name: string;
  readonly position: "DEF";
}

interface FixtureFile {
  readonly season: number;
  readonly players: readonly FixturePlayer[];
  readonly defenses: readonly FixtureDefense[];
}

export const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../fixtures/players/fixture-roster.json", import.meta.url), "utf8"),
) as FixtureFile;

export const NOW = "2026-09-30T12:00:00.000Z";
export const LATER = "2026-10-07T12:00:00.000Z";

/** The fixture player with this display name (throws when absent, so a typo fails loudly). */
export function fx(name: string): FixturePlayer {
  const p = FIXTURE.players.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no fixture player ${name}`);
  return p;
}

/** A roster_weekly row for a fixture player (week 4 of the fixture season), with edits. */
export function rosterRow(p: FixturePlayer, edit: Partial<NflRosterPlayer> = {}): NflRosterPlayer {
  return {
    gsis_id: p.gsis_id,
    season: FIXTURE.season,
    week: 4,
    full_name: p.name,
    team: p.team,
    position: p.position,
    jersey_number: p.jersey,
    yahoo_id: p.yahoo_id,
    sleeper_id: p.sleeper_id,
    espn_id: p.espn_id,
    pfr_id: p.pfr_id,
    status: "ACT",
    ...edit,
  };
}

/** A synthetic roster row (decoys: same names, other teams/positions). */
export function row(
  edit: Partial<NflRosterPlayer> & { gsis_id: string; full_name: string },
): NflRosterPlayer {
  return {
    season: FIXTURE.season,
    week: 4,
    team: "KC",
    position: "WR",
    jersey_number: null,
    yahoo_id: null,
    sleeper_id: null,
    espn_id: null,
    pfr_id: null,
    status: "ACT",
    ...edit,
  };
}

/** Every fixture player's roster row. */
export function fixtureRosterRows(): NflRosterPlayer[] {
  return FIXTURE.players.map((p) => rosterRow(p));
}

/** A platform player with neutral defaults (rostered on a fantasy team). */
export function pp(
  platform: PlatformId,
  id: string,
  edit: Partial<PlatformPlayer> = {},
): PlatformPlayer {
  return {
    ref: { platform, id },
    name: "Placeholder Player",
    team_abbr: null,
    position: "WR",
    eligible_positions: [],
    uniform_number: null,
    status: null,
    status_full: null,
    injury_note: null,
    bye_week: null,
    percent_owned: null,
    percent_owned_delta: null,
    ownership: {
      type: "team",
      owner_team_key: "461.l.1000.t.1",
      owner_name: "Team A",
      waiver_date: null,
    },
    gsis_hint: null,
    ...edit,
  };
}

/** Synthetic Yahoo player numbers for players nflverse carries no yahoo_id for. */
const NO_ID_BASE = 90000;

/** The Yahoo platform player for a fixture player, as Yahoo would spell it. */
export function yahooPlayer(p: FixturePlayer, edit: Partial<PlatformPlayer> = {}): PlatformPlayer {
  const idx = FIXTURE.players.indexOf(p);
  const num = p.yahoo_id ?? String(NO_ID_BASE + idx);
  return pp("yahoo", `461.p.${num}`, {
    name: p.name,
    team_abbr: YAHOO_SPELLING[p.team] ?? p.team,
    position: p.position,
    eligible_positions: [p.position],
    uniform_number: p.jersey,
    ...edit,
  });
}

/** How Yahoo spells some teams (research 04 §D: `Jax`, mixed case). */
export const YAHOO_SPELLING: Partial<Record<NflTeam, string>> = {
  ARI: "Ari",
  ATL: "Atl",
  BAL: "Bal",
  BUF: "Buf",
  CIN: "Cin",
  CLE: "Cle",
  DET: "Det",
  HOU: "Hou",
  IND: "Ind",
  JAX: "Jax",
  LA: "LAR",
  PIT: "Pit",
  SEA: "Sea",
  WAS: "Was",
};

/** An in-memory persisted-pair store (the CrosswalkRepository.get half). */
export class MemPairs implements PersistedPairLookup {
  private readonly map = new Map<string, CrosswalkPair>();
  constructor(pairs: readonly CrosswalkPair[] = []) {
    for (const p of pairs) this.put(p);
  }
  put(p: CrosswalkPair): void {
    this.map.set(`${p.platform}|${p.platform_player_id}`, p);
  }
  putAll(ps: readonly CrosswalkPair[]): void {
    for (const p of ps) this.put(p);
  }
  get(platform: PlatformId, id: string): CrosswalkPair | null {
    return this.map.get(`${platform}|${id}`) ?? null;
  }
}
