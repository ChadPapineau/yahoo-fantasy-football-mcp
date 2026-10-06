// model.test.ts — the pieces under ManualLeagueProvider: scoring presets → ScoringSettings (plan 08
// §2/§4.1), player keys (manualPlayerKeyFor + the deterministic name key; critic C-13), value-free
// issue formatting, and identifier registration → redaction in a captured log line (plan 01 §8
// identifier obligation; CONTRIBUTING.md Security).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../../src/cli/log.js";
import { MANUAL_KEY_RE, NFL_TEAMS } from "../../../src/config/schema.js";
import { KNOWN_CANONICAL } from "../../../src/domain/scoring/types.js";
import {
  BASE_SCORING,
  buildScoringSettings,
  entryKey,
  issuesOf,
  leagueFileSchema,
  normalizeLeague,
  parseLeagueYaml,
  PRESET_REC,
} from "../../../src/providers/manual/index.js";
import { canonicalJson, positionTypeOf } from "../../../src/providers/manual/scoring.js";
import { computeSettingsHash, normalizeSettings } from "../../../src/domain/scoring/settings.js";
import { formatPath } from "../../../src/providers/manual/schema.js";
import { edit, FIXTURE_TEXT, provider, tempLeague, type TempLeague } from "./helpers.js";

describe("scoring presets", () => {
  it("standard / half_ppr / ppr differ only in `rec`", () => {
    const s = buildScoringSettings({ preset: "standard" });
    const h = buildScoringSettings({ preset: "half_ppr" });
    const p = buildScoringSettings({ preset: "ppr" });
    expect(s.rules.find((r) => r.canonical === "rec")).toBeUndefined();
    expect(h.rules.find((r) => r.canonical === "rec")?.modifier).toBe(PRESET_REC.half_ppr);
    expect(p.rules.find((r) => r.canonical === "rec")?.modifier).toBe(1);
    const strip = (x: typeof s) => x.rules.filter((r) => r.canonical !== "rec");
    expect(strip(s)).toEqual(strip(h));
    expect(new Set([s.settings_hash, h.settings_hash, p.settings_hash]).size).toBe(3);
  });

  it("every rule is a known canonical with the right position type and platform id = canonical", () => {
    const s = buildScoringSettings({ preset: "ppr" });
    for (const r of s.rules) {
      expect(KNOWN_CANONICAL).toContain(r.canonical);
      expect(r.platform_id).toBe(r.canonical);
      expect(r.position_types).toEqual([positionTypeOf(r.platform_id)]);
    }
    expect(positionTypeOf("dst_sack")).toBe("DT");
    expect(positionTypeOf("fg_50p")).toBe("K");
    expect(positionTypeOf("pat_made")).toBe("K");
    expect(positionTypeOf("rush_yd")).toBe("O");
    expect(
      Object.keys(BASE_SCORING).every((k) => (KNOWN_CANONICAL as readonly string[]).includes(k)),
    ).toBe(true);
  });

  it("brackets are contiguous, sorted, and typed indicator (points allowed) / count (FG distance)", () => {
    const s = buildScoringSettings({ preset: "half_ppr" });
    const pa = s.brackets.find((b) => b.family === "dst_points_allowed");
    const fg = s.brackets.find((b) => b.family === "fg_distance");
    expect(pa).toMatchObject({ kind: "indicator", position_type: "DT" });
    expect(fg).toMatchObject({ kind: "count", position_type: "K" });
    for (const b of [pa, fg]) {
      const m = b?.members ?? [];
      expect(m[0]?.lower).toBe(0);
      expect(m[m.length - 1]?.upper).toBeNull();
      for (let i = 1; i < m.length; i++)
        expect(m[i]?.lower).toBe((m[i - 1]?.upper ?? Number.NaN) + 1);
    }
  });

  it("overrides replace preset values and can add known stats; bonuses attach sorted", () => {
    const s = buildScoringSettings({
      preset: "half_ppr",
      overrides: { pass_td: 6, targets: 0.1, dst_pa_21_27: 1 },
      bonuses: [
        { stat: "rush_yd", target: 200, points: 5 },
        { stat: "rush_yd", target: 100, points: 3 },
        { stat: "pass_1d", target: 10, points: 1 },
      ],
      fractional_points: false,
      negative_points: false,
    });
    const r = (c: string) => s.rules.find((x) => x.canonical === c);
    expect(r("pass_td")?.modifier).toBe(6);
    expect(r("targets")?.modifier).toBe(0.1);
    expect(r("rush_yd")?.bonuses).toEqual([
      { target: 100, points: 3 },
      { target: 200, points: 5 },
    ]);
    expect(r("pass_1d")).toMatchObject({ modifier: 0, bonuses: [{ target: 10, points: 1 }] });
    expect(s.brackets.find((b) => b.family === "dst_points_allowed")?.members).toHaveLength(7);
    expect(s).toMatchObject({ uses_fractional_points: false, uses_negative_points: false });
  });

  it("the settings hash is deterministic and ignores override key order", () => {
    const a = buildScoringSettings({ preset: "ppr", overrides: { pass_td: 6, rush_td: 7 } });
    const b = buildScoringSettings({ preset: "ppr", overrides: { rush_td: 7, pass_td: 6 } });
    expect(a.settings_hash).toBe(b.settings_hash);
    // the scoring engine's one definition: an undefined property is absent (JSON semantics)
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: undefined }] })).toBe(
      '{"a":[2,{"d":null}],"b":1}',
    );
  });

  it("negative_points: false floors the player-week total (plan 08 §4.4, P9); true does not", () => {
    const off = buildScoringSettings({ preset: "ppr", negative_points: false });
    const on = buildScoringSettings({ preset: "ppr", negative_points: true });
    const dflt = buildScoringSettings({ preset: "ppr" });
    expect(off.negative_floor).toEqual({ scope: "player_week_total", verified: false });
    expect(on.negative_floor).toEqual({ scope: "none", verified: false });
    expect(dflt.negative_floor).toEqual({ scope: "none", verified: false });
    expect(off.settings_hash).not.toBe(on.settings_hash);
  });

  it("the hash is the scoring engine's (normalizeSettings is idempotent on the result)", () => {
    const s = buildScoringSettings({ preset: "half_ppr", overrides: { pass_td: 6 } });
    expect(normalizeSettings(s).settings_hash).toBe(s.settings_hash);
    expect(computeSettingsHash(s)).toBe(s.settings_hash);
  });
});

describe("player keys", () => {
  it("gsis → manual.p.<gsis>; defence → manual.p.def-<team>; name-only → manual.p.n-<16 hex>", () => {
    expect(
      entryKey({ name: "Josh Allen", team: "BUF", position: "QB", gsis_id: "00-0034857" }),
    ).toBe("manual.p.00-0034857");
    expect(entryKey({ defense: "LA" })).toBe("manual.p.def-la");
    const k = entryKey({ name: "Ashton Jeanty", team: "LV", position: "RB" });
    expect(k).toMatch(/^manual\.p\.n-[0-9a-f]{16}$/);
    // stable across case/whitespace/NFKC; distinct across team or position (same-surname pairs)
    expect(entryKey({ name: "  ashton   JEANTY ", team: "LV", position: "RB" })).toBe(k);
    expect(entryKey({ name: "Ashton Jeanty", team: "LA", position: "RB" })).not.toBe(k);
    expect(entryKey({ name: "Ashton Jeanty", team: "LV", position: "WR" })).not.toBe(k);
  });

  it("every key matches MANUAL_KEY_RE.player (property over names, teams and positions)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.constantFrom(...NFL_TEAMS),
        fc.constantFrom("QB", "RB", "WR", "TE", "K" as const),
        (name, team, position) => {
          expect(MANUAL_KEY_RE.player.test(entryKey({ name, team, position }))).toBe(true);
        },
      ),
    );
    for (const t of NFL_TEAMS)
      expect(MANUAL_KEY_RE.player.test(entryKey({ defense: t }))).toBe(true);
  });
});

describe("parse + schema + normalize units", () => {
  it("the fixture parses, validates and normalises", () => {
    const parsed = leagueFileSchema.safeParse(parseLeagueYaml(FIXTURE_TEXT));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const n = normalizeLeague(parsed.data);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data.teams.map((t) => t.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Team ${String.fromCharCode(65 + i)}`),
    );
    expect(n.data.teams.map((t) => t.ref.team_key).every((k) => MANUAL_KEY_RE.team.test(k))).toBe(
      true,
    );
    expect([...n.data.opponents.entries()]).toEqual([
      [1, "manual.l.example.t.2"],
      [2, "manual.l.example.t.2"],
      [3, "manual.l.example.t.2"],
    ]);
    expect(n.data.identifiers).toEqual(
      expect.arrayContaining([
        "Example League",
        "manual.l.example",
        "Team A",
        "Team L",
        "Manager A",
        "Manager L",
      ]),
    );
    expect(n.data.identifiers).not.toContain("example"); // the bare slug would shred log lines
  });

  it("the fixture's players agree with the shared fixture roster (name, team, position, gsis id)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const roster = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "fixtures",
          "players",
          "fixture-roster.json",
        ),
        "utf8",
      ),
    ) as { players: { gsis_id: string; name: string; team: string; position: string }[] };
    const byName = new Map(roster.players.map((p) => [p.name, p]));
    const f = leagueFileSchema.parse(parseLeagueYaml(FIXTURE_TEXT));
    const entries = [
      ...f.my_team.players,
      ...(f.other_teams ?? []).flatMap((t) => t.players ?? []),
      ...(f.free_agents ?? []),
      ...(f.waivers ?? []),
      ...(f.transactions ?? []).flatMap((x) => x.players.map((p) => p.player)),
    ];
    const checked = new Set<string>();
    for (const e of entries) {
      if ("defense" in e) continue;
      const r = byName.get(e.name);
      if (r === undefined) continue; // opponent starters outside the shared roster
      checked.add(e.name);
      expect({ team: e.team, position: e.position }).toEqual({
        team: r.team,
        position: r.position,
      });
      if (e.gsis_id !== undefined) expect(e.gsis_id).toBe(r.gsis_id);
    }
    expect(checked.size).toBe(19); // every shared-roster player appears somewhere in the league
    // placeholder identifiers only
    expect(f.league.name).toBe("Example League");
    expect(
      [f.my_team.name, ...(f.other_teams ?? []).map((t) => t.name)].every((n) =>
        /^Team [A-L]$/.test(n),
      ),
    ).toBe(true);
  });

  it("defaults: league key, weeks, lock mode, BN seat, no rules", () => {
    const minimal = [
      "version: 1",
      "league: { name: Some League, season: 2026, num_teams: 10 }",
      "scoring: { preset: ppr }",
      "roster_slots: [{ name: QB, count: 1 }, { name: BN, count: 2 }]",
      "my_team: { name: Mine, players: [{ name: Josh Allen, team: BUF, position: QB }] }",
      "",
    ].join("\n");
    const parsed = leagueFileSchema.parse(parseLeagueYaml(minimal));
    const n = normalizeLeague(parsed);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data).toMatchObject({
      ref: { league_key: "manual.l.league" },
      start_week: 1,
      end_week: 17,
      lock_mode: "per_game",
      scoring_type: "head",
      current_week_override: null,
    });
    expect(n.data.my_team.players?.[0]?.slot).toBe("BN");
    // a file silent on waivers and playoffs says neither "yes" nor "no": unknown (QA-1-045); an
    // unknown FAAB still grants no FAAB capability
    expect(n.data.rules).toMatchObject({
      uses_faab: null,
      waiver_type: null,
      faab_budget: null,
      capabilities: { hasFaab: false, tradeReviewMode: "unknown" },
    });
    expect(n.data.rules.playoffs.uses_playoff).toBeNull();
  });

  it("uses_faab follows a stated budget when no waiver type is given", () => {
    const text = edit("  waiver_type: faab\n", "");
    const n = normalizeLeague(leagueFileSchema.parse(parseLeagueYaml(text)));
    expect(n.ok && n.data.rules.uses_faab).toBe(true);
    const rolling = normalizeLeague(
      leagueFileSchema.parse(parseLeagueYaml(edit("waiver_type: faab", "waiver_type: rolling"))),
    );
    expect(rolling.ok && rolling.data.rules.uses_faab).toBe(false);
  });

  it("trades record trader/tradee and the traded player's destination", () => {
    const text = edit(
      "  - type: waiver\n",
      [
        "  - type: trade",
        '    timestamp: "2026-09-20T10:00:00Z"',
        "    team: 1",
        "    tradee_team: 2",
        "    players:",
        "      - { player: { defense: SEA }, action: trade }",
        "  - type: waiver",
        "",
      ].join("\n"),
    );
    const n = normalizeLeague(leagueFileSchema.parse(parseLeagueYaml(text)));
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const [newest] = n.data.transactions;
    expect(newest).toMatchObject({
      type: "trade",
      trader_team_key: "manual.l.example.t.1",
      tradee_team_key: "manual.l.example.t.2",
      players: [
        {
          action: "trade",
          source_type: "team",
          destination_type: "team",
          destination_team_key: "manual.l.example.t.2",
        },
      ],
    });
    expect(n.data.transactions.map((x) => x.transaction_key)).toEqual([
      "manual.l.example.tr.1",
      "manual.l.example.tr.2",
    ]);
  });

  it("formatPath and issuesOf never include input values", () => {
    expect(formatPath([])).toBe("$");
    expect(formatPath(["a", 0, "b"])).toBe("a[0].b");
    const r = leagueFileSchema.safeParse({
      version: 1,
      league: { name: "SECRETNAME", season: "x" },
      extra_SECRET: 1,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issues = issuesOf(r.error);
    expect(JSON.stringify(issues)).not.toMatch(/SECRET/);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("identifiers are registered and redacted (plan 01 §8 identifier obligation)", () => {
  let t: TempLeague;
  beforeEach(() => {
    t = tempLeague();
  });
  afterEach(() => {
    t.cleanup();
  });

  it("league, team and manager names and the league key never reach a log line", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (l) => lines.push(l),
      now: () => "2026-09-30T12:00:00.000Z",
    });
    const p = provider(t.file, { logger });
    await p.listMyLeagues();
    logger.info("tool.call", {
      args: {
        league_key: "manual.l.example",
        team: "Team B",
        note: "Manager L traded with Team A in Example League",
      },
    });
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    for (const s of ["Example League", "Team A", "Team B", "Manager L", "manual.l.example"])
      expect(line).not.toContain(s);
    expect(line).toContain("[redacted:identifier]");
  });

  it("a renamed team is registered on the reload that introduces it", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", sink: (l) => lines.push(l) });
    const p = provider(t.file, { logger });
    await p.listMyLeagues();
    t.write(edit("  name: Team B\n", "  name: Gridiron Placeholder\n"));
    await p.listMyLeagues();
    logger.info("x", { v: "Gridiron Placeholder" });
    expect(lines.join("\n")).not.toContain("Gridiron Placeholder");
  });

  it("nothing is registered from an invalid file, and nothing is logged by the provider itself", async () => {
    const registered: string[] = [];
    t.write(edit("  season: 2026\n", "  season: nope\n"));
    const p = provider(t.file, { logger: { registerSecret: (_k, v) => registered.push(v) } });
    await expect(p.listMyLeagues()).rejects.toMatchObject({ kind: "invalid" });
    expect(registered).toEqual([]);
  });
});
