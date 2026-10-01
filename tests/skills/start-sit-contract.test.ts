// start-sit-contract.test.ts — start-sit's game-day branch against the real server on the fixture
// league. QA-1-065: the lineup change the branch logs must be scored by the retrospective as a
// lineup change (swap regret, decisive). Plan 09 §3.5 has the retro report swap_regret for the
// calls; the retrospective computes it only for kind "lineup", so the kind the Skill logs decides
// whether a game-day swap is ever judged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";
import { T0, dataOf, skillWorld } from "./world.js";

type Json = Record<string, unknown>;
interface Step {
  id: string;
  tool: string;
  args: Json;
}
const seqFile = JSON.parse(
  readFileSync(path.join(ROOT, "skills/start-sit/evals/tool_sequence.json"), "utf8"),
) as { sequences: { id: string; steps: Step[] }[] };
const gameDay = seqFile.sequences.find((s) => s.id === "game_day");
const recordStep = gameDay?.steps.find((s) => s.tool === "ff_record_recommendation");

/** Wednesday before week 3 (its first kickoff is Thursday 2026-09-24). */
const BEFORE_WEEK3 = "2026-09-23T12:00:00.000Z";

describe("QA-1-065: start-sit's game-day log entry is scored as a lineup change", () => {
  it("a lineup change logged with the game_day sequence's kind enters swap regret", async () => {
    expect(recordStep, "the game_day sequence records").toBeDefined();
    const args = recordStep?.args ?? {};
    const sw = await skillWorld(BEFORE_WEEK3);
    try {
      const ro = await sw.call("ff_get_roster", { week: 3, force_refresh: true });
      const lu = await sw.call("ff_analyze_lineup", { week: 3, objective: "mean" });
      const raw = dataOf(lu).rec as { subjects: { role: string }[]; confidence: Json } & Json;
      // the fixture world publishes its datasets at T0, after this clock: re-date the rec to the
      // clock, as the dry run's A9 chain does, so E12 does not reject it as "in the future"
      const rec = {
        ...raw,
        as_of: BEFORE_WEEK3,
        confidence: {
          ...raw.confidence,
          inputs: (raw.confidence.inputs as Json[]).map((i) => ({ ...i, as_of: BEFORE_WEEK3 })),
        },
      };
      // a real swap: the rec benches somebody (the case the retro must judge)
      expect(rec.subjects.some((s) => s.role === "sit")).toBe(true);
      const logged = await sw.call("ff_record_recommendation", {
        kind: args.kind,
        week: 3,
        rec,
        alternatives: [],
        source_calls: [
          { tool: "ff_get_roster", request_id: (ro.body.meta as Json).request_id },
          { tool: "ff_analyze_lineup", request_id: (lu.body.meta as Json).request_id },
        ],
        followed_hint: "unknown",
        client_ref: String(args.client_ref),
      });
      expect(logged.ok, JSON.stringify(logged.body).slice(0, 300)).toBe(true);
      sw.world.clock.set(T0);
      const rt = dataOf(await sw.call("ff_analyze_retrospective", { week: 3, allow_stale: true }));
      const swap = (rt.metrics as { swap_regret: { n_swaps: number } }).swap_regret;
      expect(swap.n_swaps).toBeGreaterThan(0);
    } finally {
      await sw.close();
    }
  }, 60_000);
});
