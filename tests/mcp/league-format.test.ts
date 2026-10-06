// league-format.test.ts — QA-2-043 through the tools: a league whose scoring_type has no
// head-to-head matchups (`point`, `roto`) gets no win probability even when league.yaml lists an
// opponent for the week. ff_analyze_lineup forces objective mean and says why (plan 07 E2: "points
// leagues force objective: mean"); ff_analyze_matchup refuses with a hint naming the reason. A
// head-to-head league (`head`, `headpoint`) with the same file keeps both.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATCHUP_NOT_HEAD_TO_HEAD_HINT, isHeadToHead } from "../../src/mcp/tools/analytics.js";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

interface E2 {
  data: {
    objective_used: string;
    p_win_before: number | null;
    p_win_after: number | null;
    mode: string;
    rec: { decision_metric: string; assumptions: { text: string }[] };
  };
}

/** The fixture league as `scoringType`, with Team B as the week-4 opponent. */
function variant(src: string, scoringType: string): string {
  const out = src
    .replace(/^ {2}scoring_type: head$/m, `  scoring_type: ${scoringType}`)
    .replace("  - { week: 3, team: 2 }\n", "  - { week: 3, team: 2 }\n  - { week: 4, team: 2 }\n");
  if (!out.includes(`scoring_type: ${scoringType}`) || !out.includes("{ week: 4, team: 2 }"))
    throw new Error("fixture anchors moved");
  return out;
}

describe("league format decides whether P(win) exists (QA-2-043)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-format-"));
  chmodSync(dir, 0o700);
  // [scoring_type, plays head-to-head] — the oracle is this table, never the code under test
  const TYPES = [
    ["point", false],
    ["roto", false],
    ["head", true],
    ["headpoint", true],
  ] as const;
  const worlds = new Map<string, World>();
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    for (const [t] of TYPES) {
      const file = path.join(dir, `league-${t}.yaml`);
      writeFileSync(file, variant(src, t), { mode: 0o600 });
      worlds.set(t, await makeWorld({ env: { FF_LEAGUE_FILE: file } }));
    }
  }, 180_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [t, h2h] of TYPES)
    it(`scoring_type ${t}`, async () => {
      const world = worlds.get(t);
      if (world === undefined) throw new Error("no world");
      const { client, close } = await connect(world);
      try {
        for (const objective of ["pwin", "blend", "mean"]) {
          const r = await client.callTool({
            name: "ff_analyze_lineup",
            arguments: { week: 4, objective },
          });
          expect(r.isError, `${t} ${objective}`).not.toBe(true);
          const d = (body(r) as unknown as E2).data;
          if (h2h) {
            expect(d.objective_used).toBe(objective);
            expect(d.p_win_before).not.toBeNull();
          } else {
            expect(d.objective_used).toBe("mean");
            expect(d.rec.decision_metric).toBe("expected_points");
            expect([d.p_win_before, d.p_win_after, d.mode]).toEqual([null, null, "neutral"]);
            expect(d.rec.assumptions.some((a) => a.text.startsWith("a points-only league"))).toBe(
              true,
            );
          }
        }
        const m = await client.callTool({ name: "ff_analyze_matchup", arguments: { week: 4 } });
        if (h2h) {
          expect(m.isError).not.toBe(true);
        } else {
          expect(m.isError).toBe(true);
          expect((body(m) as { error: unknown }).error).toMatchObject({
            code: "NOT_FOUND",
            hint: MATCHUP_NOT_HEAD_TO_HEAD_HINT,
          });
        }
      } finally {
        await close();
      }
    });

  it("isHeadToHead: the head-to-head scoring types, and nothing else", () => {
    for (const t of ["head", "headpoint", "headone"]) expect(isHeadToHead(t)).toBe(true);
    for (const t of ["point", "roto", "", "points", "Head"]) expect(isHeadToHead(t)).toBe(false);
  });
});
