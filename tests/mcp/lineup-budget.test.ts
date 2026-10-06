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
import { truncationHint, type ToolContext } from "../../src/mcp/define.js";
import { ANALYTICS_BUDGET_CHARS, REC_LIMITS } from "../../src/mcp/envelope.js";
import { FfError } from "../../src/mcp/errors.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { LINEUP_TOO_DEEP_HINT, refuseTooDeep } from "../../src/mcp/tools/analytics.js";
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
  // the swaps are the advice: rec.action counts exactly what is shown — the swaps made, the coin
  // flips held and the changes that gain nothing (QA-1-020/040 reopened: the no-move rule is applied
  // change by change; a change worth exactly 0 is never counted as a coin flip — QA-2-038)
  const m = /make (\d+) lineup change/.exec(b.data.rec.action);
  const held = /hold (\d+) coin flip/.exec(b.data.rec.action);
  const skip = /skip (\d+) changes? that gains? nothing/.exec(b.data.rec.action);
  if (m !== null)
    expect(b.data.swaps.length, `${label}: ${b.data.rec.action}`).toBe(
      Number(m[1]) + Number(held?.[1] ?? 0) + Number(skip?.[1] ?? 0),
    );
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

describe("E2 on a lineup deeper than one result can hold (QA-1-080, interim)", () => {
  // 16 starting seats (QB 2, WR 4, RB 3, TE 2, W/R/T 2, Q/W/R/T, K, DEF) and 20 on the bench, each
  // name 63 characters: past the 10 000-char budget after every trim the contract allows. Until
  // E2's truncation contract for deep lineups is decided (deferred), the call is refused with
  // VALIDATION, a reason and a hint that says so — never INTERNAL with nothing to act on.
  let world: World;
  let dir: string;
  beforeAll(async () => {
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
    const seats: [string, number, readonly string[]][] = [
      ["QB", 2, ["QB"]],
      ["WR", 4, ["WR"]],
      ["RB", 3, ["RB"]],
      ["TE", 2, ["TE"]],
      ["W/R/T", 2, ["WR", "RB", "TE"]],
      ["Q/W/R/T", 1, ["QB", "WR", "RB", "TE"]],
      ["K", 1, ["K"]],
    ];
    const used = new Set<string>();
    const starters: string[] = [];
    for (const [slot, n, pos] of seats)
      for (let i = 0; i < n; i++) {
        const r = rows.find((x) => pos.includes(x.position) && !used.has(x.gsis_id));
        if (r === undefined) throw new Error(`no ${slot} in the fixture data`);
        used.add(r.gsis_id);
        starters.push(entry(r, starters.length, slot));
      }
    const bench = rows.filter((r) => !used.has(r.gsis_id)).slice(0, 20);
    for (const r of bench) used.add(r.gsis_id);
    const opp = rows.filter((r) => !used.has(r.gsis_id)).slice(0, 30);
    const yaml = `version: 1
league: { key: example, name: Example League, season: 2026, num_teams: 12, scoring_type: head, start_week: 1, end_week: 17, lineup_lock: per_game, playoffs: { start_week: 15, num_teams: 6 } }
scoring: { preset: half_ppr }
roster_slots:
${seats.map(([s, n]) => `  - { name: ${s}, count: ${String(n)} }`).join("\n")}
  - { name: DEF, count: 1 }
  - { name: BN, count: 20 }
  - { name: IR, count: 3 }
my_team:
  id: 1
  name: Team A
  manager: Manager A
  players:
${[...starters, "    - { defense: DET, slot: DEF }", ...bench.map((r, i) => entry(r, 100 + i, "BN"))].join("\n")}
other_teams:
  - id: 2
    name: Team B
    manager: Manager B
    players:
${opp.map((r, i) => "  " + entry(r, 500 + i, "BN")).join("\n")}
opponents:
  - { week: 4, team: 2 }
`;
    dir = mkdtempSync(path.join(tmpdir(), "ff-deeper-"));
    chmodSync(dir, 0o700);
    const file = path.join(dir, "league.yaml");
    writeFileSync(file, yaml, { mode: 0o600 });
    world = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
  }, 120_000);
  afterAll(() => {
    world.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("compact, full and pwin calls get a coded refusal with a hint, or a result that fits", async () => {
    const { client, close } = await connect(world);
    let refused = 0;
    for (const args of [
      { week: 4 },
      { week: 4, detail: "full" },
      { week: 4, objective: "pwin", detail: "full" },
      { week: 3, detail: "full" },
    ] as const) {
      const r = await client.callTool({ name: "ff_analyze_lineup", arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      const label = JSON.stringify(args);
      if (r.isError !== true) {
        expect(text.length, label).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
        continue;
      }
      refused++;
      const e = (JSON.parse(text) as { error: { code: string; reason?: string; hint: string } })
        .error;
      expect(e.code, label).toBe("VALIDATION");
      expect(e.reason, label).toBe("lineup_too_deep");
      expect(e.hint, label).toBe(LINEUP_TOO_DEEP_HINT);
    }
    // the QA-1-080 reproduction itself (week 4) is past the budget: refused, not INTERNAL
    expect(refused).toBeGreaterThan(0);
    expect(world.logLines.join("\n")).not.toMatch(/tool\.over_budget|tool\.output_invalid/);
    await close();
  }, 60_000);

  it("the hint is a fixed, printable server hint that says what to use meanwhile", () => {
    expect(LINEUP_TOO_DEEP_HINT).toMatch(/^[\x20-\x7e]{1,300}$/);
    expect(LINEUP_TOO_DEEP_HINT).toMatch(/ff_project_players/);
  });
});

describe("a rec past REC_LIMITS is refused the same way, whatever its size (QA-1-080, interim)", () => {
  // e.g. 11 starting seats with 10 swaps: 21 subjects (the retrospective pairs the k-th start with the
  // k-th sit, so none may be dropped) — the output schema would reject it and the call went INTERNAL
  const ctx = { requestId: "r-0123456789ab", nowMs: Date.parse("2026-09-30T18:00:00Z") };
  const subject = (i: number) => ({
    player_key: `manual.p.00-${String(1000000 + i)}`,
    gsis_id: null,
    nfl_team: null,
    role: "start",
    slot: "WR",
  });
  const result = (over: Partial<Record<keyof typeof REC_LIMITS, number>>) =>
    ({
      data: {
        swaps: [],
        rec: {
          subjects: Array.from({ length: over.subjects ?? 0 }, (_, i) => subject(i)),
          drivers: Array.from({ length: over.drivers ?? 0 }, (_, i) => ({
            name: `swap:WR:${String(i)}`,
            contribution: 1,
          })),
          assumptions: Array.from({ length: over.assumptions ?? 0 }, () => ({
            text: "a",
            revisit_trigger: "b",
          })),
          lineup: Array.from({ length: over.lineup ?? 0 }, (_, i) => ({
            slot: "WR",
            player_key: subject(i).player_key,
          })),
        },
      },
      inputs: [],
      warnings: [],
      bareFields: [],
      trims: [],
    }) as unknown as Parameters<typeof refuseTooDeep>[2];
  const refusal = (r: Parameters<typeof refuseTooDeep>[2]): unknown => {
    try {
      refuseTooDeep(ctx as unknown as ToolContext, undefined, r);
      return null;
    } catch (e) {
      return e;
    }
  };

  for (const key of ["subjects", "drivers", "assumptions", "lineup"] as const)
    it(`${key}: at the limit it passes; one past it is VALIDATION lineup_too_deep`, () => {
      expect(refusal(result({ [key]: REC_LIMITS[key] }))).toBeNull();
      const e = refusal(result({ [key]: REC_LIMITS[key] + 1 }));
      expect(e).toBeInstanceOf(FfError);
      expect(e).toMatchObject({
        code: "VALIDATION",
        details: { reason: "lineup_too_deep", hint: LINEUP_TOO_DEEP_HINT },
      });
    });
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
