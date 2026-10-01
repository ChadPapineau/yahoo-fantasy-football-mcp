// start-sit-contract.test.ts — start-sit's game-day branch against the real server on the fixture
// league. QA-1-065: the lineup change the branch logs must be scored by the retrospective as a
// lineup change (swap regret, decisive). Plan 09 §3.5 has the retro report swap_regret for the
// calls; the retrospective computes it only for kind "lineup", so the kind the Skill logs decides
// whether a game-day swap is ever judged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArgs } from "../../scripts/skills/tool-sequences.mjs";
import { ROOT } from "./helpers.js";
import { T0, codeSpans, dataOf, keysDeep, skillWorld } from "./world.js";

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
    // a decisive change, not a coin flip: a starter ruled out (status O) must be benched. The plain
    // fixture's week-3 swap (Chase out, Walker in) has a Δ interval straddling 0, which QA-1-060
    // rightly reports as "keep the current lineup" — a no-move would never reach swap regret
    const sw = await skillWorld(BEFORE_WEEK3, [
      [
        `{ name: Ja'Marr Chase, team: CIN, position: WR, gsis_id: "00-0036900", slot: WR }`,
        `{ name: Ja'Marr Chase, team: CIN, position: WR, gsis_id: "00-0036900", slot: WR, status: O }`,
      ],
    ]);
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
      // a real swap: the rec benches somebody (the case the retro must judge) — and it is a move
      expect(rec.no_move).toBe(false);
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

/** Sunday of week 4 after the 13:00 ET kickoffs, before the late games (the dry run's game-day clock). */
const SUNDAY_WEEK4 = "2026-10-04T18:00:00.000Z";

const skillMd = readFileSync(path.join(ROOT, "skills/start-sit/SKILL.md"), "utf8");
/** The game-day branch's output step (§4, the step that starts "Output:"). */
const gameDayOutput = (() => {
  const branch = skillMd.slice(skillMd.indexOf("### 4. Game-day branch"));
  const end = branch.indexOf("\n### ", 5);
  const lines = (end === -1 ? branch : branch.slice(0, end)).split("\n");
  return lines.filter((l) => /^\d+\.\s+Output:/.test(l)).join("\n");
})();
/** A code span that names a result field (`a`, `a[]`, `a.b`), as opposed to a value or a call. */
const FIELD = /^[a-z_][a-z0-9_]*(?:\[\])?(?:\.[a-z_][a-z0-9_]*(?:\[\])?)*$/;

describe("QA-1-071: start-sit's game-day branch reads what its calls return, for the players still open", () => {
  it("the game_day sequence projects only players whose games have not started", async () => {
    const step = gameDay?.steps.find((s) => s.tool === "ff_project_players");
    const keys = (step?.args.players as { player_keys?: string[] } | undefined)?.player_keys ?? [];
    expect(keys.length).toBeGreaterThan(0);
    const sw = await skillWorld(SUNDAY_WEEK4);
    try {
      const ro = dataOf(await sw.call("ff_get_roster", { week: 4, force_refresh: true })) as {
        players: { player_key: string; is_editable: boolean; lock_at: string | null }[];
      };
      // the variant really is mid-slate (control)
      expect(ro.players.some((p) => !p.is_editable)).toBe(true);
      const started = keys.filter((k) => {
        const p = ro.players.find((x) => x.player_key === k);
        return (
          p === undefined ||
          !p.is_editable ||
          Date.parse(p.lock_at ?? "") <= Date.parse(SUNDAY_WEEK4)
        );
      });
      expect(started).toEqual([]);
    } finally {
      await sw.close();
    }
  }, 60_000);

  it("every field the game-day output names is in what the branch's calls return without an opponent", async () => {
    expect(gameDayOutput, "the game-day branch has an Output step").not.toBe("");
    const fields = codeSpans(gameDayOutput).filter((c) => FIELD.test(c) && !c.startsWith("ff_"));
    expect(fields.length).toBeGreaterThan(0);
    const sw = await skillWorld(SUNDAY_WEEK4);
    const results = new Map<string, { tool: string; result: unknown }>();
    let matchupCode: string | null = null;
    try {
      for (const step of gameDay?.steps ?? []) {
        if (step.tool === "ff_record_recommendation") continue;
        const c = await sw.call(step.tool, resolveArgs(step.args, results) as Json);
        if (step.tool === "ff_analyze_matchup") matchupCode = c.code;
        if (c.ok) results.set(step.id, { tool: step.tool, result: c.body });
      }
    } finally {
      await sw.close();
    }
    // the common manual-league case: no opponent this week, so no matchup result (control)
    expect(matchupCode).toBe("NOT_FOUND");
    const keys = new Set<string>();
    for (const r of results.values()) keysDeep(r.result, keys);
    const missing = fields.filter((f) =>
      f.split(".").some((seg) => !keys.has(seg.replace(/\[\]$/, ""))),
    );
    expect(missing).toEqual([]);
  }, 60_000);
});
