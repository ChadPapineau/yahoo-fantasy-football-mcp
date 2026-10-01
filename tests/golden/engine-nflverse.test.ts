// engine-nflverse.test.ts — plan 10 A1a (plan 08 §6 step 1, §3.2): `toStatLine(nflverse)` over the
// fixture excerpt (fixtures/nflverse, 2026 weeks 1–3, every player-week and every team defence),
// scored under the fixture league's settings (fixtures/manual/league.yaml through the real
// ManualLeagueProvider): no NaN, `complete = true` on final weeks, and the frozen outputs in
// fixtures/golden/nflverse/points-2026-w1-3.json. The lines come through the PRODUCTION path — the
// fixture parquet published by the real runner + publisher, read back through the store's readers —
// and are cross-checked against (a) the domain translator and the sources translator on the raw
// parquet rows (the three `toStatLine` copies may never drift apart), (b) the analytics backtest
// helper's in-memory readers, and (c) independent oracles: nflverse's own fantasy_points columns
// for offence, and hand-written kicker / team-defence formulas. Regenerate the frozen file with
// UPDATE_GOLDEN=1 (and review the diff); a missing file fails.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NFL_TEAMS, type NflTeam } from "../../src/config/schema.js";
import type { PlayerWeekLine, TeamDefenseWeekLine } from "../../src/domain/analytics/types.js";
import { score } from "../../src/domain/scoring/engine.js";
import { makeStatLine, statLineFromPlayerWeek } from "../../src/domain/scoring/nflverse.js";
import type { ScoringSettings, StatLine } from "../../src/domain/scoring/types.js";
import { toStatLine } from "../../src/sources/nflverse/columns.js";
import { playerRowToStatLine } from "../../src/store/datasets/statline.js";
import { loadFixtureData } from "../backtest/helpers/fixture.js";
import { ROOT, makeWorld, type World } from "../mcp/helpers/env.js";

const SEASON = 2026;
const WEEKS = [1, 2, 3] as const;
const GOLDEN = path.join(ROOT, "fixtures", "golden", "nflverse", "points-2026-w1-3.json");
const LEAGUE = { platform: "manual", league_key: "manual.l.example" } as const;
/** Tolerance between two computations of the same total (float noise only). */
const EPS = 1e-9;

type Row = Readonly<Record<string, unknown>>;

let world: World;
let settings: ScoringSettings;
let raw: Row[];
let lines: PlayerWeekLine[];
let defense: TeamDefenseWeekLine[];
const finalByTeamWeek = new Map<string, boolean>();
/** `week|team` → the points that team allowed (the opponent's final score, from ds_games). */
const allowedByTeamWeek = new Map<string, number>();

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const keyOf = (week: number, id: string) => `${String(week)}|${id}`;
const pts = (line: StatLine) => score(line, settings).points;

beforeAll(async () => {
  world = await makeWorld();
  settings = (await world.services.platform.getScoringSettings(LEAGUE)).value;
  const buf = readFileSync(
    path.join(ROOT, "fixtures", "nflverse", "stats_player", "stats_player_week_2026.parquet"),
  );
  raw = (await parquetReadObjects({
    file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  })) as Row[];
  const ids = [
    ...new Set(raw.map((r) => r.player_id).filter((x): x is string => typeof x === "string")),
  ];
  const r = world.store.datasets.playerWeeks.lines(ids, SEASON, [...WEEKS]);
  lines = [...r.rows];
  defense = [
    ...world.store.datasets.playerWeeks.defenseLines([...NFL_TEAMS], SEASON, [...WEEKS]).rows,
  ];
  for (const g of world.store.datasets.schedules.games(SEASON, [...WEEKS]).rows) {
    finalByTeamWeek.set(`${String(g.week)}|${g.away}`, g.is_final);
    finalByTeamWeek.set(`${String(g.week)}|${g.home}`, g.is_final);
    if (g.score !== null) {
      allowedByTeamWeek.set(`${String(g.week)}|${g.away}`, g.score.home);
      allowedByTeamWeek.set(`${String(g.week)}|${g.home}`, g.score.away);
    }
  }
}, 60_000);
afterAll(() => {
  world.cleanup();
});

describe("A1a: every fixture player-week scores under the fixture league", () => {
  it("the store serves a line for every player-week of the excerpt (weeks 1–3)", () => {
    const expected = raw.filter((r) => typeof r.player_id === "string").length;
    expect(expected).toBeGreaterThan(3000);
    expect(lines).toHaveLength(expected);
    expect(new Set(lines.map((l) => keyOf(l.week, l.gsis_id))).size).toBe(expected);
    expect(new Set(lines.map((l) => l.week))).toEqual(new Set(WEEKS));
  });

  it("no NaN anywhere, and complete = true on final weeks (provisional derived from ds_games)", () => {
    let final = 0;
    for (const l of lines) {
      const isFinal = finalByTeamWeek.get(`${String(l.week)}|${l.nfl_team}`);
      expect(isFinal, `${l.gsis_id} w${String(l.week)} has a game`).toBeDefined();
      const line = makeStatLine(l.line.values, l.line.position_type, { provisional: !isFinal });
      const s = score(line, settings);
      expect(Number.isFinite(s.points), `${l.gsis_id} w${String(l.week)}`).toBe(true);
      expect(Number.isFinite(s.points_exact)).toBe(true);
      for (const c of s.contributions) expect(Number.isFinite(c.points)).toBe(true);
      if (isFinal === true) {
        final++;
        expect(s.complete, `${l.gsis_id} w${String(l.week)}`).toBe(true);
      }
    }
    expect(final).toBe(lines.length); // weeks 1–3 of 2026 are all final in the excerpt
  });

  it("every team defence (32 × 3) scores, with points allowed from the final score", () => {
    expect(defense).toHaveLength(NFL_TEAMS.length * WEEKS.length);
    for (const d of defense) {
      const s = score(d.line, settings);
      expect(Number.isFinite(s.points)).toBe(true);
      expect(s.complete).toBe(true);
      expect(d.line.values.dst_pa, `${d.nfl_team} w${String(d.week)}`).toBeTypeOf("number");
      expect(d.line.values.dst_ya).toBeTypeOf("number");
    }
  });

  it("the frozen outputs match fixtures/golden/nflverse/points-2026-w1-3.json", () => {
    const players: Record<string, number> = {};
    for (const l of [...lines].sort((a, b) =>
      keyOf(a.week, a.gsis_id).localeCompare(keyOf(b.week, b.gsis_id)),
    ))
      players[keyOf(l.week, l.gsis_id)] = Number(pts(l.line).toFixed(6));
    const defences: Record<string, number> = {};
    for (const d of [...defense].sort((a, b) =>
      keyOf(a.week, a.nfl_team).localeCompare(keyOf(b.week, b.nfl_team)),
    ))
      defences[keyOf(d.week, d.nfl_team)] = Number(pts(d.line).toFixed(6));
    const actual = {
      $comment:
        "Frozen A1a outputs (plan 10 §3.1a; plan 08 §6 step 1): fantasy points per `week|gsis_id` and per `week|team` defence, 2026 weeks 1–3 of fixtures/nflverse, under fixtures/manual/league.yaml (half-PPR, Yahoo defaults). Generated by tests/golden/engine-nflverse.test.ts with UPDATE_GOLDEN=1; review any diff by hand.",
      settings_hash: settings.settings_hash,
      players,
      defences,
    };
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN), "run with UPDATE_GOLDEN=1 once, then review").toBe(true);
    const frozen = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof actual;
    expect(frozen.settings_hash).toBe(actual.settings_hash);
    expect(frozen.players).toEqual(actual.players);
    expect(frozen.defences).toEqual(actual.defences);
  });
});

describe("the three toStatLine(nflverse) copies score identically on every fixture row", () => {
  it("store (playerRowToStatLine) = domain (statLineFromPlayerWeek) = sources (toStatLine)", () => {
    const byKey = new Map(lines.map((l) => [keyOf(l.week, l.gsis_id), l]));
    let compared = 0;
    for (const r of raw) {
      if (typeof r.player_id !== "string") continue;
      const store = byKey.get(keyOf(Number(r.week), r.player_id));
      expect(store).toBeDefined();
      if (store === undefined) continue;
      const pt = store.line.position_type;
      // each translation computed ONCE per row (it was recomputed per scoring rule — ~2 × rules
      // extra translations per row, which pushed this test past 5 s under a loaded coverage run)
      const domainLine = statLineFromPlayerWeek(r, { positionType: pt });
      const sourcesLine = toStatLine(r, { positionType: pt });
      const viaStore = pts(playerRowToStatLine(r));
      const viaDomain = pts(domainLine);
      const viaSources = pts(sourcesLine);
      expect(Math.abs(viaStore - pts(store.line)), r.player_id).toBeLessThan(EPS);
      expect(Math.abs(viaDomain - viaStore), `domain ${r.player_id}`).toBeLessThan(EPS);
      expect(Math.abs(viaSources - viaStore), `sources ${r.player_id}`).toBeLessThan(EPS);
      // the canonical values each copy emits for the line's position type agree too
      for (const rule of settings.rules) {
        if (rule.canonical === null || !rule.position_types.includes(pt)) continue;
        const c = rule.canonical;
        const a = store.line.values[c];
        expect(sourcesLine.values[c], `${c} ${r.player_id}`).toBe(a);
        expect(domainLine.values[c], `${c} ${r.player_id}`).toBe(a);
      }
      compared++;
    }
    expect(compared).toBe(lines.length);
  });

  it("the store readers equal the analytics backtest helper (O/K lines and every DT line)", async () => {
    const fx = await loadFixtureData();
    const storeByKey = new Map(lines.map((l) => [keyOf(l.week, l.gsis_id), l]));
    const fxLines = fx.lines.filter((l) => l.season === SEASON && WEEKS.includes(l.week as 1));
    expect(fxLines.length).toBeGreaterThan(1000);
    for (const l of fxLines) {
      const s = storeByKey.get(keyOf(l.week, l.gsis_id));
      expect(s, l.gsis_id).toBeDefined();
      expect(s?.nfl_team).toBe(l.nfl_team);
      expect(s?.opponent).toBe(l.opponent);
      expect(Math.abs(pts(l.line) - (s === undefined ? NaN : pts(s.line)))).toBeLessThan(EPS);
    }
    const storeDef = new Map(defense.map((d) => [keyOf(d.week, d.nfl_team), d]));
    const fxDef = fx.defense.filter((d) => d.season === SEASON);
    expect(fxDef).toHaveLength(defense.length);
    for (const d of fxDef) {
      const s = storeDef.get(keyOf(d.week, d.nfl_team));
      expect(s?.opponent).toBe(d.opponent);
      expect(s?.line.values).toEqual(d.line.values);
    }
  });
});

describe("independent oracles (hand-written scoring rules)", () => {
  it("offence: engine = nflverse (fantasy_points + fantasy_points_ppr) / 2 + interceptions", () => {
    // nflverse's own columns use Yahoo's defaults with −2 per interception; the fixture league is
    // half-PPR with −1 per interception (fixtures/manual/league.yaml). So half-PPR(league) =
    // (standard + PPR) / 2 + 1 × passing_interceptions.
    let n = 0;
    for (const l of lines) {
      if (l.line.position_type !== "O") continue;
      const r = raw.find((x) => x.player_id === l.gsis_id && Number(x.week) === l.week);
      if (r?.fantasy_points == null || r.fantasy_points_ppr == null) continue;
      const oracle =
        (num(r.fantasy_points) + num(r.fantasy_points_ppr)) / 2 + num(r.passing_interceptions);
      expect(Math.abs(pts(l.line) - oracle), `${l.gsis_id} w${String(l.week)}`).toBeLessThan(0.01);
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("kickers: 3 per FG to 39 yds, 4 for 40–49, 5 for 50+, 1 per PAT, misses free", () => {
    let n = 0;
    for (const l of lines) {
      if (l.line.position_type !== "K") continue;
      const r = raw.find((x) => x.player_id === l.gsis_id && Number(x.week) === l.week);
      if (r === undefined) continue;
      const oracle =
        3 * (num(r.fg_made_0_19) + num(r.fg_made_20_29) + num(r.fg_made_30_39)) +
        4 * num(r.fg_made_40_49) +
        5 * (num(r.fg_made_50_59) + num(r.fg_made_60_)) +
        num(r.pat_made);
      expect(pts(l.line), `${l.gsis_id} w${String(l.week)}`).toBeCloseTo(oracle, 9);
      n++;
    }
    expect(n).toBeGreaterThan(80);
  });

  it("team defences, from the RAW player rows: sack 1, INT 2, fumble rec 2, every defensive TD 6, safety 2, block 2, return TD 6 + the PA bin", () => {
    // Independent of the line's own values (an oracle over `d.line.values` cannot see a wrong column
    // map — QA-1-017). Summed here straight from the parquet rows (team-level rows included): a
    // defensive TD is an interception return (`def_tds`) OR a fumble return — nflverse books the
    // latter as `fumble_recovery_tds` on a player who recovered the OPPONENT's fumble.
    const paBin = (pa: number): number =>
      pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4;
    const byTeamWeek = new Map<string, number>();
    for (const r of raw) {
      const k = `${String(Number(r.week))}|${String(r.team)}`;
      const fumbleReturnTds =
        num(r.fumble_recovery_opp) > 0
          ? Math.min(num(r.fumble_recovery_tds), num(r.fumble_recovery_opp))
          : 0;
      const p =
        num(r.def_sacks) +
        2 * num(r.def_interceptions) +
        2 * num(r.fumble_recovery_opp) +
        6 * (num(r.def_tds) + fumbleReturnTds) +
        2 * num(r.def_safeties) +
        2 * (num(r.def_fg_blocks) + num(r.def_punt_blocks)) +
        6 * num(r.special_teams_tds);
      byTeamWeek.set(k, (byTeamWeek.get(k) ?? 0) + p);
    }
    expect(defense).toHaveLength(NFL_TEAMS.length * WEEKS.length);
    for (const d of defense) {
      const k = `${String(d.week)}|${d.nfl_team}`;
      const allowed = allowedByTeamWeek.get(k);
      expect(allowed, k).toBeTypeOf("number");
      const oracle = (byTeamWeek.get(k) ?? 0) + paBin(num(allowed));
      expect(pts(d.line), `${d.nfl_team} w${String(d.week)}`).toBeCloseTo(oracle, 9);
    }
  });

  it("[A-1] nflverse keeps fumble-return TDs out of def_tds, and the excerpt has some (QA-1-017)", () => {
    // The dst_td = def_tds + fumble-return-TD sum double-counts if nflverse ever books a fumble
    // return in def_tds too: every fixture row with a fumble-recovery TD must have def_tds = 0, and
    // every def_tds row an interception. The excerpt must keep exercising the case.
    const fumbleTdRows = raw.filter((r) => num(r.fumble_recovery_tds) > 0);
    expect(fumbleTdRows.length).toBeGreaterThanOrEqual(2);
    for (const r of fumbleTdRows) {
      expect(num(r.def_tds), String(r.player_id)).toBe(0);
      expect(num(r.fumble_recovery_opp), String(r.player_id)).toBeGreaterThan(0);
    }
    for (const r of raw.filter((x) => num(x.def_tds) > 0))
      expect(num(r.def_interceptions), String(r.player_id)).toBeGreaterThanOrEqual(num(r.def_tds));
    const cin = defense.find((d) => d.week === 1 && d.nfl_team === "CIN");
    const ne = defense.find((d) => d.week === 2 && d.nfl_team === "NE");
    expect(cin?.line.values.dst_td).toBe(1);
    expect(ne?.line.values.dst_td).toBe(1);
  });

  it("the hand-reviewed sample matches the frozen file (numbers worked by hand)", () => {
    // Worked by hand from the raw 2026 rows under the fixture league (half-PPR, Yahoo defaults):
    //  Josh Allen (00-0034857) w1: 334 pass yds × 0.04 = 13.36; 2 pass TD × 4 = 8; 23 rush yds ×
    //    0.1 = 2.3; 2 rush TD × 6 = 12; no INT / fumble / 2-pt                          → 35.66
    //  Ja'Marr Chase (00-0036900) w1: 2 rec × 0.5 = 1; 12 rec yds × 0.1 = 1.2            → 2.2
    //  Harrison Butker (00-0033303) w2: FG 20–29 + FG 30–39 = 3 + 3; 2 × FG 40–49 = 8; 3 PAT
    //    = 3; one miss costs nothing                                                       → 17
    //  BUF defence w2: 4 sacks = 4; the team safety (a player_id-less nflverse row) = 2; DET
    //    scored 31 → the 28–34 bin = −1                                                    → 5
    //  CIN defence w1 (QA-1-017): 4 sacks = 4; 4 opponent fumble recoveries × 2 = 8; one returned
    //    27 yds for a TD (Demetrius Knight Jr.; nflverse fumble_recovery_tds 1, def_tds 0) = 6;
    //    27 points allowed → the 21–27 bin = 0                                             → 18
    //  NE defence w2 (QA-1-017): 4 sacks = 4; 1 INT × 2 = 2; 1 fumble recovery × 2 = 2, returned
    //    19 yds for a TD (Elijah Ponder) = 6; 3 points allowed → the 1–6 bin = 7          → 21
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
      players: Record<string, number>;
      defences: Record<string, number>;
    };
    expect(golden.players["1|00-0034857"]).toBe(35.66);
    expect(golden.players["1|00-0036900"]).toBe(2.2);
    expect(golden.players["2|00-0033303"]).toBe(17);
    expect(golden.defences["2|BUF"]).toBe(5);
    expect(golden.defences["1|CIN"]).toBe(18);
    expect(golden.defences["2|NE"]).toBe(21);
  });
});

describe("hostile inputs never reach the total as NaN", () => {
  it("a row with NaN / ±Infinity / strings in stat columns scores finitely (or is refused)", () => {
    const base = raw.find((r) => r.position === "QB");
    expect(base).toBeDefined();
    for (const bad of [NaN, Infinity, -Infinity, "12", "", null, 1e300, -0]) {
      const row = { ...base, passing_yards: bad, rushing_tds: bad };
      let total: number | null = null;
      try {
        total = pts(playerRowToStatLine(row));
      } catch {
        total = null; // refused (invalid_line) is acceptable; NaN is not
      }
      if (total !== null) expect(Number.isFinite(total)).toBe(true);
    }
  });

  it("unknown teams never appear in the defence lines", () => {
    const teams = new Set<NflTeam>(NFL_TEAMS);
    for (const d of defense) expect(teams.has(d.nfl_team)).toBe(true);
  });
});
