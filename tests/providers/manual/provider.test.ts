// provider.test.ts — ManualLeagueProvider over the placeholder fixture league (plan 01 §8 X1;
// plan 10 §3.1a): the fixture loads and maps through every seam read, stamps (manual_league,
// as_of = mtime), missing features answer the contract's empty result, NOT_FOUND for foreign refs,
// schedule-derived byes/locks/current week, and the file-safety refusals (missing → NOT_FOUND
// hint; 0644, symlink, group-writable dir → INTERNAL hint).
import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANUAL_KEY_RE } from "../../../src/config/schema.js";
import { validateRoster } from "../../../src/domain/league/roster.js";
import {
  LEAGUE_FILE_INVALID_HINT,
  LeagueFileError,
  MANUAL_LEAGUE_MISSING_HINT,
  type LeagueRef,
  type PlayerQuery,
  type TeamRef,
} from "../../../src/providers/platform.js";
import { ManualLeagueProvider, ManualNotFoundError } from "../../../src/providers/manual/index.js";
import { game, WEEK1 } from "../../domain/league/fixtures.js";
import {
  clock,
  edit,
  FIXTURE_FILE,
  FIXTURE_TEXT,
  provider,
  rostersOf,
  scheduleOf,
  tempLeague,
  type TempLeague,
} from "./helpers.js";

const LEAGUE: LeagueRef = { platform: "manual", league_key: "manual.l.example" };
const team = (id: number): TeamRef => ({ ...LEAGUE, team_key: `manual.l.example.t.${String(id)}` });
const MINE = team(1);
const Q = (over: Partial<PlayerQuery> = {}): PlayerQuery => ({
  status: "A",
  position: null,
  search: null,
  sort: null,
  sort_type: null,
  sort_week: null,
  ...over,
});
const PAGE = { limit: 100, offset: 0 };

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

describe("the fixture league loads and maps", () => {
  it("fixture mode reads the in-repo placeholder file (0644 allowed only there)", async () => {
    const p = provider(FIXTURE_FILE, { requirePrivate: false });
    const leagues = await p.listMyLeagues();
    expect(leagues.value).toEqual([LEAGUE]);
  });

  it("listMyLeagues / getLeague: one league with its metadata and rules", async () => {
    const p = provider(t.file);
    expect((await p.listMyLeagues()).value).toEqual([LEAGUE]);
    const l = (await p.getLeague(LEAGUE)).value;
    expect(l).toMatchObject({
      ref: LEAGUE,
      name: "Example League",
      season: 2026,
      num_teams: 12,
      scoring_type: "head",
      start_week: 1,
      end_week: 17,
      current_week: 1, // no schedule attached, no override → start_week
      edit_key: 1,
      weekly_deadline: null,
      draft_status: "postdraft",
      is_finished: false,
      my_team: MINE,
      my_team_name: "Team A",
      weeks: [],
    });
    expect(l.rules).toMatchObject({
      waiver_type: "faab",
      waiver_time_days: 2,
      uses_faab: true,
      faab_budget: 100,
      trade_ratify_type: "commissioner",
      max_adds: null,
      max_weekly_adds: null,
      unverified_fields: [],
      playoffs: { uses_playoff: true, start_week: 15, num_teams: 6 },
      capabilities: { hasFaab: true, waiverProcessingDays: 2, tradeReviewMode: "commissioner" },
    });
  });

  it("getScoringSettings: half-PPR with the validation league's values, no bonuses", async () => {
    const s = (await provider(t.file).getScoringSettings(LEAGUE)).value;
    const mod = (c: string): number | null | undefined =>
      s.rules.find((r) => r.canonical === c)?.modifier;
    expect(s.platform).toBe("manual");
    expect(mod("rec")).toBe(0.5);
    expect(mod("pass_td")).toBe(4);
    expect(mod("rush_td")).toBe(6);
    expect(mod("rec_td")).toBe(6);
    expect(mod("fum_lost")).toBe(-2);
    expect(mod("pass_int")).toBe(-1);
    expect(s.rules.every((r) => r.bonuses.length === 0)).toBe(true);
    expect(
      s.brackets
        .map((b) => [b.family, b.kind, b.members.length])
        .sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    ).toEqual([
      ["dst_points_allowed", "indicator", 7],
      ["fg_distance", "count", 5],
    ]);
    expect(s.settings_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.rounding).toEqual({ mode: "exact", verified: false });
  });

  it("getRosterSlots: the 17-slot fixture", async () => {
    const s = (await provider(t.file).getRosterSlots(LEAGUE)).value;
    expect(s).toMatchObject({ starters: 9, bench: 6, ir: 2, total: 17 });
    expect(s.slots.map((x) => x.name)).toEqual([
      "QB",
      "WR",
      "RB",
      "TE",
      "W/R/T",
      "K",
      "DEF",
      "BN",
      "IR",
    ]);
  });

  it("getRoster (mine): every entry keyed by the manual grammar and legal against the slots", async () => {
    const p = provider(t.file);
    const r = (await p.getRoster(MINE, 1)).value;
    expect(r.team).toEqual(MINE);
    expect(r.entries).toHaveLength(16);
    for (const e of r.entries) {
      expect(e.player.ref.platform).toBe("manual");
      expect(MANUAL_KEY_RE.player.test(e.player.ref.id), e.player.ref.id).toBe(true);
      expect(e.player.ownership).toMatchObject({
        type: "team",
        owner_team_key: MINE.team_key,
        owner_name: "Team A",
      });
      expect(e.week_points).toBeNull();
      expect(e.is_editable).toBe(true); // no schedule → nothing is known to be locked
    }
    const by = (name: string) => r.entries.find((e) => e.player.name === name);
    expect(by("Josh Allen")?.player).toMatchObject({
      ref: { id: "manual.p.00-0034857" },
      gsis_hint: "00-0034857",
      position: "QB",
      team_abbr: "BUF",
    });
    expect(by("DET")?.player).toMatchObject({
      ref: { id: "manual.p.def-det" },
      position: "DEF",
      gsis_hint: null,
    });
    expect(by("Ashton Jeanty")?.player.gsis_hint).toBeNull();
    expect(by("Ashton Jeanty")?.player.ref.id).toMatch(/^manual\.p\.n-[0-9a-f]{16}$/);
    expect(by("Nico Collins")).toMatchObject({
      slot: "IR",
      slot_class: "ir",
      player: { status: "O", eligible_positions: ["WR", "W/R/T", "IR"] },
    });
    expect(by("Jaxon Smith-Njigba")).toMatchObject({
      slot: "W/R/T",
      slot_class: "flex",
      is_flex: true,
    });
    const slots = (await p.getRosterSlots(LEAGUE)).value;
    const v = validateRoster(
      r.entries.map((e) => ({
        player_key: e.player.ref.id,
        slot: e.slot,
        positions: [e.player.position],
        status: e.player.status,
      })),
      slots,
    );
    expect(v).toMatchObject({
      legal: true,
      empty_starting_slots: [],
      ir_ineligible_in_ir: [],
      over_limit: false,
    });
  });

  it("getRoster (opponent, rosterless team) and NOT_FOUND for unknown teams/leagues", async () => {
    const p = provider(t.file);
    const b = (await p.getRoster(team(2), 1)).value;
    expect(b.entries).toHaveLength(15);
    expect(b.entries.find((e) => e.player.name === "Puka Nacua")?.player.status).toBe("D");
    expect((await p.getRoster(team(3), 1)).value.entries).toEqual([]);
    await expect(p.getRoster(team(13), 1)).rejects.toBeInstanceOf(ManualNotFoundError);
    await expect(
      p.getRoster({ ...team(1), league_key: "manual.l.other" }, 1),
    ).rejects.toMatchObject({ ffCode: "NOT_FOUND" });
    await expect(p.getRoster({ ...team(1), platform: "yahoo" }, 1)).rejects.toMatchObject({
      ffCode: "NOT_FOUND",
    });
    await expect(
      p.getLeague({ platform: "manual", league_key: "manual.l.nope" }),
    ).rejects.toMatchObject({ ffCode: "NOT_FOUND" });
    await expect(
      p.getScoringSettings({ platform: "yahoo", league_key: "manual.l.example" }),
    ).rejects.toBeInstanceOf(ManualNotFoundError);
  });

  it("capabilities: read-only, features from what the file holds", async () => {
    const c = await provider(t.file).capabilities();
    expect(c.read).toBe(true);
    expect(Object.values(c.write).every((w) => !w)).toBe(true);
    expect(c.read_features).toEqual({
      player_stats: false,
      transactions: true,
      free_agent_pool: false,
      other_rosters: true,
      matchups: true,
      standings: false,
    });
    expect(c.discovered_at).toBe("2026-09-30T12:00:00.000Z");
    const bare = tempLeague(
      FIXTURE_TEXT.slice(0, FIXTURE_TEXT.indexOf("other_teams:")).trimEnd() + "\n",
    );
    try {
      expect((await provider(bare.file).capabilities()).read_features).toMatchObject({
        transactions: false,
        other_rosters: false,
        matchups: false,
      });
    } finally {
      bare.cleanup();
    }
  });

  it("capabilities never throws on a missing or invalid file (all features false)", async () => {
    rmSync(t.file);
    const c = await provider(t.file).capabilities();
    expect(Object.values(c.read_features).every((f) => !f)).toBe(true);
    t.write("version: 1\n");
    expect(
      Object.values((await provider(t.file).capabilities()).read_features).every((f) => !f),
    ).toBe(true);
  });

  it("missing features return the contract's empty result, never an invented value", async () => {
    const p = provider(t.file);
    expect(
      (
        await p.getPlayerStats(LEAGUE, [{ platform: "manual", id: "manual.p.00-0034857" }], {
          coverage: "week",
          week: 1,
        })
      ).value,
    ).toEqual([]);
    expect((await p.getStandings(LEAGUE)).value).toEqual([]);
    expect((await p.getMatchups(LEAGUE, 4)).value).toEqual([]);
  });

  it("getMatchups: my matchup against the listed opponent", async () => {
    const m = (await provider(t.file).getMatchups(LEAGUE, 1)).value;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      week: 1,
      status: "unknown", // no schedule attached
      is_playoffs: false,
      winner_team_key: null,
      teams: [
        { team: MINE, name: "Team A", points: null, projected_points_platform: null },
        { team: team(2), name: "Team B", win_probability_platform: null },
      ],
    });
  });

  it("listTransactions: newest first, filtered by type/team/since/count", async () => {
    const p = provider(t.file);
    const q = { types: null, team_key: null, count: 25, since: null };
    const all = (await p.listTransactions(LEAGUE, q)).value;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      transaction_key: "manual.l.example.tr.1",
      type: "waiver",
      status: "successful",
      timestamp: "2026-09-16T10:00:00.000Z",
      faab_bid: 7,
      players: [
        {
          action: "add",
          source_type: "waivers",
          destination_type: "team",
          destination_team_key: MINE.team_key,
        },
        {
          action: "drop",
          source_type: "team",
          source_team_key: MINE.team_key,
          destination_type: "waivers",
        },
      ],
    });
    expect((await p.listTransactions(LEAGUE, { ...q, types: ["add"] })).value).toEqual([]);
    expect((await p.listTransactions(LEAGUE, { ...q, types: ["waiver"] })).value).toHaveLength(1);
    expect((await p.listTransactions(LEAGUE, { ...q, team_key: team(2).team_key })).value).toEqual(
      [],
    );
    expect(
      (await p.listTransactions(LEAGUE, { ...q, team_key: MINE.team_key })).value,
    ).toHaveLength(1);
    expect(
      (await p.listTransactions(LEAGUE, { ...q, since: "2026-09-17T00:00:00Z" })).value,
    ).toEqual([]);
    expect((await p.listTransactions(LEAGUE, { ...q, since: "not a date" })).value).toHaveLength(1);
    expect((await p.listTransactions(LEAGUE, { ...q, count: 0 })).value).toEqual([]);
  });
});

describe("listPlayers", () => {
  it("T = rostered players of every listed roster, owned by their team", async () => {
    const page = (await provider(t.file).listPlayers(LEAGUE, Q({ status: "T" }), PAGE)).value;
    expect(page.total).toBe(31);
    expect(page.items.every((p) => p.ownership?.type === "team")).toBe(true);
  });

  it("FA = listed free agents plus the unknown-availability DEF universe (rostered DEF excluded)", async () => {
    const page = (await provider(t.file).listPlayers(LEAGUE, Q({ status: "FA" }), PAGE)).value;
    const names = page.items.map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(["Jeremiyah Love", "Harold Fannin Jr."]);
    expect(page.items[0]?.ownership?.type).toBe("freeagents");
    const defs = page.items.filter((p) => p.position === "DEF");
    expect(defs).toHaveLength(30);
    expect(defs.every((d) => d.ownership?.type === "unknown")).toBe(true);
    expect(defs.some((d) => d.name === "DET" || d.name === "HOU")).toBe(false);
  });

  it("W = listed waivers; K (keepers) = none", async () => {
    const p = provider(t.file);
    expect(
      (await p.listPlayers(LEAGUE, Q({ status: "W" }), PAGE)).value.items.map((x) => x.name),
    ).toEqual(["Ka'imi Fairbairn"]);
    expect((await p.listPlayers(LEAGUE, Q({ status: "K" }), PAGE)).value.total).toBe(0);
  });

  it("kicker universe from attached weekly rosters, deduplicated against the file", async () => {
    // Object.assign keeps the row valid whether or not the crosswalk contract carries `status`.
    const row = (
      gsis_id: string,
      full_name: string,
      team: "DAL" | "HOU" | "DET" | "PIT",
    ): Parameters<typeof rostersOf>[0][number] =>
      Object.assign(
        {
          gsis_id,
          season: 2026,
          week: 4,
          full_name,
          team,
          position: "K",
          jersey_number: 1,
          yahoo_id: null,
          sleeper_id: null,
          espn_id: null,
          pfr_id: null,
        },
        { status: null },
      );
    const rosters = rostersOf([
      row("00-0039172", "Jake Bates", "DET"),
      row("00-0032726", "Ka'imi Fairbairn", "HOU"), // already on waivers in the file
      row("00-0031136", "Chris Boswell", "PIT"), // on my roster
      row("bad-id", "Broken Row", "DAL"),
      { ...row("00-0037692", "Brandon Aubrey", "DAL"), position: "WR" },
    ]);
    const p = provider(t.file, { rosters });
    const ks = (await p.listPlayers(LEAGUE, Q({ status: "FA", position: "K" }), PAGE)).value.items;
    expect(ks.map((k) => [k.name, k.ownership?.type])).toEqual([["Jake Bates", "unknown"]]);
    const all = (await p.listPlayers(LEAGUE, Q({ position: "K" }), PAGE)).value.items.map(
      (k) => k.name,
    );
    expect(all).toEqual(["Chris Boswell", "Brandon Aubrey", "Ka'imi Fairbairn", "Jake Bates"]);
  });

  it("position filter accepts a slot name (W/R/T → RB/WR/TE only), search and NAME sort", async () => {
    const p = provider(t.file);
    const flex = (await p.listPlayers(LEAGUE, Q({ position: "W/R/T" }), PAGE)).value.items;
    expect(flex.length).toBeGreaterThan(0);
    expect(flex.every((x) => ["RB", "WR", "TE"].includes(x.position))).toBe(true);
    const love = (await p.listPlayers(LEAGUE, Q({ search: "LOVE" }), PAGE)).value.items.map(
      (x) => x.name,
    );
    expect(love).toEqual(["Jordan Love", "Jeremiyah Love"]);
    const sorted = (
      await p.listPlayers(LEAGUE, Q({ status: "T", sort: "NAME" }), PAGE)
    ).value.items.map((x) => x.name);
    expect(sorted).toEqual([...sorted].sort());
    expect((await p.listPlayers(LEAGUE, Q({ search: "zzzz" }), PAGE)).value.items).toEqual([]);
  });

  it("pages: limit/offset/has_more/next_offset/total", async () => {
    const p = provider(t.file);
    const a = (await p.listPlayers(LEAGUE, Q({ status: "T" }), { limit: 10, offset: 0 })).value;
    expect(a).toMatchObject({
      count: 10,
      has_more: true,
      next_offset: 10,
      total: 31,
      limit: 10,
      offset: 0,
    });
    const last = (await p.listPlayers(LEAGUE, Q({ status: "T" }), { limit: 10, offset: 30 })).value;
    expect(last).toMatchObject({ count: 1, has_more: false, next_offset: null });
    const past = (await p.listPlayers(LEAGUE, Q({ status: "T" }), { limit: 10, offset: 10_000 }))
      .value;
    expect(past).toMatchObject({ count: 0, has_more: false, next_offset: null, total: 31 });
  });
});

describe("with the nflverse schedule attached", () => {
  // Week 1 of 2026 plus a one-game week-6 slate: every team but BUF and MIA is on bye that week.
  const games = [...WEEK1, game("2026_06_X", 6, "BUF", "MIA", "2026-10-18T17:00:00.000Z")];
  const schedule = scheduleOf(games);

  it("fills bye weeks and locks each entry at its own kickoff (Sunday 13:05 ET)", async () => {
    const p = provider(t.file, { schedule, clock: clock("2026-09-13T17:05:00.000Z") });
    const r = (await p.getRoster(MINE, 1)).value;
    const by = (n: string) => r.entries.find((e) => e.player.name === n);
    expect(by("Jahmyr Gibbs")).toMatchObject({ is_editable: false, player: { bye_week: 6 } }); // DET 13:00 ET
    expect(by("Jaxon Smith-Njigba")?.is_editable).toBe(false); // SEA, Wednesday opener
    expect(by("Jordan Love")?.is_editable).toBe(true); // GB 16:25 ET
    expect(by("Kenneth Walker III")).toMatchObject({ is_editable: true, player: { bye_week: 6 } }); // KC, Monday
    expect(r.is_editable).toBe(true);
    const after = provider(t.file, { schedule, clock: clock("2026-09-16T00:00:00.000Z") });
    expect((await after.getRoster(MINE, 1)).value.is_editable).toBe(false);
  });

  it("weekly lock: every entry locks at the Wednesday opener", async () => {
    t.write(edit("lineup_lock: per_game", "lineup_lock: weekly"));
    const p = provider(t.file, { schedule, clock: clock("2026-09-10T00:21:00.000Z") });
    const r = (await p.getRoster(MINE, 1)).value;
    expect(r.entries.every((e) => !e.is_editable)).toBe(true);
    expect((await p.getLeague(LEAGUE)).value.weekly_deadline).toBe("weekly");
  });

  it("current week, calendar and matchup status follow the clock", async () => {
    const pre = provider(t.file, { schedule, clock: clock("2026-09-01T00:00:00.000Z") });
    const l = (await pre.getLeague(LEAGUE)).value;
    expect(l).toMatchObject({ current_week: 1, edit_key: 1, is_finished: false });
    expect(l.weeks.map((w) => [w.week, w.is_current])).toEqual([
      [1, true],
      [6, false],
    ]);
    expect((await pre.getMatchups(LEAGUE, 1)).value[0]?.status).toBe("preevent");
    const mid = provider(t.file, { schedule, clock: clock("2026-09-13T18:00:00.000Z") });
    expect((await mid.getMatchups(LEAGUE, 1)).value[0]?.status).toBe("midevent");
    const post = provider(t.file, { schedule, clock: clock("2026-09-20T00:00:00.000Z") });
    expect((await post.getMatchups(LEAGUE, 1)).value[0]?.status).toBe("postevent");
    expect((await post.getLeague(LEAGUE)).value.current_week).toBe(6);
    const done = provider(t.file, { schedule, clock: clock("2027-01-20T00:00:00.000Z") });
    expect((await done.getLeague(LEAGUE)).value).toMatchObject({
      is_finished: true,
      edit_key: null,
      current_week: 6,
    });
  });

  it("a current_week override in the file wins over the schedule", async () => {
    t.write(edit("  end_week: 17\n", "  end_week: 17\n  current_week: 3\n"));
    const p = provider(t.file, { schedule, clock: clock("2027-01-20T00:00:00.000Z") });
    const l = (await p.getLeague(LEAGUE)).value;
    expect(l).toMatchObject({ current_week: 3, is_finished: false, edit_key: 3 });
    expect(l.weeks.every((w) => !w.is_current)).toBe(true); // weeks 1 and 6 are not week 3
  });

  it("playoff weeks are flagged on the matchup", async () => {
    t.write(
      edit("  - { week: 3, team: 2 }\n", "  - { week: 3, team: 2 }\n  - { week: 15, team: 2 }\n"),
    );
    expect((await provider(t.file).getMatchups(LEAGUE, 15)).value[0]?.is_playoffs).toBe(true);
  });
});

describe("stamps", () => {
  it("every read is Stamped: source manual, class manual_league, as_of = file mtime, fetched_at = clock", async () => {
    const mtime = new Date("2026-09-28T09:15:00.000Z");
    utimesSync(t.file, mtime, mtime);
    const c = clock("2026-09-30T12:00:00.000Z");
    const p = provider(t.file, { clock: c });
    const reads = [
      p.listMyLeagues(),
      p.getLeague(LEAGUE),
      p.getScoringSettings(LEAGUE),
      p.getRosterSlots(LEAGUE),
      p.getRoster(MINE, 1),
      p.listPlayers(LEAGUE, Q(), PAGE),
      p.getPlayerStats(LEAGUE, [], { coverage: "season" }),
      p.getMatchups(LEAGUE, 1),
      p.getStandings(LEAGUE),
      p.listTransactions(LEAGUE, { types: null, team_key: null, count: 5, since: null }),
    ];
    for (const r of await Promise.all(reads)) {
      expect(r.stamp).toEqual({
        source: "manual",
        as_of: "2026-09-28T09:15:00.000Z",
        fetched_at: "2026-09-30T12:00:00.000Z",
        freshness: "manual_league",
        provisional: false,
      });
    }
    c.advance(60_000);
    expect((await p.listMyLeagues()).stamp.fetched_at).toBe("2026-09-30T12:01:00.000Z");
  });

  it("re-reads the file on every read: an edit shows up immediately", async () => {
    const p = provider(t.file);
    expect((await p.getLeague(LEAGUE)).value.my_team_name).toBe("Team A");
    t.write(edit("  name: Team A\n", "  name: Team Alpha\n"));
    expect((await p.getLeague(LEAGUE)).value.my_team_name).toBe("Team Alpha");
  });
});

describe("file safety (plan 02 §3.3; critic C-13b)", () => {
  it("missing file → LeagueFileError(missing): NOT_FOUND with the missing-league hint", async () => {
    rmSync(t.file);
    const err = await provider(t.file)
      .listMyLeagues()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeagueFileError);
    expect(err).toMatchObject({
      kind: "missing",
      ffCode: "NOT_FOUND",
      ffHint: MANUAL_LEAGUE_MISSING_HINT,
      issues: [],
    });
  });

  it("missing config directory → NOT_FOUND too", async () => {
    const p = provider(path.join(t.root, "nope", "league.yaml"));
    await expect(p.getLeague(LEAGUE)).rejects.toMatchObject({
      kind: "missing",
      ffCode: "NOT_FOUND",
    });
  });

  const refused = async (p: ManualLeagueProvider, reason: RegExp): Promise<void> => {
    const err = await p.listMyLeagues().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeagueFileError);
    expect(err).toMatchObject({
      kind: "invalid",
      ffCode: "INTERNAL",
      ffHint: LEAGUE_FILE_INVALID_HINT,
    });
    const issues = (err as LeagueFileError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toMatch(reason);
    // the path is a fixed label, never the absolute file path
    expect(JSON.stringify(issues)).not.toContain(t.root);
  };

  it("a 0644 file is refused (INTERNAL, never VALIDATION)", async () => {
    chmodSync(t.file, 0o644);
    await refused(provider(t.file), /group\/other permission bits/);
  });

  it("a 0640 or 0604 file is refused", async () => {
    chmodSync(t.file, 0o640);
    await refused(provider(t.file), /permission bits/);
    chmodSync(t.file, 0o604);
    await refused(provider(t.file), /permission bits/);
  });

  it("a symlink at league.yaml is refused even when its target is a valid 0600 league", async () => {
    const real = path.join(t.dir, "real.yaml");
    writeFileSync(real, "x", { mode: 0o600 });
    rmSync(t.file);
    symlinkSync(real, t.file);
    await refused(provider(t.file), /symbolic link/);
  });

  it("a group-writable config directory is refused", async () => {
    chmodSync(t.dir, 0o770);
    try {
      await refused(provider(t.file), /permission bits/);
    } finally {
      chmodSync(t.dir, 0o700);
    }
  });

  it("a config directory under a group/other-writable, non-sticky ancestor is refused", async () => {
    chmodSync(t.root, 0o777);
    try {
      await refused(provider(t.file), /parent directory is writable/);
    } finally {
      chmodSync(t.root, 0o700);
    }
  });

  it("a directory at league.yaml is refused as not a regular file", async () => {
    rmSync(t.file);
    mkdirSync(t.file);
    await refused(provider(t.file), /not a regular file/);
  });

  it("a file larger than the cap is refused before it is parsed (5 MB)", async () => {
    t.write("a".repeat(5 * 1024 * 1024));
    await refused(provider(t.file), /larger than the allowed maximum/);
  });

  it("a cached good load does not survive a later chmod 0644", async () => {
    const p = provider(t.file);
    await p.listMyLeagues();
    chmodSync(t.file, 0o644);
    await refused(p, /permission bits/);
  });

  it("fixture mode (requirePrivate: false) accepts 0644 but still refuses a symlink", async () => {
    chmodSync(t.file, 0o644);
    expect((await provider(t.file, { requirePrivate: false }).listMyLeagues()).value).toEqual([
      LEAGUE,
    ]);
    const link = path.join(t.dir, "link.yaml");
    symlinkSync(t.file, link);
    await expect(provider(link, { requirePrivate: false }).listMyLeagues()).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("a config 'directory' that is really a file is refused; an unreadable parent path is invalid", async () => {
    await refused(provider(path.join(t.file, "league.yaml")), /not a directory/);
    const err = await provider(path.join(t.file, "sub", "league.yaml"))
      .listMyLeagues()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: "invalid",
      issues: [{ path: "<config dir>", reason: "the directory could not be read" }],
    });
  });

  it("the constructor requires an absolute path", () => {
    expect(() => new ManualLeagueProvider({ file: "league.yaml", clock: clock() })).toThrow(
      RangeError,
    );
  });
});
