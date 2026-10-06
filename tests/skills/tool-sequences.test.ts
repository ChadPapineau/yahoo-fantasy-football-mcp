// tool-sequences.test.ts — scripts/skills/tool-sequences.mjs (plan 09 §5.1 item 7): the loader the
// fixture dry run uses refuses an invalid sequence, and the resolver turns `$ref` / `$source_calls`
// templates into concrete arguments — or fails loudly, never silently passing `undefined` to a tool.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import { checkSkills } from "../../scripts/skills/check-skills.mjs";
import {
  loadToolSequences,
  outcomeAllowed,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import { SKILLS, tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe("loadToolSequences", () => {
  it("loads the committed sequences for all four Skills, each starting at Step 0", () => {
    const all = loadToolSequences();
    expect(all.map((s) => s.skill)).toEqual([...SKILLS]);
    for (const s of all) {
      expect(s.fixture.league_key).toBe("manual.l.example");
      for (const q of s.sequences) {
        expect(q.steps[0]?.tool).toBe("ff_get_status");
        expect(q.when.length).toBeGreaterThan(0);
      }
    }
    const ss = all.find((s) => s.skill === "start-sit");
    expect(ss?.sequences.map((q) => [q.id, q.fixture_variant])).toEqual([
      ["pre_game", null],
      ["game_day", "two-slots-locked"],
    ]);
  });

  it("throws, listing every problem, when any sequence is invalid or missing", () => {
    repo = tempRepo();
    const t = repo;
    t.edit("skills/retro/evals/tool_sequence.json", '"ff_analyze_retrospective"', '"ff_nope"');
    t.write("skills/onboard/evals/tool_sequence.json", "{");
    expect(() => loadToolSequences(t.root)).toThrow(/ff_nope is not a Phase-1a tool/);
    expect(() => loadToolSequences(t.root)).toThrow(
      /onboard\/evals\/tool_sequence\.json: invalid JSON/,
    );
    rmSync(t.p("skills/onboard/evals/tool_sequence.json"));
    expect(() => loadToolSequences(t.root)).toThrow(/onboard\/evals\/tool_sequence\.json: missing/);
  });
});

describe("resolveArgs", () => {
  const results = new Map<string, { tool: string; result: unknown }>([
    [
      "lineup",
      {
        tool: "ff_analyze_lineup",
        result: {
          data: { rec: { action: "start A", lineup: [{ slot: "WR" }] } },
          meta: { request_id: "r-000000000001", as_of: "2026-09-30T12:00:00Z" },
        },
      },
    ],
    ["roster", { tool: "ff_get_roster", result: { meta: { request_id: "r-000000000002" } } }],
  ]);

  it("resolves $ref paths (including array indexes) and $source_calls, deep-copying values", () => {
    const out = resolveArgs(
      {
        kind: "lineup",
        week: 4,
        rec: { $ref: "lineup.data.rec" },
        first_slot: { $ref: "lineup.data.rec.lineup.0.slot" },
        nested: [{ as_of: { $ref: "lineup.meta.as_of" } }],
        source_calls: { $source_calls: ["roster", "lineup"] },
      },
      results,
    ) as Record<string, unknown>;
    expect(out).toEqual({
      kind: "lineup",
      week: 4,
      rec: { action: "start A", lineup: [{ slot: "WR" }] },
      first_slot: "WR",
      nested: [{ as_of: "2026-09-30T12:00:00Z" }],
      source_calls: [
        { tool: "ff_get_roster", request_id: "r-000000000002" },
        { tool: "ff_analyze_lineup", request_id: "r-000000000001" },
      ],
    });
    (out.rec as { action: string }).action = "mutated";
    const again = resolveArgs({ rec: { $ref: "lineup.data.rec" } }, results) as {
      rec: { action: string };
    };
    expect(again.rec.action).toBe("start A");
  });

  it.each<[string, unknown, RegExp]>([
    ["a step with no result", { a: { $ref: "matchup.data.rec" } }, /step matchup has no result/],
    ["a missing path", { a: { $ref: "lineup.data.nope" } }, /no `nope`/],
    ["a path through a scalar", { a: { $ref: "lineup.meta.as_of.x" } }, /no `x`/],
    ["an out-of-range index", { a: { $ref: "lineup.data.rec.lineup.5" } }, /undefined/],
    ["a non-string $ref", { a: { $ref: 3 } }, /must be a string/],
    ["$source_calls not a list", { a: { $source_calls: "roster" } }, /must be an array/],
    ["$source_calls to a missing step", { a: { $source_calls: ["x"] } }, /step x has no result/],
    [
      "$source_calls to a result without request_id",
      { a: { $source_calls: ["lineup", "bad"] } },
      /no `request_id`|no `meta`/,
    ],
  ])("fails on %s", (_l, template, re) => {
    const r = new Map(results);
    r.set("bad", { tool: "ff_get_status", result: { meta: {} } });
    expect(() => resolveArgs(template, r)).toThrow(re);
  });

  it("builds the log contract's alternatives and the keys they bring in (QA-2-041)", () => {
    const r = new Map(results);
    r.set("rank", {
      tool: "ff_analyze_waivers",
      result: {
        data: {
          rec: {
            subjects: [
              {
                player_key: "manual.p.def-det",
                gsis_id: null,
                nfl_team: "DET",
                role: "start",
                slot: null,
              },
            ],
          },
          candidates: [
            { player_key: "manual.p.def-min", gsis_id: null, nfl_team: "MIN" },
            { player_key: "manual.p.def-gb", gsis_id: null, nfl_team: "GB" },
          ],
        },
      },
    });
    const dist = {
      mean: 9.7,
      p10: 3,
      p25: 6,
      p50: 9,
      p75: 13,
      p90: 17,
      p_zero: 0,
      basis: "position_cv",
    };
    r.set("proj", {
      tool: "ff_project_players",
      result: {
        data: {
          projections: ["manual.p.def-min", "manual.p.def-gb"].map((k) => ({
            player_key: k,
            gsis_id: null,
            weeks: [{ week: 4, points: dist }],
          })),
        },
      },
    });
    expect(resolveArgs({ $alternative_keys: "rank" }, r)).toEqual([
      "manual.p.def-min",
      "manual.p.def-gb",
    ]);
    const alts = resolveArgs({ $alternatives: { from: "rank", projections: "proj" } }, r) as {
      subjects: { role: string; nfl_team: string | null }[];
      point_estimate: number;
      distribution: unknown;
      decision_metric_value: number;
    }[];
    expect(alts.map((a) => a.subjects.map((s) => `${s.role}:${String(s.nfl_team)}`))).toEqual([
      ["stream:MIN", "drop:DET"],
      ["stream:GB", "drop:DET"],
    ]);
    for (const a of alts) {
      expect(a.distribution).toEqual(dist);
      expect([a.point_estimate, a.decision_metric_value]).toEqual([9.7, 9.7]);
    }
    expect(() => resolveArgs({ $alternatives: { from: "rank", projections: "x" } }, r)).toThrow(
      /must have results/,
    );
    expect(() => resolveArgs({ $alternative_keys: "x" }, r)).toThrow(/step x has no result/);
    expect(() => resolveArgs({ $alternative_keys: "roster" }, r)).toThrow(/no data/);
  });

  it("does not follow prototype keys", () => {
    expect(() => resolveArgs({ a: { $ref: "lineup.constructor" } }, results)).toThrow(
      /no `constructor`/,
    );
    expect(() => resolveArgs({ a: { $ref: "lineup.__proto__" } }, results)).toThrow(
      /no `__proto__`/,
    );
  });

  it("passes plain values through unchanged", () => {
    expect(resolveArgs([1, "a", null, true, { b: [2] }], results)).toEqual([
      1,
      "a",
      null,
      true,
      { b: [2] },
    ]);
  });
});

describe("outcomeAllowed", () => {
  it("honours the step's expect list", () => {
    expect(outcomeAllowed({ expect: ["ok"] }, "ok")).toBe(true);
    expect(outcomeAllowed({ expect: ["ok"] }, "NOT_FOUND")).toBe(false);
    expect(outcomeAllowed({ expect: ["ok", "NOT_FOUND"] }, "NOT_FOUND")).toBe(true);
  });
});

describe("the output contract prints the distribution basis (plan 10 A7 d)", () => {
  it("fails when the shared template stops naming `basis` / position_cv", () => {
    repo = tempRepo();
    const t = repo;
    const file = "skills/_shared/references/output-template.md";
    t.write(file, t.read(file).replaceAll("`basis`", "spread").replaceAll("position_cv", "cv"));
    // rebuild so only the rule under test fails
    expect(buildSkills({ root: t.root }).errors).toEqual([]);
    const e = checkSkills({ root: t.root, scan: false }).errors.join("\n");
    expect(e).toMatch(/must print the distribution `basis`/);
  });
});
