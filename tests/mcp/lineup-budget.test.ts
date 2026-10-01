// lineup-budget.test.ts — E2 ff_analyze_lineup always fits the 10 000-char analytics budget (plan 07
// C8 "arrays halved with a warning", never INTERNAL; plan 01 §4.2; plan 10 A6), on the fixture league
// AND on a schema-legal deep roster (60 players, 64-char names) — findings QA-1-001, QA-1-073,
// QA-1-080. The swaps are the decision and are never cut; rec.action agrees with what is shown; a
// compact call is never told to "use detail compact".
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { truncationHint } from "../../src/mcp/define.js";
import { ANALYTICS_BUDGET_CHARS } from "../../src/mcp/envelope.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { TEAM_B, connect, makeWorld, type World } from "./helpers/env.js";

interface E2 {
  data: {
    current_lineup: { slot: string; player_key: string }[];
    recommended_lineup: { slot: string; player_key: string; name: string }[];
    swaps: { out: string; in: string; slot: string }[];
    rec: { action: string };
  };
  meta: { untrusted_fields: { path: string }[] };
  truncated: boolean;
  warnings: string[];
}

const STARTING = (slot: string): boolean => slot !== "BN" && slot !== "IR";

/** Every property the budget must keep, whatever it cut. */
function expectFits(text: string, isError: boolean | undefined, detail: string, label: string): E2 {
  expect(isError, `${label}: ${text.slice(0, 300)}`).not.toBe(true);
  expect(text.length, label).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
  const b = JSON.parse(text) as E2;
  // the swaps are the advice: rec.action's count is exactly what is shown
  const m = /make (\d+) lineup change/.exec(b.data.rec.action);
  if (m !== null) expect(b.data.swaps.length, `${label}: ${b.data.rec.action}`).toBe(Number(m[1]));
  // every recommended starter is shown
  const starters = b.data.recommended_lineup.filter((r) => STARTING(r.slot));
  for (const s of b.data.swaps)
    expect(
      starters.some((r) => r.player_key === s.in),
      `${label}: swap-in ${s.in} is shown`,
    ).toBe(true);
  if (detail !== "full") for (const w of b.warnings) expect(w, label).not.toMatch(/detail compact/);
  // a path is listed only while its field is present
  if (b.data.current_lineup.every((r) => !("name" in r)))
    expect(b.meta.untrusted_fields.map((f) => f.path)).not.toContain("data.current_lineup[].name");
  return b;
}

describe("E2 on the fixture league: every advertised variant fits (QA-1-001, QA-1-073)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  const STARTERS3 = ["manual.p.00-0036900", "manual.p.00-0039139", "manual.p.00-0037744"];
  const CASES: readonly Record<string, unknown>[] = [
    { week: 4, detail: "full" },
    { week: 4, exclude: ["manual.p.00-0036900"], detail: "full" },
    { week: 4, team_key: TEAM_B, detail: "full" },
    { week: 4, exclude: STARTERS3 },
    { week: 4, exclude: STARTERS3, detail: "full" },
    { week: 3, detail: "full", objective: "blend" },
    { week: 18, detail: "full" },
  ];
  for (const args of CASES)
    it(JSON.stringify(args), async () => {
      const { client, close } = await connect(world);
      const r = await client.callTool({ name: "ff_analyze_lineup", arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      expectFits(text, r.isError, String(args.detail), JSON.stringify(args));
      expect(world.logLines.join("\n")).not.toMatch(/tool\.over_budget/);
      await close();
    });
});

describe("E2 on a schema-legal deep roster (60 players, 64-char names — QA-1-080)", () => {
  let world: World;
  let dir: string;
  let mine: string[] = [];
  beforeAll(async () => {
    // the dataset universe: read the published fixture roster_weekly once
    const w0 = await makeWorld();
    const db = new DatabaseSync(path.join(w0.cache, "ds", "nflverse__roster_weekly.sqlite"), {
      readOnly: true,
    });
    const rows = db
      .prepare(
        "select distinct gsis_id, team, position from ds_roster_weekly where season = 2026 and position in ('QB','RB','WR','TE','K') order by gsis_id",
      )
      .all() as { gsis_id: string; team: string; position: string }[];
    db.close();
    w0.cleanup();
    const long = (i: number): string => `Player ${"Q".repeat(50)} ${String(i).padStart(5, "0")}`;
    const entry = (r: (typeof rows)[number], i: number, slot: string): string =>
      `    - { name: "${long(i)}", team: ${r.team}, position: ${r.position}, gsis_id: "${r.gsis_id}", slot: ${slot} }`;
    const by = (pos: string) => rows.filter((r) => r.position === pos);
    const starters: [(typeof rows)[number], string][] = [
      [by("QB")[0]!, "QB"],
      [by("WR")[0]!, "WR"],
      [by("WR")[1]!, "WR"],
      [by("RB")[0]!, "RB"],
      [by("RB")[1]!, "RB"],
      [by("TE")[0]!, "TE"],
      [by("WR")[2]!, "W/R/T"],
      [by("K")[0]!, "K"],
    ];
    const used = new Set(starters.map(([r]) => r.gsis_id));
    const bench = rows.filter((r) => !used.has(r.gsis_id)).slice(0, 60 - 9 - 1);
    const benchUsed = new Set(bench.map((r) => r.gsis_id));
    const opp = rows.filter((r) => !used.has(r.gsis_id) && !benchUsed.has(r.gsis_id));
    mine = starters.map(([r]) => `manual.p.${r.gsis_id}`);
    const lines = [
      ...starters.map(([r, s], i) => entry(r, i, s)),
      "    - { defense: DET, slot: DEF }",
      ...bench.map((r, i) => entry(r, 100 + i, "BN")),
    ];
    expect(lines.length).toBeGreaterThanOrEqual(55);
    const yaml = `version: 1
league: { key: example, name: Example League, season: 2026, num_teams: 12, scoring_type: head, start_week: 1, end_week: 17, lineup_lock: per_game, playoffs: { start_week: 15, num_teams: 6 } }
scoring: { preset: half_ppr }
roster_slots:
  - { name: QB, count: 1 }
  - { name: WR, count: 2 }
  - { name: RB, count: 2 }
  - { name: TE, count: 1 }
  - { name: W/R/T, count: 1 }
  - { name: K, count: 1 }
  - { name: DEF, count: 1 }
  - { name: BN, count: 20 }
  - { name: IR, count: 20 }
my_team:
  id: 1
  name: Team A
  manager: Manager A
  players:
${lines.join("\n")}
other_teams:
  - id: 2
    name: Team B
    manager: Manager B
    players:
${opp.map((r, i) => "  " + entry(r, 500 + i, "BN")).join("\n")}
opponents:
  - { week: 4, team: 2 }
`;
    dir = mkdtempSync(path.join(tmpdir(), "ff-deep-"));
    chmodSync(dir, 0o700);
    const file = path.join(dir, "league.yaml");
    writeFileSync(file, yaml, { mode: 0o600 });
    world = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
  }, 120_000);
  afterAll(() => {
    world.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("compact, full, excluded starters, forced starts and pwin all fit with every swap", async () => {
    const { client, close } = await connect(world);
    const cases: Record<string, unknown>[] = [
      { week: 4 },
      { week: 4, detail: "full" },
      { week: 4, exclude: mine.slice(0, 5) },
      { week: 4, exclude: mine.slice(0, 5), detail: "full" },
      { week: 4, objective: "pwin", detail: "full" },
      { week: 4, team_key: TEAM_B, detail: "full" },
      { week: 3, detail: "full" },
    ];
    for (const args of cases) {
      const r = await client.callTool({ name: "ff_analyze_lineup", arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      const label = JSON.stringify(args);
      const b = expectFits(text, r.isError, String(args.detail), label);
      // cut, and said so
      expect(b.truncated, label).toBe(true);
      expect(b.warnings.join(" "), label).toMatch(/recommended_lineup/);
    }
    expect(world.logLines.join("\n")).not.toMatch(/tool\.over_budget|tool\.output_invalid/);
    await close();
  }, 60_000);
});

describe("the analytics truncation hint names detail compact only to a full call (QA-1-001)", () => {
  for (const { tool } of REGISTRY.filter((e) => e.tool.budget === "analytics"))
    it(tool.name, () => {
      expect(truncationHint(tool, {})).not.toMatch(/detail compact/);
      expect(truncationHint(tool, { detail: "compact" })).not.toMatch(/detail compact/);
      if (tool.hint === undefined)
        expect(truncationHint(tool, { detail: "full" })).toMatch(/detail compact/);
    });
});
