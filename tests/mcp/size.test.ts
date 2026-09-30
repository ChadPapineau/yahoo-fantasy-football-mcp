// size.test.ts — plan 07 §5.1 token economy on the fixture league (plan 10 A6, §2 ledger): every
// tool's compact and full result ≤ its worst-case column (analytics ≤ 10 000 chars), the per-turn
// fixed cost of tools/list against the downward-only ceilings (core ≤ 20 000 chars, full ≤ 35 000;
// Skills listing ≤ 4 500), and the OBJ-07 bare-vs-wrapped player-name comparison. The measured
// numbers go to the CI job summary (plan 10 §2 ledger) and are copied into plan 07 §5.1.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYTICS_BUDGET_CHARS, wrapUntrusted } from "../../src/mcp/envelope.js";
import { TEAM_A, ROOT, connect, makeWorld, type World } from "./helpers/env.js";
import { writeSizeReport, type SizeReport } from "./helpers/size-report.js";

/** plan 07 §5.1 worst-case column (serialised chars at compact; the halving point is the budget). */
const WORST: Readonly<Record<string, number>> = {
  ff_list_leagues: 20_000,
  ff_get_league: 20_000,
  ff_get_standings: 20_000,
  ff_get_scoreboard: 20_000,
  ff_list_transactions: 20_000,
  ff_get_roster: 20_000,
  ff_get_player_stats: 10_000,
  ff_search_players: 20_000,
  ff_list_players: 20_000,
  ff_get_injuries: 20_000,
  ff_get_schedule: 20_000,
  ff_project_players: ANALYTICS_BUDGET_CHARS,
  ff_analyze_lineup: ANALYTICS_BUDGET_CHARS,
  ff_analyze_matchup: ANALYTICS_BUDGET_CHARS,
  ff_analyze_waivers: ANALYTICS_BUDGET_CHARS,
  ff_record_recommendation: 20_000,
  ff_analyze_retrospective: ANALYTICS_BUDGET_CHARS,
  ff_list_recommendations: 20_000,
  ff_get_status: 5_000,
};

/** The heaviest realistic call per tool on the fixture league. */
const HEAVY: Readonly<Record<string, Record<string, unknown>>> = {
  ff_list_leagues: { include_finished: true },
  ff_get_league: {},
  ff_get_standings: {},
  ff_get_scoreboard: { week: 3 },
  ff_list_transactions: { count: 200 },
  ff_get_roster: { team_key: TEAM_A, week: 4 },
  ff_get_player_stats: {
    player_keys: [
      "manual.p.00-0034857",
      "manual.p.00-0036900",
      "manual.p.00-0031136",
      "manual.p.def-det",
    ],
    type: "season",
  },
  ff_search_players: { query: "e", limit: 25 },
  ff_list_players: { limit: 100 },
  ff_get_injuries: {},
  ff_get_schedule: { weeks: [4] },
  ff_project_players: { players: { team_key: TEAM_A }, horizon: "week", week: 4, seed: 1 },
  ff_analyze_lineup: { week: 3 },
  ff_analyze_matchup: { week: 3 },
  ff_analyze_waivers: { positions: ["K", "DEF"], look_ahead: 2 },
  ff_analyze_retrospective: { week: 3 },
  ff_list_recommendations: { limit: 100 },
  ff_get_status: { include_checks: true },
};

/** Ceilings on the per-turn fixed cost (plan 07 §5.1 [A-4]; downward-only). */
const CEILING = { core: 20_000, full: 35_000, skills: 4_500 } as const;

let world: World;
const report: SizeReport = {};
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  // the ledger rows (plan 10 §2): the CI job summary carries the measured numbers as a table
  // (tests/mcp/helpers/size-report.ts); the log line keeps them in the raw job output too
  console.log(`SIZE-REPORT ${JSON.stringify(report)}`);
  writeSizeReport(report, CEILING);
  world.cleanup();
});

describe("result sizes ≤ plan 07 §5.1 worst case (A6)", () => {
  it("compact and full, every tool", async () => {
    const { client, close } = await connect(world);
    const sizes: Record<string, { compact: number; full: number }> = {};
    for (const [name, args] of Object.entries(HEAVY)) {
      const measure = async (detail: "compact" | "full"): Promise<number> => {
        const withDetail = [
          "ff_list_leagues",
          "ff_get_league",
          "ff_get_standings",
          "ff_get_scoreboard",
          "ff_list_transactions",
          "ff_get_player_stats",
          "ff_search_players",
          "ff_get_injuries",
          "ff_get_schedule",
          "ff_analyze_matchup",
          "ff_analyze_retrospective",
          "ff_get_status",
        ].includes(name)
          ? args
          : { ...args, detail };
        const r = await client.callTool({ name, arguments: withDetail });
        const text = (r.content as { text: string }[])[0]?.text ?? "";
        expect(r.isError, `${name}: ${text.slice(0, 200)}`).not.toBe(true);
        return text.length;
      };
      const compact = await measure("compact");
      const full = await measure("full");
      sizes[name] = { compact, full };
      const cap = WORST[name] ?? 20_000;
      expect(compact, name).toBeLessThanOrEqual(cap);
      expect(full, name).toBeLessThanOrEqual(cap);
    }
    report.results = sizes;
    await close();
  }, 60_000);

  it("ff_record_recommendation answers in about 200 chars of data", async () => {
    const { client, close } = await connect(world);
    const l = JSON.parse(
      (
        (await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 3 } })).content as {
          text: string;
        }[]
      )[0]?.text ?? "{}",
    ) as { data: { rec: unknown } };
    const r = await client.callTool({
      name: "ff_record_recommendation",
      arguments: { kind: "lineup", week: 3, rec: l.data.rec, client_ref: "size-1" },
    });
    const b = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as { data: unknown };
    expect(JSON.stringify(b.data).length).toBeLessThanOrEqual(200);
    await close();
  });
});

describe("per-turn fixed cost (plan 07 §5.1; plan 10 §2 ledger)", () => {
  it("tools/list chars and ≈tokens under core and full are within the ceilings", async () => {
    for (const toolset of ["core", "full"] as const) {
      const { client, close } = await connect(world, { options: { toolset, fixtureMode: false } });
      const chars = JSON.stringify((await client.listTools()).tools).length;
      const prompts = JSON.stringify((await client.listPrompts()).prompts).length;
      // no tokenizer is a dependency: report the 4-chars/token rule of thumb and a 3-chars/token bound
      report[`tools_list_${toolset}`] = {
        chars,
        tokens_approx: Math.ceil(chars / 4),
        tokens_upper: Math.ceil(chars / 3),
        prompts_list_chars: prompts,
      };
      expect(chars).toBeLessThanOrEqual(CEILING[toolset]);
      await close();
    }
  });

  it("the Skills listing (name + description of each shipped Skill) is ≤ 4 500 chars", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "skills", "_shared", "manifest.json"), "utf8"),
    ) as { skills: string[] };
    let total = 0;
    for (const s of manifest.skills) {
      const text = readFileSync(path.join(ROOT, "skills", s, "SKILL.md"), "utf8");
      const d = /^description:\s*(.*)$/m.exec(text)?.[1] ?? "";
      total += s.length + d.length;
    }
    report.skills_listing_chars = total;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(CEILING.skills);
  });

  it("OBJ-07: player names bare + path-listed vs wrapped (ff_list_players, ff_get_roster)", async () => {
    const { client, close } = await connect(world);
    const out: NonNullable<SizeReport["obj07"]> = {};
    for (const [name, args] of [
      ["ff_list_players", { limit: 100 }],
      ["ff_get_roster", { week: 4 }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      const players = (JSON.parse(text) as { data: { players: { name: string }[] } }).data.players;
      const extra = players.reduce(
        (a, p) =>
          a +
          JSON.stringify(wrapUntrusted(p.name, "player_name", "manual.player.name")).length -
          JSON.stringify(p.name).length,
        0,
      );
      out[name] = { bare: text.length, wrapped: text.length + extra, names: players.length };
      expect(extra).toBeGreaterThan(0);
    }
    report.obj07 = out;
    await close();
  });
});
